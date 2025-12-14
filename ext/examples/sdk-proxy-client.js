#!/usr/bin/env node
/**
 * SDK proxy client (ext/examples/sdk-proxy-client.js)
 *
 * What this shows
 * ---------------
 * - Connects to the in-container codex-sdk-proxy over TCP.
 * - Sends one run request containing user input and optional CLI args.
 * - Streams stdout/stderr/exit events from the proxy.
 *
 * How to run (proxy inside Docker container)
 * -----------------------------------------
 * - In the container, launch the proxy (spawns `codex exec --experimental-json` on port 9396 by default):
 *     codex-sdk-proxy
 * - Publish the proxy port to the host when starting the container, e.g.:
 *     docker run -it --rm -p 9396:9396 my-codex-docker-image /bin/bash
 * - From the host, connect to the forwarded TCP endpoint (defaults to 127.0.0.1:9396 so no env vars are required):
 *     node ext/examples/sdk-proxy-client.js "Describe the repository."
 *
 * Environment variables
 * ---------------------
 * - SDK_PROXY_TCP_HOST (optional): TCP host for the proxy. Defaults to 127.0.0.1.
 * - SDK_PROXY_TCP_PORT (optional): TCP port for the proxy. Defaults to 9396.
 * - SDK_PROXY_ARGS      (optional): Extra CLI args appended after ["exec", "--experimental-json"].
 * - SDK_PROXY_API_KEY   (optional): API key to pass through to Codex via the proxy.
 */

const net = require('node:net');

const tcpHost = process.env.SDK_PROXY_TCP_HOST ?? '127.0.0.1';
const tcpPortEnv = process.env.SDK_PROXY_TCP_PORT;
const tcpPort = (() => {
  if (!tcpPortEnv) {
    return 9396;
  }

  const parsed = Number.parseInt(tcpPortEnv, 10);
  return Number.isNaN(parsed) ? 9396 : parsed;
})();

const prompt = process.argv[2] ?? 'Describe the repository.';

const socket = net.connect({ host: tcpHost, port: tcpPort });
socket.setKeepAlive(true);

socket.on('connect', () => {
  console.log(`Connected to codex-sdk-proxy at ${tcpHost}:${tcpPort}`);
  const args = process.env.SDK_PROXY_ARGS?.split(' ').filter((arg) => arg.length > 0) ?? [];
  const env = {};
  if (process.env.SDK_PROXY_API_KEY) {
    env.CODEX_API_KEY = process.env.SDK_PROXY_API_KEY;
  }

  const payload = {
    type: 'run',
    input: prompt,
    args,
    env,
  };

  socket.write(`${JSON.stringify(payload)}\n`);
});

let buffer = '';

socket.on('data', (chunk) => {
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
      console.error('Received non-JSON line from proxy:', line);
      continue;
    }

    switch (message.event) {
      case 'stdout':
        console.log(message.line);
        break;
      case 'stderr':
        console.error('[codex stderr]', message.line);
        break;
      case 'exit':
        console.log(`Codex exited (code=${message.code}, signal=${message.signal ?? 'none'})`);
        socket.end();
        break;
      case 'error':
        console.error('Proxy error:', message.message);
        break;
      default:
        console.log('Unknown proxy event:', message);
    }
  }
});

socket.on('error', (error) => {
  console.error('TCP connection error:', error);
});
