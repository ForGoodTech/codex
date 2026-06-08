#!/usr/bin/env node
/**
 * Codex app server TCP proxy (ext/docker/pi/app-server-proxy.js)
 *
 * What this does
 * --------------
 * - Spawns `codex-app-server` inside the container and keeps it running.
 * - Exposes its stdin/stdout over a single TCP connection using raw JSONL (newline-delimited JSON),
 *   mirroring the host FIFO setup but through a socket that can be port-forwarded to the host.
 * - Keeps the app server alive even if the client disconnects so you can reconnect without
 *   restarting the server.
 *
 * Intended flow
 * -------------
 * - Run this proxy inside the container where `codex-app-server` is available on PATH (the image
 *   symlinks both codex-app-server and this proxy into npm-global/bin).
 * - Attach the container to the shared Docker network so other containers can reach the proxy:
 *     docker network create codex-net
 *     docker run -it --rm --name codex-proxy --network codex-net my-codex-docker-image /bin/bash
 * - Start the proxy inside the container (either path works):
 *     codex-app-server-proxy
 *   or
 *     node ~/app-server-proxy.js
 * - From another container on codex-net, connect to codex-proxy:9395 (override with
 *   APP_SERVER_TCP_HOST/PORT if needed).
 *
 * Protocol
 * --------
 * - Single-client TCP bridge; additional connection attempts are rejected until the active client
 *   disconnects.
 * - Data is forwarded as JSONL between the client socket and the app server stdin/stdout.
 * - The client should speak the same JSONL protocol the app server expects (see hello-app-server.js).
 */
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tokenFingerprint(value) {
  const token = (value ?? '').toString().trim();
  if (!token) {
    return 'empty';
  }
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

const envProxyToken = process.env.APP_SERVER_PROXY_TOKEN?.trim() ?? '';
if (!envProxyToken) {
  console.warn(
    'APP_SERVER_PROXY_TOKEN is empty; proxy handshake token is empty. ' +
      'Gateway must send an empty token to authenticate.',
  );
} else {
  console.log('Using APP_SERVER_PROXY_TOKEN from environment for proxy auth handshake.');
}
const proxyToken = envProxyToken;
console.log('TEMP: proxy expected token fingerprint', {
  expectedTokenLength: proxyToken.length,
  expectedTokenSha256_12: tokenFingerprint(proxyToken),
  at: new Date().toISOString(),
});
const appSurfaceFrameMethod = 'app.surface.frame';
const appSurfaceIpcSocketPath =
  process.env.APP_SERVER_APP_SURFACE_IPC_SOCKET?.trim() ||
  path.join(os.tmpdir(), 'codex-app-surface.sock');
const appSurfaceIpcEnabled =
  process.env.CODEX_APP_SURFACE_CONTAINER === '1' ||
  process.env.APP_SERVER_APP_SURFACE_IPC_ENABLED === '1';
const maxAppSurfaceIpcBytes = (() => {
  const parsed = Number.parseInt(process.env.APP_SERVER_APP_SURFACE_IPC_MAX_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8 * 1024 * 1024;
})();
const host = process.env.APP_SERVER_HOST ?? '0.0.0.0';
const defaultPort = 9395;
const authTimeoutMs = 3000;
const maxHandshakeBytes = 8 * 1024;
const port = (() => {
  const raw = process.env.APP_SERVER_PORT;
  if (!raw) {
    return defaultPort;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`Ignoring invalid APP_SERVER_PORT value (${raw}); using ${defaultPort}.`);
    return defaultPort;
  }
  return parsed;
})();
const defaultAppServerCmd = 'codex-app-server';
const appServerCmd = process.env.APP_SERVER_CMD?.trim() || defaultAppServerCmd;
const appServerArgs = process.env.APP_SERVER_ARGS?.split(' ').filter((arg) => arg.length > 0) ?? [];
const defaultSandboxExe = '/usr/local/share/npm-global/bin/codex-linux-sandbox';
const sandboxExe =
  process.env.APP_SERVER_CODEX_LINUX_SANDBOX_EXE?.trim() ||
  process.env.CODEX_LINUX_SANDBOX_EXE?.trim() ||
  defaultSandboxExe;
const githubPat = process.env.CODEX_GITHUB_PERSONAL_ACCESS_TOKEN?.trim() ?? '';
let gitAskPassPath = null;

function createGitAskPassScript() {
  if (!githubPat) {
    return null;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-git-askpass-'));
  const scriptPath = path.join(tmpDir, 'askpass.sh');
  // Script contains no secrets; token is read from env at runtime.
  const script = `#!/bin/sh
prompt="$1"
case "$prompt" in
  *"Username for 'https://github.com"*|*"Username for 'https://api.github.com"*)
    printf '%s\\n' "x-access-token"
    ;;
  *"Password for 'https://"*"@github.com"*|*"Password for 'https://"*"@api.github.com"*)
    token="\${CODEX_GITHUB_PERSONAL_ACCESS_TOKEN:-}"
    printf '%s\\n' "$token"
    ;;
  *)
    printf '\\n'
    ;;
esac
`;
  fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o700 });
  return scriptPath;
}

function buildGitEnv(baseEnv, askPassPath) {
  if (!askPassPath) {
    return baseEnv;
  }

  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: askPassPath,
  };
}

function cleanupGitAskPass() {
  if (!gitAskPassPath) {
    return;
  }
  try {
    fs.rmSync(path.dirname(gitAskPassPath), { recursive: true, force: true });
  } catch (error) {
    console.warn('Failed to remove temporary git askpass script:', error?.message ?? error);
  }
  gitAskPassPath = null;
}

gitAskPassPath = createGitAskPassScript();
if (gitAskPassPath) {
  console.log('GitHub PAT bridge is enabled for git HTTPS prompts targeting github.com.');
} else {
  console.log('GitHub PAT bridge is disabled (CODEX_GITHUB_PERSONAL_ACCESS_TOKEN is unset).');
}

const appServerEnv = {
  ...buildGitEnv(process.env, gitAskPassPath),
  CODEX_LINUX_SANDBOX_EXE: sandboxExe,
};
console.log(`Starting ${appServerCmd} ${appServerArgs.join(' ')} ...`);
const appServer = spawn(appServerCmd, appServerArgs, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: appServerEnv,
});
appServer.on('exit', (code, signal) => {
  console.error(`codex-app-server exited (code=${code}, signal=${signal ?? 'none'})`);
  process.exit(code === null ? 1 : code);
});
appServer.on('error', (error) => {
  console.error('Failed to start codex-app-server:', error);
  process.exitCode = 1;
});
appServer.on('close', () => {
  cleanupGitAskPass();
});

let activeSocket = null;
let activeSocketAuthenticated = false;
let appSurfaceIpcServer = null;

function normalizeAppSurfaceMethod(value) {
  let method = (value ?? '').toString().trim().toLowerCase();
  method = method.replace(/[/_]+/g, '.');
  while (method.includes('..')) {
    method = method.replace(/\.\.+/g, '.');
  }
  return method.replace(/^\.+|\.+$/g, '');
}

function isAppSurfaceMethod(value) {
  const method = normalizeAppSurfaceMethod(value);
  return method === appSurfaceFrameMethod || method.startsWith('app.surface.');
}

function appSurfaceNotificationFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('app-surface payload must be a JSON object');
  }

  const explicitMethod = typeof payload.method === 'string' ? payload.method : '';
  const payloadType = typeof payload.type === 'string' ? payload.type : '';
  let method = explicitMethod || (isAppSurfaceMethod(payloadType) ? payloadType : appSurfaceFrameMethod);
  method = normalizeAppSurfaceMethod(method);
  if (!isAppSurfaceMethod(method)) {
    throw new Error(`app-surface method is not allowed: ${method || '<empty>'}`);
  }

  let params;
  if (Object.prototype.hasOwnProperty.call(payload, 'params')) {
    params = payload.params;
  } else if (Object.prototype.hasOwnProperty.call(payload, 'frame')) {
    params = payload.frame;
  } else if (Object.prototype.hasOwnProperty.call(payload, 'data')) {
    params = payload.data;
  } else {
    params = payload;
  }

  if (params === undefined || params === null) {
    params = {};
  }
  return { method, params };
}

function sendAppSurfaceNotification(method, params) {
  if (!activeSocket || activeSocket.destroyed || !activeSocketAuthenticated) {
    throw new Error('gateway connection is not authenticated');
  }
  const frame = {
    method: normalizeAppSurfaceMethod(method),
    params,
  };
  activeSocket.write(`${JSON.stringify(frame)}\n`);
}

function cleanupAppSurfaceIpc() {
  if (appSurfaceIpcServer) {
    try {
      appSurfaceIpcServer.close();
    } catch {
      // best-effort shutdown during process exit
    }
    appSurfaceIpcServer = null;
  }
  if (appSurfaceIpcEnabled) {
    try {
      fs.rmSync(appSurfaceIpcSocketPath, { force: true });
    } catch (error) {
      console.warn('Failed to remove app-surface IPC socket:', error?.message ?? error);
    }
  }
}

function cleanupRuntime() {
  cleanupGitAskPass();
  cleanupAppSurfaceIpc();
}

function startAppSurfaceIpcServer() {
  if (!appSurfaceIpcEnabled) {
    return;
  }

  try {
    fs.rmSync(appSurfaceIpcSocketPath, { force: true });
  } catch (error) {
    console.warn('Failed to remove stale app-surface IPC socket:', error?.message ?? error);
  }

  appSurfaceIpcServer = net.createServer((socket) => {
    let body = '';
    let rejected = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (rejected) {
        return;
      }
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxAppSurfaceIpcBytes) {
        rejected = true;
        socket.end(`${JSON.stringify({ ok: false, error: 'app-surface IPC payload is too large' })}\n`);
        socket.destroy();
      }
    });
    socket.on('end', () => {
      if (rejected) {
        return;
      }
      try {
        const payload = JSON.parse(body.trim());
        const notification = appSurfaceNotificationFromPayload(payload);
        sendAppSurfaceNotification(notification.method, notification.params);
        socket.end(`${JSON.stringify({ ok: true })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error?.message ?? String(error) })}\n`);
      }
    });
  });

  appSurfaceIpcServer.on('error', (error) => {
    console.error('App-surface IPC server error:', error?.message ?? error);
  });
  appSurfaceIpcServer.listen(appSurfaceIpcSocketPath, () => {
    try {
      fs.chmodSync(appSurfaceIpcSocketPath, 0o600);
    } catch (error) {
      console.warn('Failed to chmod app-surface IPC socket:', error?.message ?? error);
    }
    console.log(`App-surface IPC listening on ${appSurfaceIpcSocketPath}`);
  });
}

process.on('exit', cleanupRuntime);

const server = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  const connectedAtMs = Date.now();
  console.log('TEMP: proxy socket accepted', {
    remote,
    activeSocketPresent: !!activeSocket,
    at: new Date().toISOString(),
  });
  if (activeSocket) {
    console.log('TEMP: proxy rejected additional client', {
      remote,
      activeRemote: `${activeSocket.remoteAddress}:${activeSocket.remotePort}`,
      at: new Date().toISOString(),
    });
    socket.destroy();
    return;
  }
  console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
  activeSocket = socket;
  activeSocketAuthenticated = false;
  let isAuthenticated = false;
  let authBuffer = Buffer.alloc(0);
  let frameLineBuffer = '';
  let lastAuthMaterialLength = null;
  const authTimeout = setTimeout(() => {
    if (isAuthenticated) {
      return;
    }
    socket.destroy(new Error(`Authentication timeout after ${authTimeoutMs}ms.`));
  }, authTimeoutMs);
  const forwardStdout = (chunk) => {
    socket.write(chunk);
  };
  const handleSocketData = (chunk) => {
    if (!isAuthenticated) {
      authBuffer = Buffer.concat([authBuffer, chunk]);
      if (authBuffer.length > maxHandshakeBytes) {
        socket.destroy(new Error('Authentication handshake exceeds maximum size.'));
        return;
      }
      const newlineIndex = authBuffer.indexOf(0x0a);
      if (newlineIndex < 0) {
        return;
      }
      const authLine = authBuffer.subarray(0, newlineIndex).toString('utf8').trim();
      let authFrame;
      try {
        authFrame = JSON.parse(authLine);
      } catch {
        socket.destroy(new Error('Invalid authentication handshake.'));
        return;
      }
      const authMatched = authFrame?.type === 'auth' && authFrame?.token === proxyToken;
      const receivedTokenForLog = typeof authFrame?.token === 'string' ? authFrame.token : '';
      console.log('TEMP: proxy handshake check', {
        remote,
        receivedType: authFrame?.type,
        matched: authMatched,
        receivedTokenLength: receivedTokenForLog.length,
        receivedTokenSha256_12: tokenFingerprint(receivedTokenForLog),
        expectedTokenLength: proxyToken.length,
        expectedTokenSha256_12: tokenFingerprint(proxyToken),
        authBufferBytes: authBuffer.length,
        at: new Date().toISOString(),
      });
      if (!authMatched) {
        console.log('TEMP: proxy handshake failed', {
          remote,
          at: new Date().toISOString(),
        });
        socket.destroy(new Error('Authentication failed.'));
        return;
      }
      console.log('TEMP: proxy handshake passed', {
        remote,
        at: new Date().toISOString(),
      });
      isAuthenticated = true;
      activeSocketAuthenticated = true;
      clearTimeout(authTimeout);
      const remaining = authBuffer.subarray(newlineIndex + 1);
      authBuffer = Buffer.alloc(0);
      if (remaining.length > 0) {
        console.log(`TEMP: proxy forwarding buffered post-auth bytes=${remaining.length}`);
        const writeOk = appServer.stdin.write(remaining);
        if (!writeOk) {
          socket.pause();
        }
      }
      return;
    }
    frameLineBuffer += chunk.toString('utf8');
    const lines = frameLineBuffer.split('\n');
    frameLineBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        appServer.stdin.write('\n');
        continue;
      }
      try {
        const frame = JSON.parse(line);
        const encodedLine = `${JSON.stringify(frame)}\n`;
        if (frame.method === 'turn/start') {
          const prompt = Array.isArray(frame.params?.input)
            ? frame.params.input.find((entry) => entry.type === 'text')?.text
            : undefined;
          console.log('TEMP: proxy received prompt', {
            threadId: frame.params?.threadId,
            prompt,
            authMaterialLengthInUse: lastAuthMaterialLength,
          });
          console.log('TEMP: proxy preparing to forward prompt frame to codex-app-server');
        }
        if (frame.method === 'account/login/start' && frame.params?.type === 'chatgptAuthTokens') {
          const authMaterialLength = [
            frame.params.accessToken,
            frame.params.chatgptAccountId,
            frame.params.chatgptPlanType ?? '',
          ].join('|').length;
          lastAuthMaterialLength = authMaterialLength;
          console.log(`TEMP: proxy auth material length=${authMaterialLength}`);
        }
        const writeOk = appServer.stdin.write(encodedLine);
        if (!writeOk) {
          socket.pause();
        }
      } catch {
        const passthroughLine = `${rawLine}\n`;
        const writeOk = appServer.stdin.write(passthroughLine);
        if (!writeOk) {
          socket.pause();
        }
      }
    }
  };
  const resumeSocket = () => {
    socket.resume();
  };
  const teardown = (reason) => {
    if (activeSocket !== socket) {
      return;
    }
    const reasonText =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'boolean'
          ? `close_had_error=${reason}`
          : 'unknown';
    console.log('TEMP: proxy socket teardown', {
      remote,
      authenticated: isAuthenticated,
      reason: reasonText,
      authBufferBytes: authBuffer.length,
      frameLineBufferBytes: Buffer.byteLength(frameLineBuffer),
      lifetimeMs: Date.now() - connectedAtMs,
      at: new Date().toISOString(),
    });
    appServer.stdout.off('data', forwardStdout);
    appServer.stdin.off('drain', resumeSocket);
    clearTimeout(authTimeout);
    socket.off('data', handleSocketData);
    socket.off('close', teardown);
    socket.off('error', teardown);
    if (!socket.destroyed) {
      if (frameLineBuffer.length > 0) {
        const writeOk = appServer.stdin.write(frameLineBuffer);
        if (!writeOk) {
          socket.pause();
        }
        frameLineBuffer = '';
      }
      socket.end();
    }
    activeSocket = null;
    activeSocketAuthenticated = false;
    console.log('Client disconnected; proxy is idle and ready for the next connection.');
  };
  appServer.stdout.on('data', forwardStdout);
  appServer.stdin.on('drain', resumeSocket);
  socket.on('data', handleSocketData);
  socket.on('close', teardown);
  socket.on('error', teardown);
});
server.listen(port, host, () => {
  console.log(`Proxy listening on ${host}:${port}`);
});
startAppSurfaceIpcServer();

function shutdownProxy(signal, exitCode) {
  console.log('Shutting down proxy...');
  cleanupRuntime();
  server.close(() => {
    process.exit(exitCode);
  });
  appServer.kill(signal);
  setTimeout(() => {
    process.exit(exitCode);
  }, 1000).unref();
}

process.on('SIGINT', () => {
  shutdownProxy('SIGINT', 130);
});
process.on('SIGTERM', () => {
  shutdownProxy('SIGTERM', 143);
});
