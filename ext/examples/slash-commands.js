#!/usr/bin/env node
/**
 * Slash command client (ext/examples/slash-commands.js)
 * -----------------------------------------------------
 * Lightweight interactive client that mimics Codex's slash commands while
 * connecting to an already-running app server (direct FIFOs or the TCP proxy
 * inside Docker).
 *
 * Architecture
 * ------------
 * - Shared connection logic establishes the initialize/initialized handshake
 *   with the app server.
 * - A simple prompt accepts slash commands and dispatches to small modular
 *   handlers under ./slash-commands/.
 * - For fast prototyping we implement `/status`, which fetches user and auth
 *   details from the app server.
 *
 * How to run (server inside Docker container)
 * -------------------------------------------
 * - Start the proxy in a container attached to the shared Docker network:
 *      docker network create codex-net
 *      docker run -it --rm --name codex-proxy --network codex-net my-codex-docker-image /bin/bash
 *      codex-app-server-proxy
 * - From another container on codex-net (for example, the examples image),
 *   connect to codex-proxy:9395 (the defaults below).
 *
 * Environment variables
 * ---------------------
 * - APP_SERVER_TCP_HOST (optional): TCP host for the proxy. Defaults to
 *   codex-proxy.
 * - APP_SERVER_TCP_PORT (optional): TCP port for the proxy. Defaults to 9395.
 * - APP_SERVER_IN  (optional): path to the FIFO to write requests to. Defaults
 *   to /tmp/codex-app-server.in when set.
 * - APP_SERVER_OUT (optional): path to the FIFO to read server
 *   responses/notifications from. Defaults to /tmp/codex-app-server.out when
 *   set.
 */

const fs = require('node:fs');
const { once } = require('node:events');
const readline = require('node:readline');
const net = require('node:net');
const path = require('node:path');

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

const serverLines = readline.createInterface({ input: serverOutput });
const userInput = readline.createInterface({ input: process.stdin, output: process.stdout });

const commandModules = new Map();

function loadCommand(commandName) {
  if (commandModules.has(commandName)) {
    return commandModules.get(commandName);
  }

  const modulePath = path.join(__dirname, 'slash-commands', `${commandName.slice(1)}.js`);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const handler = require(modulePath);
  commandModules.set(commandName, handler);
  return handler;
}

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
    console.log('Notification', message.method, message.params ?? {});
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

function askInput(question) {
  return new Promise((resolve) => {
    userInput.question(question, (answerRaw) => {
      resolve(answerRaw.trim());
    });
  });
}

function askYesNo(question) {
  return askInput(question).then((answer) => {
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  });
}

function printMenu() {
  console.log('\nAvailable commands:');
  console.log('  /status  - show current session details (user agent and auth)');
  console.log('  /model   - list available models');
  console.log('  /help    - show this help');
  console.log('  /quit    - exit client');
  console.log('  /exit    - exit client');
}

async function runCommandLoop(context) {
  printMenu();

  const prompt = () => new Promise((resolve) => {
    userInput.question('\nEnter a slash command: ', (answer) => {
      resolve(answer.trim());
    });
  });

  while (true) {
    const command = await prompt();
    if (!command) {
      continue;
    }

    if (command === '/quit' || command === '/exit') {
      console.log('Goodbye.');
      shutdown();
      return;
    }

    if (command === '/help') {
      printMenu();
      continue;
    }

    if (command === '/status' || command === '/model') {
      const handler = loadCommand(command);
      await handler.run({ ...context, askYesNo, askInput });
      continue;
    }

    console.log(`Unknown command: ${command}`);
    printMenu();
  }
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
      title: 'Slash command client example',
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

  await runCommandLoop({ request, notify, connectionMode: socket ? 'tcp' : 'fifo' });
}

main().catch((error) => {
  console.error('Slash command client failed:', error);
  shutdown();
});
