#!/usr/bin/env node
/**
 * Reasoning SDK Proxy Client
 * --------------------------
 * Mimics the reasoning app-server example: maintains a single Codex thread and
 * streams responses while suppressing reasoning-only updates. Connects to the
 * SDK proxy over TCP instead of the app server proxy.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const host = process.env.SDK_PROXY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;

const { envOverrides, codexOptions, authJson } = buildConnectionOptions();

const socket = net.connect({ host, port }, () => {
  console.log(`Connected to sdk-proxy at ${host}:${port}`);
  console.log('Debug: connection options', { envOverrides, codexOptions, threadId });
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
      turnActive = false;
      promptUser();
      break;
    case 'aborted':
      console.log('Debug: aborted message received');
      console.log('\nTurn aborted.');
      turnActive = false;
      promptUser();
      break;
    case 'error':
      console.log('Debug: proxy error payload', message);
      console.error('proxy -> error', message.message);
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
  console.log('Debug: user input line', trimmed);
  if (!trimmed) {
    promptUser();
    return;
  }
  if (trimmed === '/exit') {
    userInput.close();
    socket.end();
    return;
  }

  sendPrompt(trimmed);
});

userInput.on('close', () => {
  socket.end();
});

function promptUser() {
  if (turnActive) return;
  console.log('\nEnter a prompt (or /exit to quit):');
  userInput.setPrompt('> ');
  userInput.prompt();
}

function sendPrompt(prompt) {
  if (turnActive) {
    console.log('Wait for the current turn to finish.');
    return;
  }

  agentMessage = '';
  turnActive = true;
  const payload = {
    type: 'run',
    prompt,
    options: codexOptions,
    env: envOverrides,
    authJson,
  };
  if (threadId) {
    payload.threadId = threadId;
  }
  console.log('Debug: sending run payload', payload);
  const serialized = `${JSON.stringify(payload)}\n`;
  console.log('Debug: payload bytes', Buffer.byteLength(serialized, 'utf8'));
  const wrote = socket.write(serialized);
  if (!wrote) {
    console.log('Debug: socket write returned false (backpressure)');
  }
}

function handleEvent(event) {
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

function flushAgentMessage() {
  if (agentMessage.trim().length) {
    process.stdout.write('\n');
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

function buildConnectionOptions() {
  const env = {};
  const resolvedWorkdir = path.resolve(process.env.CODEX_WORKDIR || process.cwd());
  const options = {
    sandboxMode: process.env.CODEX_SANDBOX_MODE || 'danger-full-access',
    workingDirectory: resolvedWorkdir,
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY || 'never',
  };
  const authJson = loadAuthJson();

  env.CODEX_AUTO_APPROVE = process.env.CODEX_AUTO_APPROVE || '1';
  env.CODEX_APPROVAL_POLICY = options.approvalPolicy;
  env.CODEX_WORKDIR = options.workingDirectory;

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
