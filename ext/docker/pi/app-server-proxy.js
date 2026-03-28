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
 * - Data is forwarded as JSONL between the client socket and the app server stdin/stdout; the proxy
 *   may augment selected request frames (for example, default developer instructions).
 * - The client should speak the same JSONL protocol the app server expects (see hello-app-server.js).
 */
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
const mathJaxDeveloperInstructions = [
  'If your response includes mathematics, format all math in LaTeX for MathJax rendering.',
  'Use \\( ... \\) for inline math and \\[ ... \\] for display math.',
  'Do not output plain-text equations without LaTeX math delimiters.',
].join(' ');
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

function createGitAskPassScript(token) {
  if (!token) {
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

gitAskPassPath = createGitAskPassScript(githubPat);
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

process.on('exit', cleanupGitAskPass);
process.on('SIGINT', () => {
  cleanupGitAskPass();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanupGitAskPass();
  process.exit(143);
});
let activeSocket = null;

function appendDeveloperInstructions(frame) {
  if (!frame || typeof frame !== 'object') {
    return frame;
  }
  const method = frame.method;
  if (method !== 'thread/start' && method !== 'thread/resume') {
    return frame;
  }
  const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
  const existing =
    params.developerInstructions === undefined || params.developerInstructions === null
      ? ''
      : params.developerInstructions.toString().trim();
  const combined = existing
    ? `${existing}\n\n${mathJaxDeveloperInstructions}`
    : mathJaxDeveloperInstructions;
  return {
    ...frame,
    params: {
      ...params,
      developerInstructions: combined,
    },
  };
}

const server = net.createServer((socket) => {
  if (activeSocket) {
    socket.destroy(new Error('Proxy already has an active client; try again later.'));
    return;
  }
  console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
  activeSocket = socket;
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
      console.log('TEMP: proxy handshake check', {
        receivedType: authFrame?.type,
        matched: authMatched,
      });
      if (!authMatched) {
        console.log('TEMP: proxy handshake failed');
        socket.destroy(new Error('Authentication failed.'));
        return;
      }
      console.log('TEMP: proxy handshake passed');
      isAuthenticated = true;
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
        const frame = appendDeveloperInstructions(JSON.parse(line));
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
  const teardown = () => {
    if (!activeSocket) {
      return;
    }
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
process.on('SIGINT', () => {
  console.log('Shutting down proxy...');
  server.close();
  appServer.kill('SIGINT');
});
