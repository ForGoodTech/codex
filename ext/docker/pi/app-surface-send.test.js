'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildIpcRequest, extractGlobalOptions } = require('./app-surface-send.js');

test('builds a state query without publishing a frame', () => {
  assert.deepEqual(buildIpcRequest('state', ['--full'], {}), {
    op: 'state.get',
    includeContent: true,
  });
});

test('adds source and optimistic revision to publications', () => {
  const args = ['media', 'side', '--source', 'cli', '--if-revision', '7'];
  const options = extractGlobalOptions(args);
  const command = args.shift();

  assert.deepEqual(buildIpcRequest(command, args, options), {
    op: 'surface.publish',
    source: 'cli',
    expectedRevision: 7,
    notification: {
      method: 'app.surface.media',
      params: { media: { mode: 'side', visible: true } },
    },
  });
});
