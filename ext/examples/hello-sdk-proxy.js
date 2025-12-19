#!/usr/bin/env node
/**
 * Hello Codex SDK Proxy
 * ----------------------
 * Connects to the SDK proxy over TCP, starts a new thread, and streams a single
 * turn using a simple text prompt. Mirrors the hello app-server example but
 * targets the SDK proxy instead of the app server proxy.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
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
  logDebug('Debug: connection options', { envOverrides, codexOptions });
  socket.write(`${JSON.stringify({ type: 'ping', at: new Date().toISOString() })}\n`);
  sendRun('Say hello.');
});

const rl = readline.createInterface({ input: socket });
let activeTurn = null;
let agentText = '';
let sawProgress = false;

rl.on('line', (line) => {
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
    case 'event': {
      logDebug('Debug: proxy event type', message.event?.type);
      handleEvent(message.event);
      break;
    }
    case 'done': {
      logDebug('Debug: done received', message);
      flushProgress();
      if (activeTurn) {
        const output = agentText.trim();
        console.log(`\nTurn completed. Thread id: ${message.threadId ?? 'unknown'}`);
        if (output) {
          console.log(output);
        } else {
          console.log('(no response content)');
        }
        activeTurn = null;
      }
      socket.end();
      break;
    }
    case 'error':
      logDebug('Debug: proxy error payload', message);
      console.error('proxy -> error', message.message);
      socket.end();
      break;
    default:
      break;
  }
});

socket.on('error', (error) => {
  console.error('Socket error:', error);
});

function sendRun(prompt) {
  activeTurn = { prompt };
  agentText = '';
  sawProgress = false;
  logDebug('Debug: sending run payload', { type: 'run', prompt, options: codexOptions, env: envOverrides });
  socket.write(
    `${JSON.stringify({ type: 'run', prompt, options: codexOptions, env: envOverrides, authJson })}\n`,
  );
}

function handleEvent(event) {
  trackProgress(event);
  switch (event?.type) {
    case 'turn.started':
      agentText = '';
      break;
    case 'message.delta':
      if (event.delta?.text) {
        agentText += event.delta.text;
      }
      break;
    case 'message.completed': {
      const text = (event.message?.content || [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      if (text) {
        agentText = text;
      }
      break;
    }
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
    agentText += text;
  }
}

function handleAgentCompleted(item) {
  if (item?.type !== 'agent_message' || typeof item.text !== 'string') return;
  const remaining = item.text.startsWith(agentText) ? item.text.slice(agentText.length) : item.text;
  if (remaining) {
    agentText += remaining;
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
