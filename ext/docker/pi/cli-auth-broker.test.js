'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  REFRESH_REQUEST_METHOD,
  RESPONSE_METHOD,
  createCliAuthBroker,
  prepareCliAuthProjection,
} = require('./cli-auth-broker.js');

function postJSON(address, pathname, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: address.address,
        port: address.port,
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

test('refresh endpoint relays an opaque lease over the authenticated gateway channel', async (t) => {
  let forwarded;
  let broker;
  broker = createCliAuthBroker({
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    sendGatewayNotification(method, params) {
      forwarded = { method, params };
      setImmediate(() => {
        broker.handleGatewayFrame({
          method: RESPONSE_METHOD,
          params: {
            requestId: params.requestId,
            status: 200,
            body: {
              access_token: 'rotated-access',
              refresh_token: params.body.refresh_token,
            },
          },
        });
      });
    },
  });
  t.after(() => broker.close());
  const address = await broker.start();

  const response = await postJSON(address, '/oauth/token', {
    client_id: 'app-client',
    grant_type: 'refresh_token',
    refresh_token: 'gwlease_runtime-only',
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.access_token, 'rotated-access');
  assert.equal(response.body.refresh_token, 'gwlease_runtime-only');
  assert.equal(forwarded.method, REFRESH_REQUEST_METHOD);
  assert.equal(forwarded.params.body.refresh_token, 'gwlease_runtime-only');
});

test('refresh endpoint fails explicitly when no gateway connection is available', async (t) => {
  const broker = createCliAuthBroker({
    enabled: true,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => broker.close());
  const address = await broker.start();

  const response = await postJSON(address, '/oauth/token', {
    client_id: 'app-client',
    grant_type: 'refresh_token',
    refresh_token: 'gwlease_runtime-only',
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'gateway_unavailable');
});

test('in-flight refresh fails promptly when the gateway disconnects', async (t) => {
  let broker;
  broker = createCliAuthBroker({
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    sendGatewayNotification() {
      setImmediate(() => broker.handleGatewayDisconnect());
    },
  });
  t.after(() => broker.close());
  const address = await broker.start();

  const response = await postJSON(address, '/oauth/token', {
    client_id: 'app-client',
    grant_type: 'refresh_token',
    refresh_token: 'gwlease_runtime-only',
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'gateway_unavailable');
});

test('projection preparation exposes the mounted file at CODEX_HOME/auth.json', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-auth-projection-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const source = path.join(tempDir, 'projection', 'auth.json');
  const target = path.join(tempDir, 'codex-home', 'auth.json');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '{"tokens":{"access_token":"first"}}', {
    mode: 0o600,
  });

  prepareCliAuthProjection({
    enabled: true,
    projectionPath: source,
    authPath: target,
  });

  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"tokens":{"access_token":"first"}}');
  fs.writeFileSync(target, '{"tokens":{"access_token":"second"}}');
  assert.equal(fs.readFileSync(source, 'utf8'), '{"tokens":{"access_token":"second"}}');
});
