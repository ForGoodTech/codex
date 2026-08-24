'use strict';

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeMethod(value) {
  let method = (value ?? '').toString().trim().toLowerCase().replace(/[/_]+/g, '.');
  while (method.includes('..')) {
    method = method.replace(/\.\.+/g, '.');
  }
  return method.replace(/^\.+|\.+$/g, '');
}

function frameFromNotification(notification) {
  const params = asObject(notification.params);
  const notificationMethod = normalizeMethod(notification.method);
  if (notificationMethod === 'app.surface.frame' || notificationMethod === 'app.surface.dispatch') {
    return cloneJson(params);
  }
  return {
    ...cloneJson(params),
    type: notificationMethod,
  };
}

function createEmptyDocument() {
  return {
    title: null,
    html: null,
    css: null,
    script: null,
  };
}

function documentSummary(document, includeContent) {
  const summary = {
    title: document.title,
    hasHtml: document.html !== null,
    hasCss: document.css !== null,
    hasScript: document.script !== null,
  };
  if (includeContent) {
    summary.content = cloneJson(document);
  }
  return summary;
}

function createAppSurfaceCoordinator(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  let revision = 0;
  let lastUpdate = null;
  let lastFrame = null;
  let media = null;
  let status = null;
  let document = createEmptyDocument();

  function snapshot(snapshotOptions = {}) {
    const includeContent = snapshotOptions.includeContent === true;
    const result = {
      version: 1,
      revision,
      lastUpdate: cloneJson(lastUpdate),
      surface: {
        media: cloneJson(media),
        status,
        document: documentSummary(document, includeContent),
      },
    };
    if (includeContent) {
      result.lastFrame = cloneJson(lastFrame);
    }
    return result;
  }

  function updateDocument(frame) {
    if (Object.prototype.hasOwnProperty.call(frame, 'title')) {
      document.title = frame.title ?? null;
    }
    for (const [target, aliases] of Object.entries({
      html: ['html', 'body', 'document'],
      css: ['css', 'style'],
      script: ['script', 'javascript'],
    })) {
      const alias = aliases.find((name) => Object.prototype.hasOwnProperty.call(frame, name));
      if (alias !== undefined) {
        document[target] = frame[alias] ?? null;
      }
    }
  }

  function applyFrame(frame, method) {
    if (method === 'app.surface.clear') {
      document = createEmptyDocument();
      status = null;
      return;
    }
    if (method === 'app.surface.media') {
      media = cloneJson(frame.media && typeof frame.media === 'object' ? frame.media : frame);
    }
    if (method === 'app.surface.status' || Object.prototype.hasOwnProperty.call(frame, 'status')) {
      status = (frame.status ?? frame.message ?? '').toString();
    }
    if (
      ['app.surface.html', 'app.surface.document', 'app.surface.replace', 'app.surface.css', 'app.surface.script'].includes(method) ||
      ['html', 'body', 'document', 'css', 'style', 'script', 'javascript'].some((name) =>
        Object.prototype.hasOwnProperty.call(frame, name),
      )
    ) {
      updateDocument(frame);
    }
  }

  function publish(publication, forward) {
    if (!publication || typeof publication !== 'object' || Array.isArray(publication)) {
      throw new Error('app-surface publication must be an object');
    }
    if (typeof forward !== 'function') {
      throw new Error('app-surface publication requires a forward function');
    }
    const expectedRevision = publication.expectedRevision;
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('expectedRevision must be a non-negative integer');
      }
      if (expectedRevision !== revision) {
        throw new Error(
          `app-surface state changed: expected revision ${expectedRevision}, current revision ${revision}`,
        );
      }
    }

    const source = (publication.source ?? '').toString().trim() || 'unknown';
    if (source.length > 128 || /[\r\n]/.test(source)) {
      throw new Error('app-surface source must be a single line no longer than 128 characters');
    }
    const notification = publication.notification;
    if (!notification || typeof notification !== 'object' || Array.isArray(notification)) {
      throw new Error('app-surface notification must be an object');
    }

    forward(notification);

    const frame = frameFromNotification(notification);
    const method = normalizeMethod(frame.type || notification.method);
    revision += 1;
    lastFrame = frame;
    lastUpdate = {
      source,
      method,
      updatedAt: now().toISOString(),
    };
    applyFrame(frame, method);
    return snapshot();
  }

  return { publish, snapshot };
}

module.exports = {
  createAppSurfaceCoordinator,
};
