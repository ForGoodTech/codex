#!/usr/bin/env node
/**
 * Hello Codex SDK Proxy
 * ----------------------
 * Connects to the SDK proxy over TCP, starts a new thread, and streams a single
 * turn using a simple text prompt. Mirrors the hello app-server example but
 * targets the SDK proxy instead of the app server proxy.
 */

const net = require('node:net');
const readline = require('node:readline');

const host = process.env.SDK_PROXY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;

const socket = net.connect({ host, port }, () => {
  console.log(`Connected to sdk-proxy at ${host}:${port}`);
  sendRun('Say hello and describe what this proxy does.');
});

const rl = readline.createInterface({ input: socket });
let activeTurn = null;

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
    case 'event': {
      handleEvent(message.event);
      break;
    }
    case 'done': {
      if (activeTurn) {
        console.log(`\nTurn completed. Thread id: ${message.threadId ?? 'unknown'}`);
        activeTurn = null;
      }
      socket.end();
      break;
    }
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

function sendRun(prompt) {
  activeTurn = { prompt };
  socket.write(`${JSON.stringify({ type: 'run', prompt })}\n`);
}

function handleEvent(event) {
  if (event?.type === 'item.updated' && event.item?.type === 'agent_message') {
    if (Array.isArray(event.item.delta?.content)) {
      const text = event.item.delta.content.map((c) => c.text ?? '').join('');
      if (text) process.stdout.write(text);
    } else if (typeof event.item.delta?.text === 'string') {
      process.stdout.write(event.item.delta.text);
    }
  }
}
