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
 * - Publish the proxy port to the host when starting the container, e.g.:
 *     docker run -it --rm -p 9395:9395 my-codex-docker-image /bin/bash
 * - Start the proxy inside the container (either path works):
 *     APP_SERVER_PORT=9395 \  # optional, defaults to 9395
 *     APP_SERVER_CMD=codex-app-server \  # optional, defaults to codex-app-server
 *     codex-app-server-proxy
 *   or
 *     APP_SERVER_PORT=9395 APP_SERVER_CMD=codex-app-server node ~/app-server-proxy.js
 * - On the host, point hello-app-server.js at the published port using APP_SERVER_TCP_HOST/PORT.
 *
 * Protocol
 * --------
 * - Single-client TCP bridge; additional connection attempts are rejected until the active client
 *   disconnects.
 * - Data is forwarded byte-for-byte between the client socket and the app server stdin/stdout; the
 *   client should speak the same JSONL protocol the app server expects (see hello-app-server.js).
 */

const net = require('node:net');
const { spawn } = require('node:child_process');

const host = process.env.APP_SERVER_HOST ?? '0.0.0.0';
const port = Number.parseInt(process.env.APP_SERVER_PORT ?? '9395', 10);
const appServerCmd = process.env.APP_SERVER_CMD ?? 'codex-app-server';
const appServerArgs = process.env.APP_SERVER_ARGS?.split(' ').filter((arg) => arg.length > 0) ?? [];

console.log(`Starting ${appServerCmd} ${appServerArgs.join(' ')} ...`);
const appServer = spawn(appServerCmd, appServerArgs, {
  stdio: ['pipe', 'pipe', 'inherit'],
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

  const forwardStdout = (chunk) => {
    socket.write(chunk);
  };

  const handleSocketData = (chunk) => {
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
