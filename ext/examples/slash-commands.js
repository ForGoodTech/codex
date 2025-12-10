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
 * - In the container, run the long-lived proxy that bridges the app server
 *   stdio to a TCP port (see ext/docker/pi/app-server-proxy.js for full
 *   instructions). Example inside the container:
 *      APP_SERVER_PORT=9395 codex-app-server-proxy
 * - Publish the proxy port to the host when starting the container, e.g.:
 *      docker run -it --rm -p 9395:9395 my-codex-docker-image /bin/bash
 * - From the host, point this client at the forwarded TCP endpoint:
 *      APP_SERVER_TCP_HOST=127.0.0.1 APP_SERVER_TCP_PORT=9395 \
 *      node ext/examples/slash-commands.js
 *
 * Environment variables
 * ---------------------
 * - APP_SERVER_IN  (optional): path to the FIFO to write requests to. Defaults
 *   to /tmp/codex-app-server.in.
 * - APP_SERVER_OUT (optional): path to the FIFO to read server
 *   responses/notifications from. Defaults to /tmp/codex-app-server.out.
 * - APP_SERVER_TCP_HOST (optional): connect over TCP instead of FIFOs.
 *   Defaults to undefined (FIFO mode).
 * - APP_SERVER_TCP_PORT (optional): port for TCP mode. Defaults to 9395 when
 *   APP_SERVER_TCP_HOST is set.
 */

const fs = require('node:fs');
const { once } = require('node:events');
const readline = require('node:readline');
const net = require('node:net');
const path = require('node:path');

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
