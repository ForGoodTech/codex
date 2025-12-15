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

const socket = net.connect({ host, port }, () => {
  console.log(`Connected to sdk-proxy at ${host}:${port}`);
  promptUser();
});

const userInput = readline.createInterface({ input: process.stdin, output: process.stdout });
const serverLines = readline.createInterface({ input: socket });

let threadId = null;
let turnActive = false;

serverLines.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error('proxy -> non-JSON line', line);
    return;
  }

  switch (message.type) {
    case 'event':
      handleEvent(message.event);
      break;
    case 'done':
      threadId = message.threadId ?? threadId;
      turnActive = false;
      promptUser();
      break;
    case 'aborted':
      console.log('\nTurn aborted.');
      turnActive = false;
      promptUser();
      break;
    case 'error':
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
  if (turnActive) {
    console.log('Wait for the current turn to finish.');
    return;
  }

  const trimmed = line.trim();
  if (!trimmed) {
    promptUser();
    return;
  }
  if (trimmed === '/exit') {
    userInput.close();
    socket.end();
    return;
  }

  turnActive = true;
  const payload = { type: 'run', prompt: trimmed };
  if (threadId) {
    payload.threadId = threadId;
  }
  socket.write(`${JSON.stringify(payload)}\n`);
});

userInput.on('close', () => {
  socket.end();
});

function promptUser() {
  if (!turnActive) {
    userInput.question('\nEnter a prompt (or /exit to quit):\n> ', () => {});
  }
}

function handleEvent(event) {
  if (event?.type === 'thread.started') {
    threadId = event.thread_id;
  }

  if (event?.type === 'item.updated' && event.item?.type === 'agent_message') {
    const delta = event.item.delta;
    if (Array.isArray(delta?.content)) {
      const text = delta.content
        .filter((part) => part.type !== 'reasoning')
        .map((part) => part.text ?? '')
        .join('');
      if (text) process.stdout.write(text);
    } else if (typeof delta?.text === 'string') {
      process.stdout.write(delta.text);
    }
  }
}
