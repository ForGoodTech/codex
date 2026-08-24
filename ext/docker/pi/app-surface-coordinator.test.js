'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAppSurfaceCoordinator } = require('./app-surface-coordinator.js');

test('tracks materialized surface state and writer revisions', () => {
  const coordinator = createAppSurfaceCoordinator({
    now: () => new Date('2026-08-19T12:00:00.000Z'),
  });
  const forwarded = [];
  const forward = (notification) => forwarded.push(notification);

  coordinator.publish(
    {
      source: 'gateway',
      notification: {
        method: 'app.surface.html',
        params: { title: 'Detector', html: '<main>Ready</main>', script: 'start();' },
      },
    },
    forward,
  );
  coordinator.publish(
    {
      source: 'cli',
      expectedRevision: 1,
      notification: {
        method: 'app.surface.media',
        params: { media: { mode: 'side', visible: true } },
      },
    },
    forward,
  );

  assert.deepEqual(coordinator.snapshot(), {
    version: 1,
    revision: 2,
    lastUpdate: {
      source: 'cli',
      method: 'app.surface.media',
      updatedAt: '2026-08-19T12:00:00.000Z',
    },
    surface: {
      media: { mode: 'side', visible: true },
      status: null,
      document: {
        title: 'Detector',
        hasHtml: true,
        hasCss: false,
        hasScript: true,
      },
    },
  });
  assert.equal(forwarded.length, 2);
});

test('rejects a stale writer before forwarding', () => {
  const coordinator = createAppSurfaceCoordinator();
  let forwards = 0;
  const forward = () => {
    forwards += 1;
  };
  coordinator.publish(
    {
      source: 'gateway',
      notification: { method: 'app.surface.status', params: { status: 'running' } },
    },
    forward,
  );

  assert.throws(
    () =>
      coordinator.publish(
        {
          source: 'cli',
          expectedRevision: 0,
          notification: { method: 'app.surface.clear', params: {} },
        },
        forward,
      ),
    /expected revision 0, current revision 1/,
  );
  assert.equal(forwards, 1);
  assert.equal(coordinator.snapshot().revision, 1);
});

test('does not advance state when gateway forwarding fails', () => {
  const coordinator = createAppSurfaceCoordinator();

  assert.throws(
    () =>
      coordinator.publish(
        {
          source: 'gateway',
          notification: { method: 'app.surface.status', params: { status: 'running' } },
        },
        () => {
          throw new Error('gateway connection is not authenticated');
        },
      ),
    /gateway connection is not authenticated/,
  );
  assert.equal(coordinator.snapshot().revision, 0);
});

test('full state includes content while normal state stays compact', () => {
  const coordinator = createAppSurfaceCoordinator();
  coordinator.publish(
    {
      source: 'gateway',
      notification: {
        method: 'app.surface.frame',
        params: { type: 'app.surface.html', html: '<main>Hello</main>', css: 'main{}' },
      },
    },
    () => {},
  );

  assert.equal(coordinator.snapshot().surface.document.content, undefined);
  assert.deepEqual(coordinator.snapshot({ includeContent: true }).surface.document.content, {
    title: null,
    html: '<main>Hello</main>',
    css: 'main{}',
    script: null,
  });
  assert.deepEqual(coordinator.snapshot({ includeContent: true }).lastFrame, {
    type: 'app.surface.html',
    html: '<main>Hello</main>',
    css: 'main{}',
  });
});

test('clear resets document state without changing media layout', () => {
  const coordinator = createAppSurfaceCoordinator();
  const forward = () => {};
  coordinator.publish(
    {
      source: 'gateway',
      notification: { method: 'app.surface.media', params: { media: { mode: 'side' } } },
    },
    forward,
  );
  coordinator.publish(
    {
      source: 'gateway',
      notification: { method: 'app.surface.html', params: { html: '<main>Hello</main>' } },
    },
    forward,
  );
  coordinator.publish(
    {
      source: 'cli',
      notification: { method: 'app.surface.clear', params: {} },
    },
    forward,
  );

  assert.deepEqual(coordinator.snapshot().surface, {
    media: { mode: 'side' },
    status: null,
    document: { title: null, hasHtml: false, hasCss: false, hasScript: false },
  });
});
