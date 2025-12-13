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
 * - In the container, run the long-lived proxy that bridges the app server
 *   stdio to a TCP port (see ext/docker/pi/app-server-proxy.js for full
 *   instructions). Example inside the container:
 *      APP_SERVER_PORT=9395 codex-app-server-proxy
 * - Publish the proxy port to the host when starting the container, e.g.:
 *      docker run -it --rm -p 9395:9395 my-codex-docker-image /bin/bash
 * - From the host, point this client at the forwarded TCP endpoint:
 *      APP_SERVER_TCP_HOST=127.0.0.1 APP_SERVER_TCP_PORT=9395 \
 *      node ext/examples/paste-image-client.js
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
const fsp = require('node:fs/promises');
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
let watchedTurnId = null;
let threadId = null;
const queuedInputs = [];

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

function logNotification(method, params) {
  switch (method) {
    case 'turn/started':
      console.log(`Turn started: ${params.turn?.id ?? 'unknown'}`);
      break;
    case 'turn/completed':
      console.log(`Turn completed with status: ${params.turn?.status}`);
      if (watchedTurnId && params.turn?.id === watchedTurnId) {
        watchedTurnId = null;
      }
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
    default:
      console.log('Notification', method, params);
  }
}

function handleNotification(method, params) {
  logNotification(method, params);
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
  if (!filePath) {
    console.log('Enter at least one image path.');
    return;
  }

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
    console.log('Nothing to send yet. Enter image paths and a prompt first.');
    return;
  }

  const turnResult = await request('turn/start', { threadId, input: queuedInputs.splice(0) });
  watchedTurnId = turnResult?.turn?.id;
  console.log('Submitted turn', watchedTurnId ?? '(unknown)');
}

function printFlow() {
  console.log('\nFlow:');
  console.log('1) Enter one or more comma-separated image paths (or /exit to exit).');
  console.log('2) Enter a text prompt.');
  console.log('3) The turn is submitted with the images and prompt.');
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

  printFlow();

  // Prompt loop: image paths first, then a text prompt. Type /exit at any prompt to exit.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    queuedInputs.length = 0;

    const imagePathAnswer = await askQuestion('\nEnter image file path(s) (comma-separated) or /exit to exit:\n> ');
    if (imagePathAnswer === '/exit' || imagePathAnswer === '/quit') {
      console.log('Goodbye.');
      shutdown();
      return;
    }

    const imagePaths = imagePathAnswer
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    if (!imagePaths.length) {
      console.log('Please enter at least one image path.');
      continue;
    }

    for (const imagePath of imagePaths) {
      // eslint-disable-next-line no-await-in-loop
      await queueImageFromPath(imagePath);
    }

    if (!queuedInputs.length) {
      console.log('No valid images queued. Try again.');
      continue;
    }

    const promptAnswer = await askQuestion('Enter a text prompt (or /exit to exit):\n> ');
    if (promptAnswer === '/exit' || promptAnswer === '/quit') {
      console.log('Goodbye.');
      shutdown();
      return;
    }

    if (!promptAnswer) {
      console.log('Please enter a text prompt.');
      continue;
    }

    queuedInputs.push({ type: 'text', text: promptAnswer });

    await sendTurn();
  }
}

main().catch((error) => {
  console.error('Example failed:', error);
  shutdown();
});
