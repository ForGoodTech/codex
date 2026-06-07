#!/usr/bin/env node
/**
 * Send one app-surface notification from inside the Codex runtime container.
 *
 * The long-running codex-app-server-proxy owns the gateway TCP connection. This
 * helper writes a single JSON payload to the proxy's local Unix socket; the proxy
 * then forwards it as an app.surface.* JSON-RPC notification to the gateway.
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const appSurfaceFrameMethod = 'app.surface.frame';
const defaultSocketPath =
  process.env.APP_SERVER_APP_SURFACE_IPC_SOCKET?.trim() ||
  path.join(os.tmpdir(), 'codex-app-surface.sock');
const sendTimeoutMs = (() => {
  const raw = process.env.APP_SERVER_APP_SURFACE_SEND_TIMEOUT_MS;
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
})();

function usage() {
  console.error(`Usage:
  codex-app-surface-send frame <json-or-file>
  codex-app-surface-send html <html-or-file> [--title <title>] [--css <css-or-file>] [--script <js-or-file>]
  codex-app-surface-send media <overlay|side|background|hidden>
  codex-app-surface-send status <message>
  codex-app-surface-send clear
  codex-app-surface-send raw <json-or-file>

Options:
  --socket <path>  Override the proxy IPC socket path.

Examples:
  codex-app-surface-send media side
  codex-app-surface-send frame '{"type":"app.surface.html","title":"Clock","html":"<main>...</main>"}'
  codex-app-surface-send html /tmp/clock.html --title Clock --css /tmp/clock.css --script /tmp/clock.js`);
}

function normalizeAppSurfaceMethod(value) {
  let method = (value ?? '').toString().trim().toLowerCase();
  method = method.replace(/[/_]+/g, '.');
  while (method.includes('..')) {
    method = method.replace(/\.\.+/g, '.');
  }
  return method.replace(/^\.+|\.+$/g, '');
}

function isAppSurfaceMethod(value) {
  const method = normalizeAppSurfaceMethod(value);
  return method === appSurfaceFrameMethod || method.startsWith('app.surface.');
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function readValue(value) {
  if (value === '-') {
    return readStdin();
  }
  if (value && fs.existsSync(value) && fs.statSync(value).isFile()) {
    return fs.readFileSync(value, 'utf8');
  }
  return value ?? '';
}

function readJson(value) {
  const raw = readValue(value).trim();
  if (!raw) {
    throw new Error('expected a JSON payload');
  }
  return JSON.parse(raw);
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  if (index === args.length - 1) {
    throw new Error(`${name} requires a value`);
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function extractGlobalOptions(args) {
  let socketPath = defaultSocketPath;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--socket') {
      if (i === args.length - 1) {
        throw new Error('--socket requires a value');
      }
      socketPath = args[i + 1];
      args.splice(i, 2);
      i -= 1;
    }
  }
  return { socketPath };
}

function notificationFromFrame(frame) {
  if (frame && typeof frame === 'object' && !Array.isArray(frame) && typeof frame.method === 'string') {
    if (!isAppSurfaceMethod(frame.method)) {
      throw new Error(`refusing to send non app-surface method: ${frame.method}`);
    }
    return frame;
  }
  return {
    method: appSurfaceFrameMethod,
    params: frame,
  };
}

function buildNotification(command, args) {
  switch (command) {
    case 'raw':
    case 'send':
    case 'notification': {
      if (args.length < 1) {
        throw new Error(`${command} requires a JSON payload or file`);
      }
      const payload = readJson(args[0]);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('raw payload must be a JSON object');
      }
      if (typeof payload.method === 'string' && !isAppSurfaceMethod(payload.method)) {
        throw new Error(`refusing to send non app-surface method: ${payload.method}`);
      }
      return payload;
    }
    case 'frame': {
      if (args.length < 1) {
        throw new Error('frame requires a JSON payload or file');
      }
      return notificationFromFrame(readJson(args[0]));
    }
    case 'html':
    case 'document': {
      const title = takeOption(args, '--title');
      const css = takeOption(args, '--css');
      const script = takeOption(args, '--script');
      if (args.length < 1) {
        throw new Error(`${command} requires HTML text, a file path, or - for stdin`);
      }
      const params = {
        html: readValue(args[0]),
      };
      if (title !== undefined) {
        params.title = title;
      }
      if (css !== undefined) {
        params.css = readValue(css);
      }
      if (script !== undefined) {
        params.script = readValue(script);
      }
      return {
        method: 'app.surface.html',
        params,
      };
    }
    case 'media': {
      const mode = normalizeAppSurfaceMethod(args[0] || 'overlay');
      return {
        method: 'app.surface.media',
        params: {
          media: {
            mode,
            visible: mode !== 'hidden',
          },
        },
      };
    }
    case 'status': {
      return {
        method: 'app.surface.status',
        params: {
          status: args.join(' ').trim(),
        },
      };
    }
    case 'clear':
      return {
        method: 'app.surface.clear',
        params: {},
      };
    default:
      throw new Error(`unknown command: ${command || '<empty>'}`);
  }
}

function sendNotification(socketPath, notification) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    let response = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      client.destroy();
      fn(value);
    };

    client.setEncoding('utf8');
    client.setTimeout(sendTimeoutMs);
    client.on('connect', () => {
      client.end(JSON.stringify(notification));
    });
    client.on('data', (chunk) => {
      response += chunk;
    });
    client.on('timeout', () => {
      settle(reject, new Error(`timed out after ${sendTimeoutMs}ms waiting for app-surface IPC response`));
    });
    client.on('error', (error) => {
      settle(reject, error);
    });
    client.on('end', () => {
      try {
        const parsed = response.trim() ? JSON.parse(response.trim()) : {};
        if (parsed.ok) {
          settle(resolve, parsed);
          return;
        }
        settle(reject, new Error(parsed.error || 'app-surface IPC send failed'));
      } catch (error) {
        settle(reject, error);
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const { socketPath } = extractGlobalOptions(args);
  const command = args.shift();
  const notification = buildNotification(command, args);
  await sendNotification(socketPath, notification);
  console.log(`App surface notification sent: ${normalizeAppSurfaceMethod(notification.method || appSurfaceFrameMethod)}`);
}

main().catch((error) => {
  console.error(`codex-app-surface-send: ${error?.message ?? error}`);
  process.exit(1);
});
