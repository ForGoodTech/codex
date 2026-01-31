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
const { spawn } = require('node:child_process');

const host = process.env.APP_SERVER_HOST ?? '0.0.0.0';
const verbose =
  process.argv.includes('--verbose') || process.env.APP_SERVER_PROXY_VERBOSE === '1';
const defaultPort = 9395;
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

console.log(`Starting ${appServerCmd} ${appServerArgs.join(' ')} ...`);
if (verbose) {
  console.log('Proxy verbose logging enabled.');
}
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
let clientBuffer = '';
let serverBuffer = '';
let forwardedClientLines = 0;
let forwardedServerLines = 0;
let forwardedClientBytes = 0;
let forwardedServerBytes = 0;

function logJsonLine(prefix, line) {
  if (!verbose) {
    return;
  }

  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Object.prototype.hasOwnProperty.call(parsed, 'id')) {
      const method = parsed.method ?? 'response';
      const error = parsed.error ? ` error=${JSON.stringify(parsed.error)}` : '';
      console.log(`${prefix} id=${parsed.id} method=${method}${error} raw=${trimmed}`);
      return;
    }

    if (parsed.method) {
      console.log(`${prefix} notify method=${parsed.method} raw=${trimmed}`);
      return;
    }
  } catch (error) {
    console.log(`${prefix} non-JSON line: ${trimmed}`);
    return;
  }

  console.log(`${prefix} ${trimmed}`);
}

function ingestLines(label, buffer, chunk) {
  const text = chunk.toString('utf8');
  if (verbose) {
    console.log(`${label} chunk bytes=${text.length}`);
  }
  const nextBuffer = `${buffer}${text}`;
  const lines = nextBuffer.split('\n');
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    logJsonLine(label, line);
  }
  return remainder;
}

const server = net.createServer((socket) => {
  if (activeSocket) {
    socket.destroy(new Error('Proxy already has an active client; try again later.'));
    return;
  }

  console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
  activeSocket = socket;
  clientBuffer = '';
  serverBuffer = '';
  forwardedClientLines = 0;
  forwardedServerLines = 0;
  forwardedClientBytes = 0;
  forwardedServerBytes = 0;

  const forwardStdout = (chunk) => {
    if (verbose) {
      serverBuffer = ingestLines('server->client', serverBuffer, chunk);
    }
    forwardedServerBytes += chunk.length;
    forwardedServerLines += chunk.toString('utf8').split('\n').length - 1;
    socket.write(chunk);
  };

  const handleSocketData = (chunk) => {
    if (verbose) {
      clientBuffer = ingestLines('client->server', clientBuffer, chunk);
    }
    forwardedClientBytes += chunk.length;
    forwardedClientLines += chunk.toString('utf8').split('\n').length - 1;
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
    if (verbose) {
      console.log(
        `Forwarded client->server: ${forwardedClientLines} lines, ${forwardedClientBytes} bytes.`,
      );
      console.log(
        `Forwarded server->client: ${forwardedServerLines} lines, ${forwardedServerBytes} bytes.`,
      );
    }
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
