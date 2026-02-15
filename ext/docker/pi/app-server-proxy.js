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
 * - Data is forwarded byte-for-byte between the client socket and the app server stdin/stdout; the
 *   client should speak the same JSONL protocol the app server expects (see hello-app-server.js).
 */

const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const proxyTokenDerivationLabel = 'codex-gateway-proxy-token-v1';
const authJsonPath = process.env.APP_SERVER_PROXY_AUTH_JSON_PATH?.trim() || '/home/node/.codex/auth.json';

const deriveProxyToken = () => {
  let authSeed = '';
  try {
    authSeed = fs.readFileSync(authJsonPath, 'utf8').trim();
  } catch (error) {
    console.error(`Failed to read auth seed from ${authJsonPath}:`, error);
    process.exit(1);
  }

  if (!authSeed) {
    console.error(`Auth seed at ${authJsonPath} is empty; refusing to start proxy.`);
    process.exit(1);
  }

  return crypto.createHmac('sha256', authSeed).update(proxyTokenDerivationLabel).digest('hex');
};

const proxyToken = deriveProxyToken();

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
const appServerEnv = {
  ...process.env,
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

let activeSocket = null;

const server = net.createServer((socket) => {
  if (activeSocket) {
    socket.destroy(new Error('Proxy already has an active client; try again later.'));
    return;
  }

  console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
  activeSocket = socket;
  let isAuthenticated = false;
  let authBuffer = Buffer.alloc(0);
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

      if (authFrame?.type !== 'auth' || authFrame?.token !== proxyToken) {
        socket.destroy(new Error('Authentication failed.'));
        return;
      }

      isAuthenticated = true;
      clearTimeout(authTimeout);
      const remaining = authBuffer.subarray(newlineIndex + 1);
      authBuffer = Buffer.alloc(0);
      if (remaining.length > 0) {
        const writeOk = appServer.stdin.write(remaining);
        if (!writeOk) {
          socket.pause();
        }
      }
      return;
    }

    const writeOk = appServer.stdin.write(chunk);
    if (!writeOk) {
      socket.pause();
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
