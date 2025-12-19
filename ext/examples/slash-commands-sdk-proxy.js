#!/usr/bin/env node
/**
 * Slash command client (SDK proxy)
 * --------------------------------
 * Lightweight interactive client that runs turns through the SDK proxy over
 * TCP while delegating slash command behavior (/status, /model) to the app
 * server protocol for parity with the standalone Codex UX.
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
 * - APP_SERVER_TCP_HOST / APP_SERVER_TCP_PORT (optional): host/port for the
 *   app-server proxy used by /status and /model. Set these when the app-server
 *   proxy is running; otherwise /status and /model will prompt for setup.
 * - APP_SERVER_IN / APP_SERVER_OUT (optional): FIFO paths for app-server I/O.
 * - CODEX_AUTH_PATH (optional): override ~/.codex/auth.json for auth.
 * - CODEX_API_KEY / OPENAI_API_KEY (optional): API key to forward.
 * - CODEX_BASE_URL / OPENAI_BASE_URL (optional): custom API base URL to forward.
 */

const fs = require('node:fs');
const { once } = require('node:events');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const host = process.env.SDK_PROXY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;

const { envOverrides, codexOptions, authJson } = buildConnectionOptions();

const statusCommand = require(path.join(__dirname, 'slash-commands', 'status.js'));
const modelCommand = require(path.join(__dirname, 'slash-commands', 'model.js'));

const socket = net.connect({ host, port });
socket.setKeepAlive(true);

const socketLines = readline.createInterface({ input: socket });
const userInput = readline.createInterface({ input: process.stdin, output: process.stdout });

let activeRun = false;
let activeThreadId = null;
let agentText = '';

let appServerState = null;

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
  if (appServerState) {
    appServerState.shutdown();
    appServerState = null;
  }
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

function printMenu() {
  console.log('\nAvailable commands:');
  console.log('  /status  - show current session details (via app-server)');
  console.log('  /model   - list/update models (via app-server)');
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
  const appServer = await ensureAppServer();
  if (!appServer) {
    return;
  }
  await statusCommand.run({ request: appServer.request, connectionMode: appServer.connectionMode });
}

async function runModel() {
  const appServer = await ensureAppServer();
  if (!appServer) {
    return;
  }
  await modelCommand.run({
    request: appServer.request,
    askYesNo,
    askInput,
  });
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

async function ensureAppServer() {
  if (appServerState?.ready) {
    return appServerState;
  }

  const fifoInPath = process.env.APP_SERVER_IN;
  const fifoOutPath = process.env.APP_SERVER_OUT;
  const tcpHostEnv = process.env.APP_SERVER_TCP_HOST;
  const tcpHost = process.env.APP_SERVER_TCP_HOST ?? '127.0.0.1';
  const tcpPortEnv = process.env.APP_SERVER_TCP_PORT;
  if (!fifoInPath && !fifoOutPath && !tcpHostEnv && !tcpPortEnv) {
    console.log('');
    console.log('App-server proxy is required for /status and /model.');
    console.log('Start codex-app-server-proxy and set APP_SERVER_TCP_HOST/PORT,');
    console.log('or set APP_SERVER_IN/APP_SERVER_OUT for FIFO mode.');
    console.log('');
    return null;
  }
  const tcpPort = (() => {
    if (!tcpPortEnv) {
      return 9395;
    }
    const parsed = Number.parseInt(tcpPortEnv, 10);
    return Number.isNaN(parsed) ? 9395 : parsed;
  })();

  let serverInput;
  let serverOutput;
  let appSocket = null;

  if (!fifoInPath && !fifoOutPath) {
    appSocket = net.connect({ host: tcpHost, port: tcpPort });
    appSocket.setKeepAlive(true);
    serverInput = appSocket;
    serverOutput = appSocket;

    appSocket.on('error', (error) => {
      console.error('App-server TCP connection error:', error);
    });
  } else {
    const serverInPath = fifoInPath ?? '/tmp/codex-app-server.in';
    const serverOutPath = fifoOutPath ?? '/tmp/codex-app-server.out';
    serverInput = fs.createWriteStream(serverInPath, { flags: 'a' });
    serverOutput = fs.createReadStream(serverOutPath, { encoding: 'utf8' });
  }

  let nextRequestId = 1;
  const pendingRequests = new Map();

  const serverLines = readline.createInterface({ input: serverOutput });
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
      const resolver = pendingRequests.get(message.id);
      if (resolver) {
        pendingRequests.delete(message.id);
        resolver.resolve(message.result ?? message.error);
      } else {
        console.warn('Unmatched app-server response', message);
      }
      return;
    }

    if (message.method) {
      console.log('Notification', message.method, message.params ?? {});
    }
  });

  const request = (method, params = {}) => {
    const id = nextRequestId++;
    const payload = { method, params, id };
    serverInput.write(`${JSON.stringify(payload)}\n`);

    return new Promise((resolve) => {
      pendingRequests.set(id, { resolve });
    });
  };

  const notify = (method, params = {}) => {
    serverInput.write(`${JSON.stringify({ method, params })}\n`);
  };

  const shutdownAppServer = () => {
    serverLines.close();
    serverInput.end();
    if (appSocket) {
      appSocket.end();
    }
  };

  if (appSocket) {
    await once(appSocket, 'connect');
  } else {
    await Promise.all([once(serverInput, 'open'), once(serverOutput, 'open')]);
  }

  await request('initialize', {
    clientInfo: {
      name: 'ext-example',
      title: 'Slash command client example (SDK proxy)',
      version: '0.0.1',
    },
  });
  notify('initialized');

  appServerState = {
    ready: true,
    request,
    notify,
    connectionMode: appSocket ? 'tcp' : 'fifo',
    shutdown: shutdownAppServer,
  };

  return appServerState;
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
