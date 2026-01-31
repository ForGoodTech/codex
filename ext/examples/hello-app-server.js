#!/usr/bin/env node
/**
 * Hello App Server (ext/examples/hello-app-server.js)
 *
 * What this shows
 * ---------------
 * - Connects to an already-running Codex app server over JSONL (JSON-RPC 2.0 without the jsonrpc header).
 * - Performs the required initialize/initialized handshake.
 * - Starts a new conversation thread and kicks off one turn with a simple text prompt.
 * - Streams and prints server notifications until the turn completes, then exits.
 *
 * How to run (host app server)
 * ----------------------------
 * 1) In a separate terminal, start the app server and expose its stdio via FIFOs:
 *      mkfifo /tmp/codex-app-server.in /tmp/codex-app-server.out
 *      # Start the server via cargo without changing directories
 *      cargo run --manifest-path codex-rs/Cargo.toml -p codex-app-server < /tmp/codex-app-server.in > /tmp/codex-app-server.out
 * 2) From the repo root, run the client against those pipes (overridable via env vars):
 *      APP_SERVER_IN=/tmp/codex-app-server.in APP_SERVER_OUT=/tmp/codex-app-server.out \\
 *      node ext/examples/hello-app-server.js
 *
 * How to run (server inside Docker container)
 * -------------------------------------------
 * - Start the proxy in a container attached to the shared Docker network:
 *      docker network create codex-net
 *      docker run -it --rm --name codex-proxy --network codex-net my-codex-docker-image /bin/bash
 *      codex-app-server-proxy
 * - From another container on codex-net (for example, the examples image), connect to
 *   codex-proxy:9395 (the defaults below).
 *
 * Environment variables
 * ---------------------
 * - APP_SERVER_TCP_HOST (optional): TCP host for the proxy. Defaults to codex-proxy.
 * - APP_SERVER_TCP_PORT (optional): TCP port for the proxy. Defaults to 9395.
 * - APP_SERVER_IN  (optional): path to the FIFO to write requests to. Defaults to /tmp/codex-app-server.in when set.
 * - APP_SERVER_OUT (optional): path to the FIFO to read server responses/notifications from. Defaults to /tmp/codex-app-server.out when set.
 *
 * Notes
 * -----
 * - TCP proxy mode is the default; set APP_SERVER_IN/APP_SERVER_OUT to use host FIFOs instead.
 * - Host FIFO mode: the script is a pure client and expects the server to be running already.
 * - Container TCP proxy mode: start the proxy separately in the container; this client connects over the
 *   forwarded TCP port and does not manage the server lifecycle.
 * - JSON-RPC responses are matched to the requests issued below; notifications are logged as they arrive.
 * - The example keeps the scope intentionally small so future examples can focus on other flows (auth, approvals, etc.).
 */

const fs = require('node:fs');
const { once } = require('node:events');
const readline = require('node:readline');
const net = require('node:net');

const fifoInPath = process.env.APP_SERVER_IN;
const fifoOutPath = process.env.APP_SERVER_OUT;
const tcpHost = process.env.APP_SERVER_TCP_HOST ?? 'codex-proxy';
const tcpPortEnv = process.env.APP_SERVER_TCP_PORT;
const tcpPort = (() => {
  if (!tcpPortEnv) {
    return 9395;
  }

  const parsed = Number.parseInt(tcpPortEnv, 10);
  return Number.isNaN(parsed) ? 9395 : parsed;
})();

let serverInput;
let serverOutput;
let socket = null;

if (!fifoInPath && !fifoOutPath) {
  console.log(`Connecting to app server proxy at ${tcpHost}:${tcpPort} ...`);
  socket = net.connect({ host: tcpHost, port: tcpPort });
  socket.setKeepAlive(true);
  serverInput = socket;
  serverOutput = socket;

  socket.on('error', (error) => {
    console.error('TCP connection error:', error);
    process.exitCode = 1;
  });
} else {
  const serverInPath = fifoInPath ?? '/tmp/codex-app-server.in';
  const serverOutPath = fifoOutPath ?? '/tmp/codex-app-server.out';
  serverInput = fs.createWriteStream(serverInPath, { flags: 'a' });
  serverOutput = fs.createReadStream(serverOutPath, { encoding: 'utf8' });
}

let nextId = 1;
const pending = new Map();
let watchedTurnId = null;

const rl = readline.createInterface({ input: serverOutput });

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error('Received non-JSON line from app-server:', line);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    const pendingRequest = pending.get(message.id);
    if (pendingRequest) {
      pending.delete(message.id);
      if (message.error) {
        console.warn(
          `Request failed (${pendingRequest.method}, id=${message.id}):`,
          message.error,
        );
      }
      pendingRequest.resolve(message.result ?? message.error);
    } else {
      console.warn('Unmatched response', message);
    }
    return;
  }

  if (message.method) {
    logNotification(message.method, message.params ?? {});
    if (
      message.method === 'turn/completed' &&
      watchedTurnId &&
      message.params?.turn?.id === watchedTurnId
    ) {
      console.log('Turn completed; shutting down.');
      shutdown();
    }
  }
});

function shutdown() {
  rl.close();
  serverInput.end();
  if (socket) {
    socket.end();
  }
}

function logNotification(method, params) {
  switch (method) {
    case 'turn/started':
      console.log(`Turn started: ${params.turn?.id ?? 'unknown'}`);
      break;
    case 'item/agentMessage/delta':
      if (params.delta?.content?.length) {
        console.log(params.delta.content.map((c) => c.text ?? '').join(''));
        break;
      }

      if (typeof params.delta?.text === 'string') {
        console.log(params.delta.text);
        break;
      }

      if (typeof params.delta === 'string') {
        console.log(params.delta);
        break;
      }

      if (params.delta !== undefined) {
        console.log(JSON.stringify(params.delta));
        break;
      }

      console.log('Notification', method, params);
      break;
    case 'turn/completed':
      console.log(`Turn completed with status: ${params.turn?.status}`);
      break;
    default:
      console.log('Notification', method, params);
  }
}

function request(method, params = {}) {
  const id = nextId++;
  const payload = { method, params, id };
  serverInput.write(`${JSON.stringify(payload)}\n`);

  return new Promise((resolve) => {
    pending.set(id, { resolve, method });
  });
}

function notify(method, params = {}) {
  serverInput.write(`${JSON.stringify({ method, params })}\n`);
}

async function main() {
  console.log('Connecting to codex app-server...');

  if (socket) {
    await once(socket, 'connect');
  } else {
    await Promise.all([once(serverInput, 'open'), once(serverOutput, 'open')]);
  }

  const initializeResult = await request('initialize', {
    clientInfo: {
      name: 'ext-example',
      title: 'Hello App Server example',
      version: '0.0.1',
    },
  });

  console.log('Server user agent:', initializeResult?.userAgent);
  notify('initialized');

  const threadResult = await request('thread/start', {});
  const threadId = threadResult?.thread?.id;
  if (!threadId) {
    throw new Error('Server did not return a thread id');
  }
  console.log('Started thread', threadId);

  const turnResult = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Say hello back with one short sentence.' }],
  });

  watchedTurnId = turnResult?.turn?.id;
  console.log('Waiting for turn', watchedTurnId, 'to complete...');
}

main().catch((error) => {
  console.error('Example failed:', error);
  shutdown();
});
