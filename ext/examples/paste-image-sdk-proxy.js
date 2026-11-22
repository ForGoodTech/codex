#!/usr/bin/env node
/**
 * Paste Image SDK Proxy Client
 * ----------------------------
 * Mirrors the paste-image app-server example but sends local image data to the
 * SDK proxy over TCP. Images are converted to data URLs on the host and written
 * to temporary files by the proxy so the Codex CLI can consume them.
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');

const host = process.env.SDK_PROXY_HOST ?? 'codex-proxy';
const port = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;
const verbose = process.argv.includes('--verbose') || process.env.SDK_PROXY_VERBOSE === '1';

const { envOverrides, codexOptions } = buildConnectionOptions();

function logDebug(message, ...args) {
  if (verbose) {
    console.log(message, ...args);
  }
}

const socket = net.connect({ host, port }, () => {
  console.log(`Connected to sdk-proxy at ${host}:${port}`);
  logDebug('Debug: connection options', { envOverrides, codexOptions });
  socket.write(`${JSON.stringify({ type: 'ping', at: new Date().toISOString() })}\n`);
  promptUser();
});

const userInput = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});
const serverLines = readline.createInterface({ input: socket });

let threadId = null;
let turnActive = false;
let agentMessage = '';
let queuedImages = [];
let sawProgress = false;

serverLines.on('line', (line) => {
  logDebug('Debug: raw line from proxy', line);
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error('proxy -> non-JSON line', line);
    return;
  }

  switch (message.type) {
    case 'ready':
      logDebug('Debug: proxy ready payload', message);
      break;
    case 'event':
      logDebug('Debug: proxy event type', message.event?.type);
      handleEvent(message.event);
      break;
    case 'done':
      logDebug('Debug: done received', message);
      threadId = message.threadId ?? threadId;
      flushProgress();
      flushAgentMessage();
      turnActive = false;
      promptUser();
      break;
    case 'aborted':
      logDebug('Debug: aborted message received');
      flushProgress();
      console.log('\nTurn aborted.');
      turnActive = false;
      promptUser();
      break;
    case 'error':
      logDebug('Debug: proxy error payload', message);
      flushProgress();
      console.error('Proxy error:', message.message);
      turnActive = false;
      promptUser();
      break;
    default:
      break;
  }
});

socket.on('error', (error) => {
  console.error('Socket error:', error);
});

userInput.on('line', (line) => {
  const trimmed = line.trim();
  logDebug('Debug: user input line', trimmed);
  if (!trimmed) {
    promptUser();
    return;
  }
  if (trimmed === '/exit') {
    userInput.close();
    socket.end();
    return;
  }

  if (awaitingImages) {
    queueImages(trimmed)
      .then(() => {
        awaitingImages = false;
        promptForPrompt();
      })
      .catch((error) => {
        console.error('Failed to load images:', error.message);
        awaitingImages = false;
        promptUser();
      });
    return;
  }

  sendTurn(trimmed);
});

userInput.on('close', () => {
  socket.end();
});

let awaitingImages = false;

function promptUser() {
  if (turnActive) return;
  queuedImages = [];
  awaitingImages = true;
  console.log('\nEnter image file path(s) (comma-separated, optional) or /exit to quit:');
  userInput.setPrompt('> ');
  userInput.prompt();
}

function promptForPrompt() {
  if (turnActive) return;
  console.log('Enter a text prompt (or /exit to quit):');
  userInput.setPrompt('> ');
  userInput.prompt();
}

async function queueImages(input) {
  queuedImages = [];
  const trimmed = input.trim();
  if (!trimmed.length) return;
  const paths = trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const imagePath of paths) {
    try {
      const data = await loadImageAsDataUrl(imagePath);
      const stats = fs.statSync(imagePath);
      console.log(`Queued image from ${imagePath} (${mimeFromPath(imagePath)}, ${stats.size} bytes).`);
      queuedImages.push({ name: path.basename(imagePath), data });
    } catch (error) {
      console.error(`Failed to read ${imagePath}:`, error.message);
    }
  }
}

function sendTurn(prompt) {
  if (turnActive) {
    console.log('Wait for the current turn to finish.');
    return;
  }
  if (!prompt) {
    promptUser();
    return;
  }

  turnActive = true;
  agentMessage = '';
  sawProgress = false;
  const payload = {
    type: 'run',
    prompt,
    images: queuedImages,
    options: codexOptions,
    env: envOverrides,
  };
  if (threadId) {
    payload.threadId = threadId;
  }
  logDebug('Debug: sending run payload', payload);
  const serialized = `${JSON.stringify(payload)}\n`;
  logDebug('Debug: payload bytes', Buffer.byteLength(serialized, 'utf8'));
  const wrote = socket.write(serialized);
  if (!wrote) {
    logDebug('Debug: socket write returned false (backpressure)');
  }
}

function handleEvent(event) {
  trackProgress(event);
  switch (event?.type) {
    case 'thread.started':
      threadId = event.thread_id;
      break;
    case 'turn.started':
      agentMessage = '';
      break;
    case 'item.updated':
      handleAgentDelta(event.item);
      break;
    case 'item.completed':
      handleAgentCompleted(event.item);
      break;
    case 'turn.failed':
      console.error(`Turn failed: ${event.error?.message ?? 'unknown error'}`);
      break;
    default:
      break;
  }
}

function flushAgentMessage() {
  const output = agentMessage.trim();
  if (output.length) {
    console.log(`\n${output}`);
  } else if (!verbose) {
    console.log('\n(no response content)');
  }
}

function handleAgentDelta(item) {
  if (item?.type !== 'agent_message') return;
  const text = extractDeltaText(item.delta);
  if (text) {
    agentMessage += text;
  }
}

function handleAgentCompleted(item) {
  if (item?.type !== 'agent_message' || typeof item.text !== 'string') return;
  const remaining = item.text.startsWith(agentMessage) ? item.text.slice(agentMessage.length) : item.text;
  if (remaining) {
    agentMessage += remaining;
  }
}

function extractDeltaText(delta) {
  if (Array.isArray(delta?.content)) {
    return delta.content
      .filter((part) => part.type !== 'reasoning')
      .map((part) => part.text ?? '')
      .join('');
  }
  if (typeof delta?.text === 'string') {
    return delta.text;
  }
  return '';
}

function trackProgress(event) {
  if (verbose) {
    return;
  }
  if (!event?.type) {
    return;
  }
  if (event.type !== 'turn.completed' && event.type !== 'turn.failed') {
    process.stdout.write('.');
    sawProgress = true;
  }
}

function flushProgress() {
  if (sawProgress) {
    process.stdout.write('\n');
    sawProgress = false;
  }
}

async function loadImageAsDataUrl(imagePath) {
  const data = await fs.promises.readFile(imagePath);
  const mime = mimeFromPath(imagePath);
  const base64 = data.toString('base64');
  return `data:${mime};base64,${base64}`;
}

function mimeFromPath(imagePath) {
  const lower = imagePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

function buildConnectionOptions() {
  const env = {};
  const options = {};
  const allowedSandboxModes = new Set(['read-only', 'workspace-write', 'danger-full-access']);
  const requestedSandboxMode = process.env.CODEX_SANDBOX_MODE;
  let sandboxMode = requestedSandboxMode;
  if (requestedSandboxMode && !allowedSandboxModes.has(requestedSandboxMode)) {
    console.warn(`Ignoring unsupported CODEX_SANDBOX_MODE=${requestedSandboxMode}`);
    sandboxMode = undefined;
  }
  options.sandboxMode = sandboxMode ?? 'danger-full-access';

  const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
    env.OPENAI_API_KEY = apiKey;
    options.apiKey = apiKey;
  }

  const baseUrl = process.env.CODEX_BASE_URL || process.env.OPENAI_BASE_URL;
  if (baseUrl) {
    env.OPENAI_BASE_URL = baseUrl;
    options.baseUrl = baseUrl;
  }

  return {
    envOverrides: Object.keys(env).length ? env : undefined,
    codexOptions: Object.keys(options).length ? options : undefined,
  };
}
