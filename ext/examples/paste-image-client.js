#!/usr/bin/env node
/**
 * Paste image client (ext/examples/paste-image-client.js)
 * -------------------------------------------------------
 * Interactive client that mirrors Codex standalone's image paste flow.
 * Press Ctrl+V to choose an image file from the local machine; the client
 * encodes it as a data URL and sends it to the app server so the standard
 * paste logic can process it as a turn input. When Ctrl+V isn't available
 * (e.g., an SSH terminal), type "/paste /path/to/image" to attach the file
 * instead.
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
readline.emitKeypressEvents(process.stdin, userInput);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
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
    handleNotification(message.method, message.params ?? {});
  }
});

process.stdin.on('keypress', (str, key) => {
  if (key?.name === 'backspace') {
    // Avoid treating backspace as a submit key when editing commands.
    userInput.write(null, key);
    return;
  }

  if (key?.ctrl && key.name === 'v') {
    handlePasteShortcut();
    return;
  }

  if (key?.ctrl && key.name === 'c') {
    console.log('\nGoodbye.');
    shutdown();
  }
});

function shutdown() {
  serverLines.close();
  userInput.close();
  serverInput.end();
  if (socket) {
    socket.end();
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
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
        promptForNextMessage();
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
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  const answer = await new Promise((resolve) => {
    userInput.question(question, (response) => {
      resolve(response.trim());
    });
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

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
    console.log('Usage: /paste <path-to-image[,additional-image]>');
    return;
  }

  try {
    const { dataUrl, mime, size, absolutePath } = await encodeImageAsDataUrl(filePath);
    queuedInputs.push({ type: 'image', url: dataUrl });
    console.log(`Queued image from ${absolutePath} (${mime}, ${size} bytes). Press Enter to send.`);
  } catch (error) {
    console.error('Unable to read image:', error.message);
  }
}

async function handlePasteShortcut() {
  console.log('\nPaste detected (Ctrl+V).');
  const filePath = await askQuestion('Enter the path to an image file to paste: ');
  if (!filePath) {
    console.log('No file selected; paste cancelled.');
    promptForNextMessage();
    return;
  }

  await queueImageFromPath(filePath);

  promptForNextMessage();
}

async function sendTurn() {
  if (!threadId) {
    console.warn('Thread not ready yet; skipping send.');
    return;
  }

  if (!queuedInputs.length) {
    console.log('Nothing to send yet. Type a message or press Ctrl+V to paste an image.');
    return;
  }

  const turnResult = await request('turn/start', { threadId, input: queuedInputs.splice(0) });
  watchedTurnId = turnResult?.turn?.id;
  console.log('Submitted turn', watchedTurnId ?? '(unknown)');
}

function promptForNextMessage() {
  userInput.setPrompt('Enter a message (Ctrl+V or /paste <path[,extra]> to attach image(s), /quit to exit): ');
  userInput.prompt();
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

  promptForNextMessage();

  userInput.on('line', async (line) => {
    const trimmed = line.trim();
    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('Goodbye.');
      shutdown();
      return;
    }

    if (trimmed.startsWith('/paste')) {
      const [, ...pathParts] = trimmed.split(/\s+/);
      const imagePaths = pathParts.join(' ').split(',').map((part) => part.trim()).filter(Boolean);
      if (!imagePaths.length) {
        console.log('Usage: /paste <path-to-image[,additional-image]>');
        promptForNextMessage();
        return;
      }

      for (const imagePath of imagePaths) {
        // eslint-disable-next-line no-await-in-loop
        await queueImageFromPath(imagePath);
      }

      promptForNextMessage();
      return;
    }

    if (trimmed) {
      queuedInputs.push({ type: 'text', text: trimmed });
    }

    await sendTurn();
    promptForNextMessage();
  });
}

main().catch((error) => {
  console.error('Example failed:', error);
  shutdown();
});
