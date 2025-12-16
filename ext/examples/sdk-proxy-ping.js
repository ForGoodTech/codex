#!/usr/bin/env node
/**
 * SDK proxy ping / smoke test
 * ---------------------------
 * Connects to the sdk-proxy, sends a ping to confirm the TCP path, then runs a
 * single prompt to show Codex SDK execution over the proxy.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const host = process.env.SDK_PROXY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;
const prompt = process.argv.slice(2).join(' ').trim()
  || 'Say hello from the sdk-proxy ping test.';

const { envOverrides, codexOptions, authJson } = buildConnectionOptions();

const socket = net.connect({ host, port }, () => {
  console.log(`Connected to sdk-proxy at ${host}:${port}`);
  socket.write(`${JSON.stringify({ type: 'ping' })}\n`);
});

const rl = readline.createInterface({ input: socket });
let pendingRun = false;
let output = '';

rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error('proxy -> non-JSON line', line);
    return;
  }

  switch (message.type) {
    case 'pong': {
      console.log(`proxy -> pong at ${message.at}`);
      if (!pendingRun) {
        pendingRun = true;
        sendRun(prompt);
      }
      break;
    }
    case 'event':
      handleEvent(message.event);
      break;
    case 'done':
      console.log(`\nRun completed. Thread id: ${message.threadId ?? 'unknown'}`);
      socket.end();
      break;
    case 'error':
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

function sendRun(text) {
  output = '';
  socket.write(
    `${JSON.stringify({ type: 'run', prompt: text, options: codexOptions, env: envOverrides, authJson })}\n`,
  );
}

function handleEvent(event) {
  switch (event?.type) {
    case 'message.delta':
      if (event.delta?.text) {
        output += event.delta.text;
        process.stdout.write(event.delta.text);
      }
      break;
    case 'message.completed': {
      const text = (event.message?.content || [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      if (text) {
        output += text;
        process.stdout.write(text);
      }
      break;
    }
    case 'turn.failed':
      console.error('Turn failed:', event.error ?? '(no error provided)');
      socket.end();
      break;
    default:
      break;
  }
}

function buildConnectionOptions() {
  const envOverrides = {};
  if (process.env.CODEX_BASE_URL) envOverrides.CODEX_BASE_URL = process.env.CODEX_BASE_URL;
  if (process.env.OPENAI_BASE_URL) envOverrides.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
  if (process.env.CODEX_API_KEY) envOverrides.CODEX_API_KEY = process.env.CODEX_API_KEY;
  if (process.env.OPENAI_API_KEY) envOverrides.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (process.env.CODEX_AUTO_APPROVE) envOverrides.CODEX_AUTO_APPROVE = process.env.CODEX_AUTO_APPROVE;

  const authPath = process.env.CODEX_AUTH_PATH
    ? path.resolve(process.env.CODEX_AUTH_PATH)
    : path.join(os.homedir(), '.codex', 'auth.json');

  let authJson = null;
  if (fs.existsSync(authPath)) {
    authJson = fs.readFileSync(authPath, 'utf8');
  }

  const codexOptions = {
    sandboxMode: process.env.CODEX_SANDBOX || 'danger-full-access',
    workingDirectory: process.env.CODEX_WORKDIR || process.cwd(),
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY || 'on-request',
  };

  return { envOverrides, codexOptions, authJson };
}
