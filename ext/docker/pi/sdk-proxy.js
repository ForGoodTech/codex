#!/usr/bin/env node
/**
 * codex-sdk-proxy
 * ---------------
 * TCP proxy that runs Codex turns via the TypeScript SDK inside the container and
 * streams JSONL events back to a single connected client. The proxy keeps the
 * Codex thread alive across turns for the lifetime of the TCP connection.
 */

const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const HOST = process.env.SDK_PROXY_HOST ?? '0.0.0.0';
const PORT = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;


(async () => {
  const Codex = await loadCodexSdk();

  const server = net.createServer((socket) => {
    socket.setKeepAlive(true);
    console.log(`SDK proxy client connected from ${socket.remoteAddress}:${socket.remotePort}`);

  let codex = null;
  let thread = null;
  let activeRun = null;
  let abortController = null;
  let buffer = '';
  let authHome = null;
  let authCleanup = null;

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim().length) {
        handleLine(line).catch((error) => emitError(error));
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });

  socket.on('close', () => {
    if (abortController) {
      abortController.abort();
    }
    if (authCleanup) {
      authCleanup().catch(() => {});
      authCleanup = null;
    }
    console.log('SDK proxy client disconnected');
  });

  function emit(json) {
    try {
      socket.write(`${JSON.stringify(json)}\n`);
    } catch (error) {
      console.error('Failed to emit to client', error);
    }
  }

  function emitError(error) {
    emit({ type: 'error', message: error?.message ?? String(error) });
  }

  async function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON from client: ${line}`);
    }

    if (message.type === 'abort') {
      if (abortController) {
        abortController.abort();
      }
      return;
    }

    if (message.type !== 'run') {
      throw new Error(`Unsupported message type: ${message.type}`);
    }

    if (activeRun) {
      throw new Error('A turn is already running. Wait for completion before sending another run request.');
    }

    const prompt = typeof message.prompt === 'string' && message.prompt.trim().length > 0
      ? message.prompt.trim()
      : null;
    const images = Array.isArray(message.images) ? message.images : [];

    if (typeof message.authJson === 'string' && message.authJson.trim().length) {
      if (authCleanup) {
        await authCleanup().catch(() => {});
      }
      const auth = await writeAuthJson(message.authJson);
      authHome = auth.home;
      authCleanup = auth.cleanup;
    }

    const normalizedImages = await materializeImages(images);
    const userInput = buildUserInput(prompt, normalizedImages);

    if (!userInput.length) {
      throw new Error('Missing prompt or images for run request');
    }

    const { codexOptions, threadOptions } = buildOptions(
      message.options ?? {},
      message.env ?? {},
      authHome,
    );

    if (!codex) {
      codex = new Codex(codexOptions);
    }

    if (message.threadId) {
      thread = codex.resumeThread(message.threadId, threadOptions);
    } else if (!thread) {
      thread = codex.startThread(threadOptions);
    }

    abortController = new AbortController();
    const cleanupFns = normalizedImages.map((entry) => entry.cleanup);
    const signal = abortController.signal;
    activeRun = runTurn(thread, userInput, signal, cleanupFns).finally(() => {
      activeRun = null;
      abortController = null;
    });
    await activeRun;
  }

  async function runTurn(threadInstance, userInput, signal, cleanupFns) {
    try {
      const { events } = await threadInstance.runStreamed(userInput, { signal });
      for await (const event of events) {
        emit({ type: 'event', event });
      }
      emit({ type: 'done', threadId: threadInstance.id });
    } catch (error) {
      if (signal?.aborted) {
        emit({ type: 'aborted' });
      } else {
        emitError(error);
      }
    } finally {
      await Promise.allSettled(cleanupFns.map((fn) => fn()));
    }
  }
  });

  server.on('error', (error) => {
    console.error('SDK proxy server error:', error);
  });

  server.listen(PORT, HOST, () => {
    console.log(`SDK proxy listening on ${HOST}:${PORT}`);
  });
})();

function buildOptions(options, envOverrides, authHome) {
  const codexOptions = {};
  const baseEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      baseEnv[key] = value;
    }
  }

  const normalizedEnv = Object.fromEntries(
    Object.entries(envOverrides || {}).filter(([, value]) => typeof value === 'string'),
  );

  const mergedEnv = { ...baseEnv, ...normalizedEnv };

  if (authHome) {
    mergedEnv.CODEX_HOME = path.join(authHome, '.codex');
    mergedEnv.HOME = authHome;
  }

  if (Object.keys(mergedEnv).length) {
    codexOptions.env = mergedEnv;
  }

  if (typeof options.baseUrl === 'string') codexOptions.baseUrl = options.baseUrl;
  if (typeof options.apiKey === 'string') codexOptions.apiKey = options.apiKey;

  return { codexOptions, threadOptions: buildThreadOptions(options) };
}

function buildThreadOptions(options) {
  const threadOptions = {};
  if (typeof options.model === 'string') threadOptions.model = options.model;
  threadOptions.sandboxMode = typeof options.sandboxMode === 'string'
    ? options.sandboxMode
    : 'danger-full-access';
  threadOptions.workingDirectory = typeof options.workingDirectory === 'string'
    ? options.workingDirectory
    : process.cwd();
  threadOptions.approvalPolicy = typeof options.approvalPolicy === 'string'
    ? options.approvalPolicy
    : 'auto';
  if (Array.isArray(options.additionalDirectories)) threadOptions.additionalDirectories = options.additionalDirectories;
  if (typeof options.skipGitRepoCheck === 'boolean') threadOptions.skipGitRepoCheck = options.skipGitRepoCheck;
  if (typeof options.modelReasoningEffort === 'string') threadOptions.modelReasoningEffort = options.modelReasoningEffort;
  if (typeof options.networkAccessEnabled === 'boolean') threadOptions.networkAccessEnabled = options.networkAccessEnabled;
  if (typeof options.webSearchEnabled === 'boolean') threadOptions.webSearchEnabled = options.webSearchEnabled;
  if (typeof options.approvalPolicy === 'string') threadOptions.approvalPolicy = options.approvalPolicy;
  return threadOptions;
}

function buildUserInput(prompt, images) {
  const input = [];
  if (prompt) {
    input.push({ type: 'text', text: prompt });
  }
  for (const image of images) {
    input.push({ type: 'local_image', path: image.path });
  }
  return input;
}

async function materializeImages(images) {
  const results = [];
  for (const image of images) {
    if (!image || typeof image.data !== 'string') {
      continue;
    }
    const { mime, buffer } = decodeDataUrl(image.data);
    const extension = extensionFromMime(mime);
    const fileName = image.name && typeof image.name === 'string'
      ? image.name
      : `image-${randomUUID()}${extension}`;
    const filePath = path.join(os.tmpdir(), `codex-sdk-proxy-${fileName}`);
    await fsp.writeFile(filePath, buffer);
    results.push({
      path: filePath,
      cleanup: async () => fsp.unlink(filePath).catch(() => {}),
    });
  }
  return results;
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/u.exec(dataUrl.trim());
  if (!match) {
    throw new Error('Invalid image data URL');
  }
  const [, mime, base64] = match;
  return { mime, buffer: Buffer.from(base64, 'base64') };
}

function extensionFromMime(mime) {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    default:
      return '.bin';
  }
}

async function writeAuthJson(contents) {
  const trimmed = contents.trim();
  if (!trimmed.length) {
    throw new Error('authJson provided but empty');
  }

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-sdk-proxy-auth-'));
  const codexDir = path.join(home, '.codex');
  await fsp.mkdir(codexDir, { recursive: true });
  const authPath = path.join(codexDir, 'auth.json');
  await fsp.writeFile(authPath, trimmed, 'utf8');

  return {
    home,
    cleanup: async () => fsp.rm(home, { recursive: true, force: true }),
  };
}

async function loadCodexSdk() {
  try {
    const sdk = await import('@openai/codex-sdk');
    if (!sdk?.Codex) {
      throw new Error('Codex class missing from @openai/codex-sdk');
    }
    return sdk.Codex;
  } catch (error) {
    console.error('Failed to load @openai/codex-sdk:', error);
    process.exit(1);
  }
}
