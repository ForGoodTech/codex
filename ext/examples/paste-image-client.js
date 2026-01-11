#!/usr/bin/env node
/**
 * Paste image client (ext/examples/paste-image-client.js)
 * -------------------------------------------------------
 * Interactive client for sending image files plus a text prompt.
 * Enter one or more comma-separated file paths when prompted, then enter a
 * text prompt. Type /exit at any prompt to exit.
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
const fsp = require('node:fs/promises');
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
let watchedTurnId = null;
const turnCompletionResolvers = new Map();
let threadId = null;
const queuedInputs = [];
const turnOutputs = new Map();
let printedProgressDot = false;

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

function appendTurnOutput(turnId, text) {
  if (!turnId || !text) {
    return;
  }

  process.stdout.write('.');
  printedProgressDot = true;

  const existing = turnOutputs.get(turnId) ?? [];
  existing.push(text);
  turnOutputs.set(turnId, existing);
}

function emitTurnResult(turnId, status) {
  if (printedProgressDot) {
    process.stdout.write('\n');
    printedProgressDot = false;
  }

  const combined = turnOutputs.get(turnId)?.join('') ?? '';
  if (combined) {
    console.log(`\nTurn ${turnId ?? 'unknown'} completed (${status ?? 'unknown'}).`);
    console.log(combined);
  } else {
    console.log(`\nTurn ${turnId ?? 'unknown'} completed with status: ${status ?? 'unknown'}.`);
  }

  turnOutputs.delete(turnId);
}

function handleNotification(method, params) {
  switch (method) {
    case 'turn/started': {
      const turnId = params.turn?.id;
      if (turnId) {
        turnOutputs.set(turnId, []);
      }
      break;
    }
    case 'item/agentMessage/delta': {
      const turnId = params.turn?.id ?? params.item?.turnId ?? watchedTurnId;
      if (params.delta?.content?.length) {
        appendTurnOutput(turnId, params.delta.content.map((c) => c.text ?? '').join(''));
        break;
      }

      if (typeof params.delta?.text === 'string') {
        appendTurnOutput(turnId, params.delta.text);
        break;
      }

      if (typeof params.delta === 'string') {
        appendTurnOutput(turnId, params.delta);
        break;
      }
      break;
    }
    case 'turn/completed': {
      const turnId = params.turn?.id ?? watchedTurnId;
      emitTurnResult(turnId, params.turn?.status);
      if (watchedTurnId && turnId === watchedTurnId) {
        watchedTurnId = null;
      }

      const resolver = turnCompletionResolvers.get(turnId);
      if (resolver) {
        turnCompletionResolvers.delete(turnId);
        resolver();
      }
      break;
    }
    default:
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

async function askQuestion(question) {
  const answer = await new Promise((resolve) => {
    userInput.question(question, (response) => {
      resolve(response.trim());
    });
  });

  return answer;
}

function detectMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

async function encodeImageAsDataUrl(filePath) {
  const absolutePath = path.resolve(filePath);
  const mime = detectMime(absolutePath);
  const contents = await fsp.readFile(absolutePath);
  const base64 = contents.toString('base64');
  return { dataUrl: `data:${mime};base64,${base64}`, mime, size: contents.byteLength, absolutePath };
}

async function queueImageFromPath(filePath) {
  try {
    const { dataUrl, mime, size, absolutePath } = await encodeImageAsDataUrl(filePath);
    queuedInputs.push({ type: 'image', url: dataUrl });
    console.log(`Queued image from ${absolutePath} (${mime}, ${size} bytes).`);
  } catch (error) {
    console.error('Unable to read image:', error.message);
  }
}

async function sendTurn() {
  if (!threadId) {
    console.warn('Thread not ready yet; skipping send.');
    return;
  }

  if (!queuedInputs.length) {
    console.log('Nothing to send yet. Enter image paths or a prompt first.');
    return;
  }

  const turnResult = await request('turn/start', { threadId, input: queuedInputs.splice(0) });
  watchedTurnId = turnResult?.turn?.id;
  console.log('Submitted turn', watchedTurnId ?? '(unknown)');
  return watchedTurnId;
}

function waitForTurnCompletion(turnId) {
  if (!turnId) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    turnCompletionResolvers.set(turnId, resolve);
  });
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
      title: 'Paste image example',
      version: '0.0.1',
    },
  });

  console.log('Server user agent:', initializeResult?.userAgent);
  notify('initialized');

  const threadResult = await request('thread/start', {});
  threadId = threadResult?.thread?.id;
  if (!threadId) {
    throw new Error('Server did not return a thread id');
  }
  console.log('Started thread', threadId);

  // Prompt loop: image paths first, then a text prompt. Type /exit at any prompt to exit.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    queuedInputs.length = 0;

    const imagePathAnswer = await askQuestion('\nEnter image file path(s) (comma-separated, optional) or /exit to exit:\n> ');
    if (imagePathAnswer === '/exit' || imagePathAnswer === '/quit') {
      console.log('Goodbye.');
      shutdown();
      return;
    }

    const imagePaths = imagePathAnswer
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    for (const imagePath of imagePaths) {
      // eslint-disable-next-line no-await-in-loop
      await queueImageFromPath(imagePath);
    }

    const promptAnswer = await askQuestion('Enter a text prompt (or /exit to exit):\n> ');
    if (promptAnswer === '/exit' || promptAnswer === '/quit') {
      console.log('Goodbye.');
      shutdown();
      return;
    }

    if (promptAnswer) {
      queuedInputs.push({ type: 'text', text: promptAnswer });
    }

    if (!queuedInputs.length) {
      console.log('Nothing to send. Enter an image path or a text prompt.');
      continue;
    }

    const turnId = await sendTurn();
    await waitForTurnCompletion(turnId);
  }
}

main().catch((error) => {
  console.error('Example failed:', error);
  shutdown();
});
