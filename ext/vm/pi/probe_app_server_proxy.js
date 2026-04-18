#!/usr/bin/env node

const net = require('node:net');
const readline = require('node:readline');
const { once } = require('node:events');

const tcpHost = process.env.APP_SERVER_TCP_HOST ?? '127.0.0.1';
const tcpPort = (() => {
  const raw = process.env.APP_SERVER_TCP_PORT;
  if (!raw) {
    return 9395;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 9395 : parsed;
})();
const proxyToken = process.env.APP_SERVER_PROXY_TOKEN ?? '';
const connectTimeoutMs = (() => {
  const raw = process.env.APP_SERVER_CONNECT_TIMEOUT_MS;
  if (!raw) {
    return 5000;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 5000 : parsed;
})();

const socket = net.connect({ host: tcpHost, port: tcpPort });
socket.setKeepAlive(true);
socket.setTimeout(connectTimeoutMs, () => {
  socket.destroy(new Error(`Connection timed out after ${connectTimeoutMs}ms`));
});

socket.on('error', (error) => {
  console.error(`TCP connection error: ${error.message}`);
  process.exit(1);
});

const rl = readline.createInterface({ input: socket });
let nextId = 1;
const pending = new Map();

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error(`Received non-JSON line from app-server: ${line}`);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    const waiter = pending.get(message.id);
    if (!waiter) {
      return;
    }
    pending.delete(message.id);
    if (Object.prototype.hasOwnProperty.call(message, 'error')) {
      waiter.reject(new Error(`JSON-RPC error for id ${message.id}: ${JSON.stringify(message.error)}`));
      return;
    }
    waiter.resolve(message.result);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  socket.write(`${JSON.stringify({ method, params, id })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function notify(method, params = {}) {
  socket.write(`${JSON.stringify({ method, params })}\n`);
}

function shutdown(code = 0) {
  rl.close();
  socket.end();
  process.exit(code);
}

async function main() {
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ type: 'auth', token: proxyToken })}\n`);

  const initializeResult = await request('initialize', {
    clientInfo: {
      name: 'firecracker-vm-smoke',
      title: 'Firecracker VM app-server smoke probe',
      version: '0.0.1',
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  notify('initialized');

  const [authStatus, configRead, modelList] = await Promise.all([
    request('getAuthStatus', { includeToken: false, refreshToken: false }),
    request('config/read', { includeLayers: false, cwd: null }),
    request('model/list', { cursor: null, limit: 10 }),
  ]);

  const userAgent = initializeResult?.userAgent ?? '(missing)';
  const authMethod = authStatus?.authMethod ?? '(unknown)';
  const requiresAuth = authStatus?.requiresOpenaiAuth ?? '(unknown)';
  const sandboxMode = configRead?.config?.sandbox_mode ?? '(unknown)';
  const modelCount = Array.isArray(modelList?.data) ? modelList.data.length : 0;

  console.log('App server protocol smoke test passed.');
  console.log(`Proxy endpoint: ${tcpHost}:${tcpPort}`);
  console.log(`User agent: ${userAgent}`);
  console.log(`Auth method: ${authMethod}`);
  console.log(`Requires OpenAI auth: ${requiresAuth}`);
  console.log(`Sandbox mode: ${sandboxMode}`);
  console.log(`Models returned: ${modelCount}`);

  shutdown(0);
}

main().catch((error) => {
  console.error(`App server protocol smoke test failed: ${error.message}`);
  shutdown(1);
});
