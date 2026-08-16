'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const REFRESH_REQUEST_METHOD = 'surestinfo/cliAuth/refresh';
const REVOKE_REQUEST_METHOD = 'surestinfo/cliAuth/revoke';
const RESPONSE_METHOD = 'surestinfo/cliAuth/response';
const LEASE_PREFIX = 'gwlease_';

function prepareCliAuthProjection({
  enabled,
  projectionPath = process.env.APP_SERVER_CLI_AUTH_PROJECTION_PATH,
  authPath = path.join(
    process.env.CODEX_HOME || path.join(process.env.HOME || '/home/node', '.codex'),
    'auth.json',
  ),
} = {}) {
  if (!enabled) {
    return null;
  }
  const source = path.resolve((projectionPath ?? '').toString().trim());
  const target = path.resolve((authPath ?? '').toString().trim());
  if (!projectionPath || !authPath) {
    throw new Error('runtime CLI auth projection and target paths are required');
  }
  const sourceInfo = fs.statSync(source);
  if (!sourceInfo.isFile()) {
    throw new Error(`runtime CLI auth projection is not a file: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const targetInfo = fs.lstatSync(target);
    if (
      targetInfo.isSymbolicLink() &&
      path.resolve(path.dirname(target), fs.readlinkSync(target)) === source
    ) {
      return target;
    }
    if (targetInfo.isDirectory()) {
      throw new Error(`runtime CLI auth target is a directory: ${target}`);
    }
    fs.unlinkSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  fs.symlinkSync(source, target);
  return target;
}

function createCliAuthBroker({
  enabled = false,
  host = '127.0.0.1',
  port = 9396,
  maxBodyBytes = 64 * 1024,
  maxPendingRequests = 64,
  requestTimeoutMs = 12_000,
  sendGatewayNotification,
} = {}) {
  let server = null;
  const pending = new Map();

  function rejectPending(message) {
    for (const [requestId, entry] of pending.entries()) {
      pending.delete(requestId);
      clearTimeout(entry.timeout);
      entry.reject(brokerError('gateway_unavailable', message));
    }
  }

  function forwardToGateway(method, body) {
    if (typeof sendGatewayNotification !== 'function') {
      return Promise.reject(
        brokerError('gateway_unavailable', 'Gateway connection is unavailable.'),
      );
    }
    if (pending.size >= maxPendingRequests) {
      return Promise.reject(brokerError('broker_busy', 'Runtime CLI auth broker is busy.'));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(brokerError('gateway_timeout', 'Gateway auth request timed out.'));
      }, requestTimeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      try {
        sendGatewayNotification(method, { requestId, body });
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(timeout);
        reject(
          brokerError(
            'gateway_unavailable',
            error?.message || 'Gateway connection is unavailable.',
          ),
        );
      }
    });
  }

  function handleGatewayFrame(frame) {
    if (!frame || frame.method !== RESPONSE_METHOD) {
      return false;
    }
    const requestId = typeof frame.params?.requestId === 'string' ? frame.params.requestId : '';
    const entry = pending.get(requestId);
    if (!entry) {
      return true;
    }
    pending.delete(requestId);
    clearTimeout(entry.timeout);
    const status = Number.isInteger(frame.params?.status) ? frame.params.status : 502;
    entry.resolve({ status, body: frame.params?.body ?? {} });
    return true;
  }

  function handleGatewayDisconnect() {
    rejectPending('Gateway connection closed during the auth request.');
  }

  async function handleRequest(request, response) {
    if (request.method !== 'POST') {
      sendJSON(response, 405, oauthError('invalid_request', 'Only POST is supported.'), {
        Allow: 'POST',
      });
      return;
    }
    let method;
    if (request.url === '/oauth/token') {
      method = REFRESH_REQUEST_METHOD;
    } else if (request.url === '/oauth/revoke') {
      method = REVOKE_REQUEST_METHOD;
    } else {
      sendJSON(response, 404, oauthError('invalid_request', 'Unknown OAuth endpoint.'));
      return;
    }

    let body;
    try {
      body = await readJSONBody(request, maxBodyBytes);
      validateOAuthRequest(method, body);
    } catch (error) {
      const status = error?.code === 'body_too_large' ? 413 : 400;
      sendJSON(
        response,
        status,
        oauthError(error?.code || 'invalid_request', error?.message || 'Invalid request.'),
      );
      return;
    }

    try {
      const result = await forwardToGateway(method, body);
      sendJSON(response, result.status, result.body);
    } catch (error) {
      const status =
        error?.code === 'gateway_timeout' ? 504 : error?.code === 'broker_busy' ? 429 : 503;
      sendJSON(
        response,
        status,
        oauthError(
          error?.code || 'gateway_unavailable',
          error?.message || 'Gateway connection is unavailable.',
        ),
      );
    }
  }

  function start() {
    if (!enabled) {
      return Promise.resolve(null);
    }
    if (server) {
      return Promise.resolve(server.address());
    }
    server = http.createServer((request, response) => {
      void handleRequest(request, response);
    });
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server = null;
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        server.on('error', (error) => {
          console.error('Runtime CLI auth broker error:', error?.message ?? error);
        });
        resolve(server.address());
      });
    });
  }

  function close() {
    rejectPending('Runtime CLI auth broker stopped.');
    if (!server) {
      return Promise.resolve();
    }
    const closingServer = server;
    server = null;
    return new Promise((resolve) => closingServer.close(resolve));
  }

  return {
    close,
    handleGatewayDisconnect,
    handleGatewayFrame,
    start,
  };
}

async function readJSONBody(request, maxBodyBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      const error = new Error('OAuth request body is too large.');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw brokerError('invalid_request', 'OAuth request body is required.');
  }
  const body = JSON.parse(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw brokerError('invalid_request', 'OAuth request body must be a JSON object.');
  }
  return body;
}

function validateOAuthRequest(method, body) {
  if (method === REFRESH_REQUEST_METHOD) {
    if (body.grant_type !== 'refresh_token' || typeof body.client_id !== 'string') {
      throw brokerError('invalid_request', 'Unsupported OAuth refresh request.');
    }
    if (typeof body.refresh_token !== 'string' || !body.refresh_token.startsWith(LEASE_PREFIX)) {
      throw brokerError('refresh_token_invalidated', 'Runtime credential lease is invalid.');
    }
    return;
  }
  if (
    body.token_type_hint !== 'refresh_token' ||
    typeof body.client_id !== 'string' ||
    typeof body.token !== 'string' ||
    !body.token.startsWith(LEASE_PREFIX)
  ) {
    throw brokerError('invalid_request', 'Unsupported OAuth revoke request.');
  }
}

function sendJSON(response, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? {});
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function oauthError(code, message) {
  return { error: { code, message } };
}

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  REFRESH_REQUEST_METHOD,
  RESPONSE_METHOD,
  REVOKE_REQUEST_METHOD,
  createCliAuthBroker,
  prepareCliAuthProjection,
};
