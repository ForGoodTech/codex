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
const os = require('node:os');
const readline = require('node:readline');

const host = process.env.SDK_PROXY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;

const { envOverrides, codexOptions, authJson } = buildConnectionOptions();

const socket = net.connect({ host, port }, () => {
  console.log(`Connected to sdk-proxy at ${host}:${port}`);
  console.log('Debug: connection options', { envOverrides, codexOptions });
  socket.write(`${JSON.stringify({ type: 'ping', at: new Date().toISOString() })}\n`);
  promptForImages();
});

const userInput = readline.createInterface({ input: process.stdin, output: process.stdout });
const serverLines = readline.createInterface({ input: socket });

let threadId = null;
let pending = false;
let queuedImages = [];
let agentMessage = '';

serverLines.on('line', (line) => {
  console.log('Debug: raw line from proxy', line);
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
      console.log('Debug: proxy ready payload', message);
      break;
    case 'event':
      console.log('Debug: proxy event type', message.event?.type);
      handleEvent(message.event);
      break;
    case 'done':
      console.log('Debug: done received', message);
      threadId = message.threadId ?? threadId;
      flushAgentMessage();
      pending = false;
      promptForImages();
      break;
    case 'aborted':
      console.log('Debug: aborted message received');
      console.log('\nTurn aborted.');
      pending = false;
      promptForImages();
      break;
    case 'error':
      console.log('Debug: proxy error payload', message);
      console.error('Proxy error:', message.message);
      pending = false;
      promptForImages();
      break;
    default:
      break;
  }
});

socket.on('error', (error) => {
  console.error('Socket error:', error);
});

userInput.on('close', () => {
  socket.end();
});

function promptForImages() {
  if (pending) return;
  userInput.question('\nEnter image file path(s) (comma-separated, optional) or /exit to quit:\n> ', async (line) => {
    const trimmed = line.trim();
    if (trimmed === '/exit') {
      userInput.close();
      return;
    }

    queuedImages = [];
    if (trimmed.length) {
      const paths = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
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

    promptForPrompt();
  });
}

function promptForPrompt() {
  if (pending) return;
  userInput.question('Enter a text prompt (or /exit to quit):\n> ', (line) => {
    const prompt = line.trim();
    if (prompt === '/exit') {
      userInput.close();
      return;
    }
    sendTurn(prompt);
  });
}

function sendTurn(prompt) {
  pending = true;
  agentMessage = '';
  const payload = {
    type: 'run',
    prompt,
    images: queuedImages,
    options: codexOptions,
    env: envOverrides,
    authJson,
  };
  if (threadId) {
    payload.threadId = threadId;
  }
  console.log('Debug: sending run payload', payload);
  socket.write(`${JSON.stringify(payload)}\n`);
}

function handleEvent(event) {
  if (event?.type === 'thread.started') {
    threadId = event.thread_id;
  }

  switch (event?.type) {
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
  if (agentMessage.trim().length) {
    process.stdout.write('\n');
  }
}

function handleAgentDelta(item) {
  if (item?.type !== 'agent_message') return;
  const text = extractDeltaText(item.delta);
  if (text) {
    agentMessage += text;
    process.stdout.write(text);
  }
}

function handleAgentCompleted(item) {
  if (item?.type !== 'agent_message' || typeof item.text !== 'string') return;
  const remaining = item.text.startsWith(agentMessage) ? item.text.slice(agentMessage.length) : item.text;
  if (remaining) {
    agentMessage += remaining;
    process.stdout.write(remaining);
  }
}

function extractDeltaText(delta) {
  if (Array.isArray(delta?.content)) {
    return delta.content.map((part) => part.text ?? '').join('');
  }
  if (typeof delta?.text === 'string') {
    return delta.text;
  }
  return '';
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
  const options = {
    sandboxMode: process.env.CODEX_SANDBOX_MODE || 'danger-full-access',
    workingDirectory: process.env.CODEX_WORKDIR || '/home/node/workdir',
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY || 'never',
  };
  const authJson = loadAuthJson();

  env.CODEX_AUTO_APPROVE = process.env.CODEX_AUTO_APPROVE || '1';
  env.CODEX_APPROVAL_POLICY = options.approvalPolicy;

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
    codexOptions: options,
    authJson,
  };
}

function loadAuthJson() {
  const authPath = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), '.codex/auth.json');
  try {
    return fs.readFileSync(authPath, 'utf8');
  } catch {
    return undefined;
  }
}

