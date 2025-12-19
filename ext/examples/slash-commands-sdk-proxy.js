#!/usr/bin/env node
/**
 * Slash command client (SDK proxy)
 * --------------------------------
 * Lightweight interactive client that mimics a subset of Codex slash commands
 * while talking to the SDK proxy over TCP. Unlike the app-server protocol, the
 * SDK proxy only supports running turns, so the slash commands here reflect
 * local client state (model options, sandbox mode, etc.) rather than server
 * configuration.
 *
 * How to run (SDK proxy inside Docker container)
 * ----------------------------------------------
 * - In the container, start the SDK proxy:
 *      codex-sdk-proxy
 * - Publish the proxy port to the host when starting the container, e.g.:
 *      docker run -it --rm -p 9400:9400 my-codex-docker-image /bin/bash
 * - From the host, connect to the forwarded TCP endpoint (defaults to
 *   127.0.0.1:9400 so no env vars are required):
 *      node ext/examples/slash-commands-sdk-proxy.js
 *
 * Environment variables
 * ---------------------
 * - SDK_PROXY_HOST (optional): TCP host for the proxy. Defaults to 127.0.0.1.
 * - SDK_PROXY_PORT (optional): TCP port for the proxy. Defaults to 9400.
 * - CODEX_AUTH_PATH (optional): override ~/.codex/auth.json for auth.
 * - CODEX_API_KEY / OPENAI_API_KEY (optional): API key to forward.
 * - CODEX_BASE_URL / OPENAI_BASE_URL (optional): custom API base URL to forward.
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const host = process.env.SDK_PROXY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;

const { envOverrides, codexOptions, authJson } = buildConnectionOptions();

const socket = net.connect({ host, port });
socket.setKeepAlive(true);

const socketLines = readline.createInterface({ input: socket });
const userInput = readline.createInterface({ input: process.stdin, output: process.stdout });

let activeRun = false;
let activeThreadId = null;
let agentText = '';
let nextId = 1;
const pending = new Map();

socket.on('connect', () => {
  console.log(`Connected to sdk-proxy at ${host}:${port}`);
  printMenu();
});

socket.on('error', (error) => {
  console.error('Socket error:', error);
});

socket.on('close', () => {
  console.log('Disconnected from sdk-proxy.');
  userInput.close();
});

socketLines.on('line', (line) => {
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
      console.log('SDK proxy ready.');
      if (message.proxyVersion || message.sdkVersion || message.cliVersion) {
        console.log(
          `Versions: proxy ${message.proxyVersion ?? 'unknown'}, sdk ${message.sdkVersion ?? 'unknown'}, cli ${
            message.cliVersion ?? 'unknown'
          }`,
        );
      }
      break;
    case 'pong':
      console.log(`Pong received at ${message.at ?? '(unknown time)'}.`);
      break;
    case 'status': {
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver.resolve(message);
      }
      break;
    }
    case 'event':
      handleEvent(message.event);
      break;
    case 'done':
      activeRun = false;
      activeThreadId = message.threadId ?? activeThreadId;
      if (activeThreadId) {
        console.log(`\nTurn completed. Thread id: ${activeThreadId}`);
      } else {
        console.log('\nTurn completed.');
      }
      break;
    case 'aborted':
      activeRun = false;
      console.log('\nTurn aborted.');
      break;
    case 'error':
      activeRun = false;
      console.error('proxy -> error', message.message);
      break;
    default:
      break;
  }
});

function shutdown() {
  socketLines.close();
  userInput.close();
  socket.end();
}

function sendRun(prompt) {
  if (activeRun) {
    console.log('A turn is already running. Wait for it to finish or use /abort.');
    return;
  }

  if (!prompt) {
    console.log('Prompt cannot be empty.');
    return;
  }

  activeRun = true;
  agentText = '';

  socket.write(
    `${JSON.stringify({
      type: 'run',
      prompt,
      options: codexOptions,
      env: envOverrides,
      authJson,
      threadId: activeThreadId,
    })}\n`,
  );
}

function requestStatus() {
  const id = nextId++;
  const payload = { type: 'status', id };
  socket.write(`${JSON.stringify(payload)}\n`);

  return new Promise((resolve) => {
    pending.set(id, { resolve });
  });
}

function sendAbort() {
  if (!activeRun) {
    console.log('No active run to abort.');
    return;
  }
  socket.write(`${JSON.stringify({ type: 'abort' })}\n`);
}

function handleEvent(event) {
  switch (event?.type) {
    case 'turn.started':
      agentText = '';
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
    agentText += text;
    process.stdout.write(text);
  }
}

function handleAgentCompleted(item) {
  if (item?.type !== 'agent_message' || typeof item.text !== 'string') return;
  const remaining = item.text.startsWith(agentText) ? item.text.slice(agentText.length) : item.text;
  if (remaining) {
    agentText += remaining;
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

function toDisplayString(value, fallback = '(unknown)') {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    return value || fallback;
  }
  return String(value);
}

function labelLine(label, value) {
  return `${label.padEnd(17, ' ')} ${value}`;
}

function renderBox(lines) {
  const innerWidth = Math.max(...lines.map((line) => line.length));
  const horizontal = '─'.repeat(innerWidth + 2);
  const top = `╭${horizontal}╮`;
  const bottom = `╰${horizontal}╯`;
  const body = lines.map((line) => `│ ${line.padEnd(innerWidth, ' ')} │`);
  return [top, ...body, bottom].join('\n');
}

function printMenu() {
  console.log('\nAvailable commands:');
  console.log('  /status  - show current client configuration');
  console.log('  /model   - update model and reasoning effort for future turns');
  console.log('  /ping    - send a ping to the SDK proxy');
  console.log('  /abort   - abort the current turn');
  console.log('  /help    - show this help');
  console.log('  /quit    - exit client');
  console.log('  /exit    - exit client');
  console.log('  <text>   - run a prompt with the current settings');
}

async function askInput(question) {
  return new Promise((resolve) => {
    userInput.question(question, (answerRaw) => {
      resolve(answerRaw.trim());
    });
  });
}

async function runStatus() {
  const proxyStatus = await requestStatus();
  const lines = [];
  lines.push(' >_ OpenAI Codex (SDK proxy example)');
  lines.push('');
  lines.push(labelLine('Proxy version:', toDisplayString(proxyStatus?.proxyVersion, '(unknown)')));
  lines.push(labelLine('SDK version:', toDisplayString(proxyStatus?.sdkVersion, '(unknown)')));
  lines.push(labelLine('CLI version:', toDisplayString(proxyStatus?.cliVersion, '(unknown)')));
  lines.push(labelLine('Node:', toDisplayString(proxyStatus?.nodeVersion, '(unknown)')));
  lines.push(
    labelLine(
      'Proxy host:',
      toDisplayString(proxyStatus?.host ? `${proxyStatus.host}:${proxyStatus.port}` : null, '(unknown)'),
    ),
  );
  lines.push(labelLine('Model:', toDisplayString(codexOptions.model, '(default)')));
  lines.push(
    labelLine(
      'Reasoning:',
      toDisplayString(codexOptions.modelReasoningEffort, '(default)'),
    ),
  );
  lines.push(labelLine('Approval:', toDisplayString(codexOptions.approvalPolicy, '(default)')));
  lines.push(labelLine('Sandbox:', toDisplayString(codexOptions.sandboxMode, '(default)')));
  lines.push(labelLine('Directory:', toDisplayString(codexOptions.workingDirectory, '(default)')));
  lines.push(labelLine('Base URL:', toDisplayString(codexOptions.baseUrl, '(default)')));
  lines.push(labelLine('Thread:', toDisplayString(activeThreadId, '(new thread)')));
  lines.push(labelLine('Connection:', `(client) SDK proxy ${host}:${port}`));
  lines.push(labelLine('Auth JSON:', authJson ? '(client) forwarded' : '(not provided)'));
  lines.push(
    labelLine(
      'Env overrides:',
      envOverrides ? Object.keys(envOverrides).join(', ') : '(none)',
    ),
  );

  console.log(`\n/status\n\n${renderBox(lines)}\n`);
}

async function runModel(initialModel) {
  console.log(`\n/model\n`);
  console.log(`Active model: ${toDisplayString(codexOptions.model, '(default)')}`);
  console.log(
    `Reasoning effort: ${toDisplayString(codexOptions.modelReasoningEffort, '(default)')}`,
  );
  console.log('');

  const newModel =
    initialModel ?? (await askInput('Enter the model name to use (blank to cancel): '));
  if (!newModel) {
    console.log('No model change made.');
    return;
  }

  const newEffort = await askInput(
    'Enter a reasoning effort (minimal/low/medium/high, blank for default): ',
  );

  codexOptions.model = newModel;
  codexOptions.modelReasoningEffort = newEffort || undefined;

  console.log(
    `Active model updated to ${codexOptions.model}, reasoning: ${
      codexOptions.modelReasoningEffort ?? '(default)'
    }.`,
  );
}

async function runCommandLoop() {
  while (true) {
    const input = await askInput('\nEnter a slash command or prompt: ');
    if (!input) {
      continue;
    }

    if (input === '/quit' || input === '/exit') {
      console.log('Goodbye.');
      shutdown();
      return;
    }

    if (input === '/help') {
      printMenu();
      continue;
    }

    if (input === '/status') {
      await runStatus();
      continue;
    }

    if (input === '/model') {
      await runModel();
      continue;
    }

    if (input.startsWith('/model ')) {
      const modelName = input.slice('/model '.length).trim();
      await runModel(modelName || undefined);
      continue;
    }

    if (input === '/ping') {
      socket.write(`${JSON.stringify({ type: 'ping', at: new Date().toISOString() })}\n`);
      continue;
    }

    if (input === '/abort') {
      sendAbort();
      continue;
    }

    if (input.startsWith('/')) {
      console.log(`Unknown command: ${input}`);
      printMenu();
      continue;
    }

    sendRun(input);
  }
}

runCommandLoop().catch((error) => {
  console.error('Slash command client failed:', error);
  shutdown();
});

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
