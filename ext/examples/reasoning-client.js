#!/usr/bin/env node
/**
 * Feature example: reasoning-only chat loop
 * -----------------------------------------
 * This client connects to an already-running Codex app server over JSONL (JSON-RPC 2.0 without the jsonrpc header),
 * performs the initialize/initialized handshake, starts a thread, then runs an interactive chat loop that accepts a
 * prompt, waits for the final assistant reply, prints it (hiding all reasoning notifications), and prompts again.
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
 *      codex-app-server-proxy
 * - Publish the proxy port to the host when starting the container, e.g.:
 *      docker run -it --rm -p 9395:9395 my-codex-docker-image /bin/bash
 * - From the host, connect to the forwarded TCP endpoint (defaults to 127.0.0.1:9395 so
 *   no env vars are required):
 *      node ext/examples/reasoning-client.js
 *
 * Environment variables
 * ---------------------
 * - APP_SERVER_TCP_HOST (optional): TCP host for the proxy. Defaults to 127.0.0.1.
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
 * - Reasoning notifications are handled to keep the local state consistent but are not shown to the user.
 * - Only the final assistant response is printed when the turn completes.
 * - After each turn, the user is prompted for another message; type "exit" or press Ctrl+C to quit.
 */

const fs = require('node:fs');
const { once } = require('node:events');
const readline = require('node:readline');
const net = require('node:net');

const fifoInPath = process.env.APP_SERVER_IN;
const fifoOutPath = process.env.APP_SERVER_OUT;
const tcpHost = process.env.APP_SERVER_TCP_HOST ?? '127.0.0.1';
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
let latestAgentMessageId = null;
const agentMessageText = new Map();
const reasoningState = {
  summary: '',
  sections: 0,
};

const serverLines = readline.createInterface({ input: serverOutput });
const userInput = readline.createInterface({ input: process.stdin, output: process.stdout });

serverLines.on('line', (line) => {
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
  serverLines.close();
  userInput.close();
  serverInput.end();
  if (socket) {
    socket.end();
  }
}

function handleNotification(method, params) {
  switch (method) {
    case 'turn/started':
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
      process.stdout.write('.');
      reasoningState.sections += 1;
      break;
    case 'item/reasoning/summaryTextDelta':
      if (typeof params.delta === 'string') {
        process.stdout.write('.');
        reasoningState.summary += params.delta;
      }
      break;
    case 'item/reasoning/textDelta':
      process.stdout.write('.');
      break;
    case 'turn/completed': {
      const completedTurnId = params.turn?.id ?? watchedTurnId;
      if (completedTurnId && watchedTurnId && completedTurnId !== watchedTurnId) {
        console.warn('Received completion for unexpected turn:', completedTurnId);
      }

      const finalMessage = latestAgentMessageId
        ? agentMessageText.get(latestAgentMessageId)
        : null;
      if (finalMessage) {
        process.stdout.write('\n\n');
        console.log(finalMessage.trim());
        process.stdout.write('\n\n\n');
      } else {
        console.log('Turn completed without an agent message.');
        process.stdout.write('\n\n\n');
      }

      if (typeof activeTurnResolver === 'function') {
        activeTurnResolver();
        activeTurnResolver = null;
      }

      promptForNextTurn();
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

function waitForUserPrompt(question) {
  return new Promise((resolve) => {
    userInput.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function promptForNextTurn() {
  const prompt = await waitForUserPrompt(`\n${'-'.repeat(128)}\nEnter a prompt (or type "exit" to quit): `);
  if (!prompt || prompt.toLowerCase() === 'exit') {
    console.log('Goodbye.');
    shutdown();
    return;
  }

  await startTurn(prompt);
}

let activeTurnResolver = null;

async function startTurn(promptText) {
  agentMessageText.clear();
  latestAgentMessageId = null;
  reasoningState.summary = '';
  reasoningState.sections = 0;

  const turnResult = await request('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: promptText,
      },
    ],
  });

  watchedTurnId = turnResult?.turn?.id;
  if (!watchedTurnId) {
    throw new Error('Server did not return a turn id');
  }

  await new Promise((resolve) => {
    activeTurnResolver = resolve;
  });
}

let threadId = null;

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

  const userAgent = initializeResult?.userAgent;
  if (typeof userAgent === 'string' && userAgent.trim()) {
    console.log('Server user agent:', userAgent);
  } else {
    console.log('Server user agent: (not provided by server)');
  }
  notify('initialized');

  const threadResult = await request('thread/start', {});
  threadId = threadResult?.thread?.id;
  if (!threadId) {
    throw new Error('Server did not return a thread id');
  }
  console.log('Started thread', threadId);

  await promptForNextTurn();
}

main().catch((error) => {
  console.error('Example failed:', error);
  shutdown();
});
