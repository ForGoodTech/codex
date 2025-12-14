#!/usr/bin/env node
/**
 * Codex SDK TCP proxy (ext/docker/pi/sdk-proxy.js)
 *
 * What this does
 * --------------
 * - Listens on a single TCP port and accepts one client at a time.
 * - For each JSON request from the client, spawns `codex exec --experimental-json` inside the container,
 *   forwards stdin, and streams stdout/stderr/exit events back as JSONL.
 * - Keeps the proxy alive between client disconnects so you can reconnect without rebuilding state.
 *
 * Intended flow
 * -------------
 * - Run this proxy inside the container where the `codex` binary is on PATH (the image links it into npm-global/bin).
 * - Publish the proxy port to the host when starting the container, e.g.:
 *     docker run -it --rm -p 9396:9396 my-codex-docker-image /bin/bash
 * - Start the proxy inside the container (either path works):
 *     codex-sdk-proxy
 *   or
 *     node ~/sdk-proxy.js
 * - On the host, point sdk-proxy clients at the published port using SDK_PROXY_TCP_HOST/PORT.
 *
 * Protocol
 * --------
 * - Single-client TCP bridge; additional connections are rejected until the active client disconnects.
 * - Client sends newline-delimited JSON commands. Supported commands:
 *   - {"type":"run","input":"...","args":["--model","some-model"],"env":{"CODEX_API_KEY":"..."}}
 *     * `args` are appended after the default ["exec", "--experimental-json"] sequence.
 *     * `env` entries are passed to the spawned codex process in addition to the proxy's own env.
 *   - {"type":"shutdown"} closes the connection.
 * - Proxy responds with newline-delimited JSON events:
 *   - {"event":"stdout","line":"..."}
 *   - {"event":"stderr","line":"..."}
 *   - {"event":"exit","code":0,"signal":null}
 *   - {"event":"error","message":"..."}
 */

const net = require('node:net');
const { spawn } = require('node:child_process');

const host = process.env.SDK_PROXY_HOST ?? '0.0.0.0';
const defaultPort = 9396;
const port = (() => {
  const raw = process.env.SDK_PROXY_PORT;
  if (!raw) {
    return defaultPort;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`Ignoring invalid SDK_PROXY_PORT value (${raw}); using ${defaultPort}.`);
    return defaultPort;
  }

  return parsed;
})();

const defaultCmd = 'codex';
const codexCmd = process.env.SDK_PROXY_CMD?.trim() || defaultCmd;
const codexArgs = process.env.SDK_PROXY_ARGS?.split(' ').filter((arg) => arg.length > 0) ?? [];

let activeSocket = null;
let activeChild = null;

const server = net.createServer((socket) => {
  if (activeSocket) {
    socket.destroy(new Error('Proxy already has an active client; try again later.'));
    return;
  }

  console.log(`Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
  activeSocket = socket;
  socket.setKeepAlive(true);

  let buffer = '';

  const send = (payload) => {
    if (socket.writable) {
      socket.write(`${JSON.stringify(payload)}\n`);
    }
  };

  const teardownChild = () => {
    if (activeChild) {
      activeChild.removeAllListeners();
      activeChild.stdout?.removeAllListeners();
      activeChild.stderr?.removeAllListeners();
      if (!activeChild.killed) {
        activeChild.kill('SIGINT');
      }
      activeChild = null;
    }
  };

  const teardownSocket = () => {
    teardownChild();
    if (activeSocket) {
      activeSocket.destroy();
      activeSocket = null;
      console.log('Client disconnected; proxy is idle and ready for the next connection.');
    }
  };

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
        send({ event: 'error', message: `Invalid JSON: ${error.message}` });
        continue;
      }

      if (message.type === 'shutdown') {
        teardownSocket();
        return;
      }

      if (message.type !== 'run') {
        send({ event: 'error', message: `Unsupported command type: ${message.type}` });
        continue;
      }

      if (activeChild) {
        send({ event: 'error', message: 'A codex run is already in progress.' });
        continue;
      }

      const { input, args = [], env = {} } = message;
      if (typeof input !== 'string') {
        send({ event: 'error', message: 'run.input must be a string.' });
        continue;
      }

      const fullArgs = ['exec', '--experimental-json', ...codexArgs, ...args];
      console.log(`Spawning ${codexCmd} ${fullArgs.join(' ')}`);
      activeChild = spawn(codexCmd, fullArgs, {
        env: { ...process.env, ...env },
      });

      if (!activeChild.stdin) {
        send({ event: 'error', message: 'Failed to open stdin for codex process.' });
        teardownChild();
        continue;
      }

      activeChild.stdin.write(input);
      activeChild.stdin.end();

      if (activeChild.stdout) {
        activeChild.stdout.on('data', (data) => {
          const lines = data.toString('utf8').split(/\r?\n/);
          for (const lineChunk of lines) {
            if (lineChunk.length === 0) {
              continue;
            }
            send({ event: 'stdout', line: lineChunk });
          }
        });
      }

      if (activeChild.stderr) {
        activeChild.stderr.on('data', (data) => {
          const lines = data.toString('utf8').split(/\r?\n/);
          for (const lineChunk of lines) {
            if (lineChunk.length === 0) {
              continue;
            }
            send({ event: 'stderr', line: lineChunk });
          }
        });
      }

      activeChild.once('exit', (code, signal) => {
        send({ event: 'exit', code, signal: signal ?? null });
        teardownChild();
      });

      activeChild.once('error', (error) => {
        send({ event: 'error', message: `Failed to start codex: ${error.message}` });
        teardownChild();
      });
    }
  };

  socket.on('data', onData);
  socket.on('close', teardownSocket);
  socket.on('error', teardownSocket);
});

server.listen(port, host, () => {
  console.log(`Codex SDK proxy listening on ${host}:${port}`);
});

process.on('SIGINT', () => {
  console.log('Shutting down SDK proxy...');
  server.close();
  if (activeChild && !activeChild.killed) {
    activeChild.kill('SIGINT');
  }
});
