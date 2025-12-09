#!/usr/bin/env node
/**
 * Feature example: reasoning-only prompt/response
 * ------------------------------------------------
 * This client connects to an already-running Codex app server over JSONL (JSON-RPC 2.0 without the jsonrpc header),
 * performs the initialize/initialized handshake, starts a thread, sends a prompt, and prints only the final assistant
 * message. Reasoning-related notifications are fully processed to keep local state consistent but are intentionally
 * hidden from user output.
 *
 * Naming convention for app-server client examples
 * ------------------------------------------------
 * Files are named after the Codex capability they highlight, using the pattern:
 *   <feature>-client.js
 * Examples: reasoning-client.js (this file), tools-client.js, files-client.js.
 * Keeping the feature in the filename makes it easy to scan the examples directory as more capability-focused
 * clients are added.
 *
 * How to run (server inside Docker container)
 * -------------------------------------------
 * - In the container, run the long-lived proxy that bridges the app server stdio to a TCP port (see
 *   ext/docker/pi/app-server-proxy.js for full instructions). Example inside the container:
 *      APP_SERVER_PORT=9395 codex-app-server-proxy
 * - Publish the proxy port to the host when starting the container, e.g.:
 *      docker run -it --rm -p 9395:9395 my-codex-docker-image /bin/bash
 * - From the host, point this client at the forwarded TCP endpoint:
 *      APP_SERVER_TCP_HOST=127.0.0.1 APP_SERVER_TCP_PORT=9395 \
 *      node ext/examples/reasoning-client.js
 *
 * Environment variables
 * ---------------------
 * - APP_SERVER_IN  (optional): path to the FIFO to write requests to. Defaults to /tmp/codex-app-server.in.
 * - APP_SERVER_OUT (optional): path to the FIFO to read server responses/notifications from. Defaults to /tmp/codex-app-server.out.
 * - APP_SERVER_TCP_HOST (optional): connect over TCP instead of FIFOs. Defaults to undefined (FIFO mode).
 * - APP_SERVER_TCP_PORT (optional): port for TCP mode. Defaults to 9395 when APP_SERVER_TCP_HOST is set.
 *
 * Notes
 * -----
 * - Host FIFO mode: the script is a pure client and expects the server to be running already.
 * - Container TCP proxy mode: start the proxy separately in the container; this client connects over the
 *   forwarded TCP port and does not manage the server lifecycle.
 * - Reasoning notifications are handled to keep the local state consistent but are not shown to the user.
 * - Only the final assistant response is printed when the turn completes.
 */

const fs = require('node:fs');
const { once } = require('node:events');
const readline = require('node:readline');
const net = require('node:net');

const tcpHost = process.env.APP_SERVER_TCP_HOST;
const tcpPort = process.env.APP_SERVER_TCP_PORT
  ? Number.parseInt(process.env.APP_SERVER_TCP_PORT, 10)
  : 9395;

let serverInput;
let serverOutput;
let socket = null;

if (tcpHost) {
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
  const serverInPath = process.env.APP_SERVER_IN ?? '/tmp/codex-app-server.in';
  const serverOutPath = process.env.APP_SERVER_OUT ?? '/tmp/codex-app-server.out';
  serverInput = fs.createWriteStream(serverInPath, { flags: 'a' });
  serverOutput = fs.createReadStream(serverOutPath, { encoding: 'utf8' });
}

let nextId = 1;
const pending = new Map();
let watchedTurnId = null;
let latestAgentMessageId = null;
const agentMessageText = new Map();
const reasoningState = {
  summary: '',
  sections: 0,
};

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
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver.resolve(message.result ?? message.error);
    } else {
      console.warn('Unmatched response', message);
    }
    return;
  }

  if (message.method) {
    handleNotification(message.method, message.params ?? {});
  }
});

function shutdown() {
  rl.close();
  serverInput.end();
  if (socket) {
    socket.end();
  }
}

function handleNotification(method, params) {
  switch (method) {
    case 'turn/started':
      console.log(`Turn started: ${params.turn?.id ?? 'unknown'}`);
      break;
    case 'item/agentMessage/delta': {
      const { delta, itemId } = params;
      if (!itemId || typeof delta !== 'string') {
        break;
      }
      const previous = agentMessageText.get(itemId) ?? '';
      agentMessageText.set(itemId, previous + delta);
      latestAgentMessageId = itemId;
      break;
    }
    case 'item/reasoning/summaryPartAdded':
      reasoningState.sections += 1;
      break;
    case 'item/reasoning/summaryTextDelta':
      if (typeof params.delta === 'string') {
        reasoningState.summary += params.delta;
      }
      break;
    case 'item/reasoning/textDelta':
      // Intentionally processed but not shown; could be used for tracing or metrics.
      break;
    case 'turn/completed': {
      const finalMessage = latestAgentMessageId
        ? agentMessageText.get(latestAgentMessageId)
        : null;
      if (finalMessage) {
        console.log('\nFinal response:');
        console.log(finalMessage.trim());
      } else {
        console.log('Turn completed without an agent message.');
      }

      if (reasoningState.summary || reasoningState.sections > 0) {
        console.log('\n(Reasoning was received but hidden from user output.)');
      }

      shutdown();
      break;
    }
    default:
      // Other notifications are ignored for brevity.
      break;
  }
}

function request(method, params = {}) {
  const id = nextId++;
  const payload = { method, params, id };
  serverInput.write(`${JSON.stringify(payload)}\n`);

  return new Promise((resolve) => {
    pending.set(id, { resolve });
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
      title: 'Reasoning App Server example',
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
    input: [
      {
        type: 'text',
        text: 'Solve 12 + 7 and respond only with the final result.',
      },
    ],
  });

  watchedTurnId = turnResult?.turn?.id;
  console.log('Waiting for turn', watchedTurnId, 'to complete...');
}

main().catch((error) => {
  console.error('Example failed:', error);
  shutdown();
});
