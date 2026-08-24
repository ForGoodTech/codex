'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { formatAppSurfaceMessageLengthLog, utf8MessageLength } = require('./app-surface-transport-log.js');

test('formats UTC app-surface transport length logs', () => {
  assert.equal(
    formatAppSurfaceMessageLengthLog(
      'runtime-proxy.gateway-tcp.send.app.surface.html',
      1234,
      new Date('2026-08-23T10:34:56.789Z'),
    ),
    '2026-08-23T10:34:56.789Z - surestinfo.app-surface.runtime-proxy.gateway-tcp.send.app.surface.html - 1234 bytes',
  );
});

test('uses UTF-8 bytes and sanitizes invalid fields', () => {
  assert.equal(utf8MessageLength('Héllo'), 6);
  assert.equal(
    formatAppSurfaceMessageLengthLog('\nchild.file-write\r', -1, new Date(0)),
    '1970-01-01T00:00:00.000Z - surestinfo.app-surface.child.file-write - 0 bytes',
  );
});
