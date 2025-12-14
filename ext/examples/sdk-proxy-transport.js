#!/usr/bin/env node
const net = require('node:net');
const { once } = require('node:events');

function parsePort(rawPort, fallback) {
  if (!rawPort) {
    return fallback;
  }

  const parsed = Number.parseInt(rawPort, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

function isSdkProxyEnabled() {
  return (
    process.env.USE_SDK_PROXY === '1' ||
    process.env.SDK_PROXY_TCP_HOST !== undefined ||
    process.env.SDK_PROXY_TCP_PORT !== undefined
  );
}

function connectSdkProxy(options = {}) {
  const host = options.host ?? process.env.SDK_PROXY_TCP_HOST ?? '127.0.0.1';
  const port = options.port ?? parsePort(process.env.SDK_PROXY_TCP_PORT, 9396);
  const defaultArgs = options.defaultArgs ?? process.env.SDK_PROXY_ARGS?.split(' ').filter(Boolean) ?? [];
  const baseEnv = { ...options.env };
  if (process.env.SDK_PROXY_API_KEY) {
    baseEnv.CODEX_API_KEY = process.env.SDK_PROXY_API_KEY;
  }

  let buffer = '';
  let inFlight = false;

  const socket = net.connect({ host, port });
  socket.setKeepAlive(true);

  socket.on('error', (error) => {
    console.error('SDK proxy socket error:', error);
  });

  async function ready() {
    await once(socket, 'connect');
  }

  function run({ input, args = [], env = {}, onStdout = () => {}, onStderr = () => {} }) {
    if (inFlight) {
      return Promise.reject(new Error('A Codex run is already in progress; wait for it to finish.'));
    }

    inFlight = true;
    const payload = {
      type: 'run',
      input,
      args: [...defaultArgs, ...args],
      env: { ...baseEnv, ...env },
    };

    return new Promise((resolve, reject) => {
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }

          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            console.error('Received non-JSON line from sdk-proxy:', line);
            continue;
          }

          switch (message.event) {
            case 'stdout':
              onStdout(message.line ?? '');
              break;
            case 'stderr':
              onStderr(message.line ?? '');
              break;
            case 'error':
              cleanup();
              reject(new Error(message.message ?? 'Unknown proxy error'));
              return;
            case 'exit':
              cleanup();
              resolve(message);
              return;
            default:
              console.log('Unknown proxy event:', message);
          }
        }
      };

      const onError = (error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        socket.off('data', onData);
        socket.off('error', onError);
        inFlight = false;
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  }

  function close() {
    socket.end();
  }

  return {
    host,
    port,
    defaultArgs,
    ready,
    run,
    close,
  };
}

module.exports = {
  isSdkProxyEnabled,
  connectSdkProxy,
};
