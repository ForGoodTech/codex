#!/usr/bin/env node
/**
 * Reasoning SDK Proxy Client
 * --------------------------
 * Mimics the reasoning app-server example: maintains a single Codex thread and
 * streams responses while suppressing reasoning-only updates. Connects to the
 * SDK proxy over TCP instead of the app server proxy.
 */

const net = require('node:net');
const readline = require('node:readline');

const host = process.env.SDK_PROXY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;
const verbose = process.argv.includes('--verbose') || process.env.SDK_PROXY_VERBOSE === '1';

const { envOverrides, codexOptions, authJson } = buildConnectionOptions();

function logDebug(message, ...args) {
  if (verbose) {
    console.log(message, ...args);
  }
}

const socket = net.connect({ host, port }, () => {
  console.log(`Connected to sdk-proxy at ${host}:${port}`);
  logDebug('Debug: connection options', { envOverrides, codexOptions, threadId });
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
  sawProgress = false;
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

function flushAgentMessage() {
  const output = agentMessage.trim();
  if (output.length) {
    console.log(`\n${output}`);
  } else if (!verbose) {
    console.log('\n(no response content)');
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
  if (event.type.endsWith('.delta') || event.type === 'item.updated' || event.type === 'message.delta') {
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
    authJson: undefined,
  };
}
