#!/usr/bin/env node
/**
 * codex-sdk-proxy
 * ---------------
 * TCP proxy that runs Codex turns via the TypeScript SDK inside the container and
 * streams JSONL events back to a single connected client. The proxy keeps the
 * Codex thread alive across turns for the lifetime of the TCP connection.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { exec } = require('node:child_process');

const HOST = process.env.SDK_PROXY_HOST ?? '0.0.0.0';
const PORT = Number.parseInt(process.env.SDK_PROXY_PORT ?? '9400', 10) || 9400;
const SELF_TEST = process.argv.includes('--self-test') || process.env.SDK_PROXY_SELF_TEST === '1';
const VERBOSE = process.argv.includes('--verbose') || process.env.SDK_PROXY_VERBOSE === '1';

function logInfo(message, ...args) {
  console.log(message, ...args);
}

function logDebug(message, ...args) {
  if (VERBOSE) {
    console.log(message, ...args);
  }
}


(async () => {
  const Codex = await loadCodexSdk();

  if (SELF_TEST) {
    runSelfTest(Codex).catch((error) => {
      console.error('SDK proxy self-test failed:', error);
    });
  }

const server = net.createServer((socket) => {
  socket.setKeepAlive(true);
  logInfo(`SDK proxy client connected from ${socket.remoteAddress}:${socket.remotePort}`);

  // Immediately tell the client we are ready and listening; this also proves
  // the connection can flow from server -> client.
  socket.write(`${JSON.stringify({ type: 'ready', at: new Date().toISOString() })}\n`);

  let codex = null;
  let thread = null;
  let activeRun = null;
  let abortController = null;
  let buffer = '';
  let authHome = null;
  let authCleanup = null;

    socket.on('data', (chunk) => {
      logDebug(`[server] received raw chunk (${chunk.length} bytes)`);
      buffer += chunk.toString('utf8');
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length) {
          logDebug(`[server] processing line: ${line}`);
          handleLine(line).catch((error) => {
            console.error('[server] handleLine error', error);
            emitError(error);
          });
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });

    socket.on('error', (error) => {
      console.error('[server] socket error', error);
    });

    socket.on('end', () => {
      logDebug('[server] socket ended by client');
    });

  socket.on('close', () => {
    if (abortController) {
      abortController.abort();
    }
    if (authCleanup) {
      authCleanup().catch(() => {});
      authCleanup = null;
    }
    logInfo('SDK proxy client disconnected');
  });

  function emit(json) {
    try {
      logDebug(`[server] emitting: ${JSON.stringify(json)}`);
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
        console.error('[server] failed to parse JSON', error);
        throw new Error(`Invalid JSON from client: ${line}`);
      }

      logDebug('[server] parsed message type:', message.type);

    if (message.type === 'abort') {
      logInfo('[server] abort requested by client');
      if (abortController) {
        abortController.abort();
      }
      return;
    }

    if (message.type === 'ping') {
      logDebug('[server] received ping');
      emit({ type: 'pong', at: new Date().toISOString() });
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

    logInfo(`[server] run requested: promptLength=${prompt ? prompt.length : 0}, images=${images.length}`);

    if (typeof message.authJson === 'string' && message.authJson.trim().length) {
      if (authCleanup) {
        await authCleanup().catch(() => {});
      }
      const auth = await writeAuthJson(message.authJson);
      authHome = auth.home;
      authCleanup = auth.cleanup;
      logDebug(`[server] wrote auth.json to ${authHome}`);
    }

    const normalizedImages = await materializeImages(images);
    logDebug(`[server] materialized ${normalizedImages.length} images`);
    const userInput = buildUserInput(prompt, normalizedImages);

    if (!userInput.length) {
      throw new Error('Missing prompt or images for run request');
    }

    const { codexOptions, threadOptions } = buildOptions(
      message.options ?? {},
      message.env ?? {},
      authHome,
    );

    logDebug('[server] codex options:', codexOptions);
    logDebug('[server] thread options:', threadOptions);

    if (!codex) {
      codex = new Codex(codexOptions);
      logInfo('[server] instantiated Codex SDK');
    }

    if (message.threadId) {
      thread = codex.resumeThread(message.threadId, threadOptions);
      logInfo(`[server] resumed thread ${message.threadId}`);
    } else if (!thread) {
      thread = codex.startThread(threadOptions);
      logInfo('[server] started new thread');
    }

    abortController = new AbortController();
    const cleanupFns = normalizedImages.map((entry) => entry.cleanup);
    const signal = abortController.signal;
    logDebug('[server] starting runStreamed');
    activeRun = runTurn(thread, userInput, signal, cleanupFns).finally(() => {
      activeRun = null;
      abortController = null;
    });
    await activeRun;
  }

  async function runTurn(threadInstance, userInput, signal, cleanupFns) {
    try {
      const { events } = await threadInstance.runStreamed(userInput, { signal });
      let turnFinished = false;
      for await (const event of events) {
        logDebug('[server] event from SDK:', event?.type ?? 'unknown', JSON.stringify(event));
        emit({ type: 'event', event });

        const handledToolRequest = await maybeHandleToolRequest({
          event,
          threadInstance,
          signal,
          emit,
        });

        if (handledToolRequest) {
          continue;
        }
        if (event?.type === 'turn.completed' || event?.type === 'turn.failed') {
          turnFinished = true;
          break;
        }
      }

      if (!turnFinished && !signal?.aborted) {
        abortController?.abort();
      }

      logInfo('[server] emitting done for thread', threadInstance.id);
      emit({ type: 'done', threadId: threadInstance.id });
    } catch (error) {
      console.error('[server] runTurn error', error);
      if (signal?.aborted) {
        emit({ type: 'aborted' });
      } else {
        emitError(error);
      }
    } finally {
      await Promise.allSettled(cleanupFns.map((fn) => fn()));
    }
  }

  async function maybeHandleToolRequest({ event, threadInstance, signal, emit: emitFn }) {
    const extraction = extractToolCalls(event);
    if (!extraction) {
      return false;
    }

    const { responseId, toolCalls } = extraction;
    logInfo('[server] requires_action detected with tool calls:', toolCalls.length);
    try {
      const toolOutputs = [];
      for (const call of toolCalls) {
        if (signal?.aborted) {
          logInfo('[server] abort requested while handling tool calls');
          return true;
        }
        const output = await executeToolCall(call);
        toolOutputs.push(output);
      }

      await submitToolOutputs(threadInstance, responseId, toolOutputs);
      emitFn({
        type: 'tool_outputs.submitted',
        responseId,
        count: toolOutputs.length,
      });
    } catch (error) {
      console.error('[server] tool handling error', error);
      emitError(error);
    }

    return true;
  }
  });

  server.on('error', (error) => {
    console.error('SDK proxy server error:', error);
  });

  server.listen(PORT, HOST, () => {
    logInfo(`SDK proxy listening on ${HOST}:${PORT}`);
  });
})();

function extractToolCalls(event) {
  const requiredAction = event?.required_action || event?.data?.required_action || event?.response?.required_action;
  if (!requiredAction) {
    return null;
  }

  const submitAction = requiredAction?.submit_tool_outputs || (requiredAction?.type === 'submit_tool_outputs' ? requiredAction : null);
  const toolCalls = submitAction?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return null;
  }

  const responseId = event?.response?.id || event?.id || submitAction?.response_id || requiredAction?.response_id;
  return { responseId, toolCalls };
}

async function executeToolCall(toolCall) {
  const callId = toolCall?.id || toolCall?.tool_call_id || toolCall?.function?.id || randomUUID();
  const name = toolCall?.function?.name || toolCall?.name || 'unknown';
  const parsedArgs = parseToolArguments(toolCall?.function?.arguments ?? toolCall?.arguments ?? {});

  if (['shell', 'bash', 'sh', 'execute_shell'].includes(name)) {
    const output = await runShellTool(parsedArgs);
    return { tool_call_id: callId, output };
  }

  const output = `Unsupported tool '${name}' requested`;
  return { tool_call_id: callId, output };
}

function parseToolArguments(rawArgs) {
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed.length) {
      return {};
    }
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      console.warn('[server] failed to parse tool arguments as JSON, using raw string', error);
      return trimmed;
    }
  }
  if (rawArgs && typeof rawArgs === 'object') {
    return rawArgs;
  }
  return {};
}

async function runShellTool(args) {
  const command = typeof args === 'string'
    ? args
    : args.command || args.cmd || args.input || '';
  if (!command || !command.toString().trim().length) {
    throw new Error('Shell tool call missing command');
  }

  return new Promise((resolve, reject) => {
    exec(command, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = `${stdout ?? ''}${stderr ?? ''}${error.message ? `\n${error.message}` : ''}`.trim();
        resolve(message.length ? message : 'Command failed without output');
        return;
      }
      const combined = `${stdout ?? ''}${stderr ?? ''}`.trim();
      resolve(combined.length ? combined : '(no output)');
    });
  });
}

async function submitToolOutputs(threadInstance, responseId, toolOutputs) {
  const submit = threadInstance?.submitToolOutputs || threadInstance?.submit_tool_outputs;
  if (typeof submit === 'function') {
    if (responseId !== undefined && submit.length >= 2) {
      await submit.call(threadInstance, responseId, toolOutputs);
    } else {
      await submit.call(threadInstance, toolOutputs);
    }
    return;
  }

  const client = threadInstance?.codex || threadInstance?.client || threadInstance?._client;
  if (client?.responses?.submitToolOutputs) {
    const targetId = responseId || threadInstance?.id;
    if (!targetId) {
      throw new Error('Unable to determine response ID for tool submission');
    }
    await client.responses.submitToolOutputs(targetId, { tool_outputs: toolOutputs });
    return;
  }

  throw new Error('Codex SDK does not expose submitToolOutputs; upgrade the SDK or proxy.');
}

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

  if (!authHome && !('CODEX_HOME' in mergedEnv)) {
    const authEnv = resolveLocalAuthEnv();
    if (authEnv?.CODEX_HOME) {
      mergedEnv.CODEX_HOME = authEnv.CODEX_HOME;
      if (!('HOME' in mergedEnv) && authEnv.HOME) {
        mergedEnv.HOME = authEnv.HOME;
      }
    }
  }

  if (!('CODEX_AUTO_APPROVE' in mergedEnv)) {
    mergedEnv.CODEX_AUTO_APPROVE = '1';
  }

  if (!('CODEX_APPROVAL_POLICY' in mergedEnv)) {
    mergedEnv.CODEX_APPROVAL_POLICY = 'never';
  }

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
  const envSandboxMode = typeof process.env.SDK_PROXY_SANDBOX_MODE === 'string'
    ? process.env.SDK_PROXY_SANDBOX_MODE.trim()
    : '';
  threadOptions.sandboxMode = typeof options.sandboxMode === 'string'
    ? options.sandboxMode
    : (envSandboxMode.length ? envSandboxMode : 'restricted');

  const allowedWorkingDirectories = getWhitelistedWorkingDirectories();
  threadOptions.workingDirectory = resolveWorkingDirectory(options, allowedWorkingDirectories);
  const requestedApproval = typeof options.approvalPolicy === 'string'
    ? options.approvalPolicy
    : 'never';
  const approvalPolicy = requestedApproval === 'auto' ? 'never' : requestedApproval;
  threadOptions.approvalPolicy = approvalPolicy;
  if (Array.isArray(options.additionalDirectories)) threadOptions.additionalDirectories = options.additionalDirectories;
  if (typeof options.skipGitRepoCheck === 'boolean') threadOptions.skipGitRepoCheck = options.skipGitRepoCheck;
  if (typeof options.modelReasoningEffort === 'string') threadOptions.modelReasoningEffort = options.modelReasoningEffort;
  if (typeof options.networkAccessEnabled === 'boolean') threadOptions.networkAccessEnabled = options.networkAccessEnabled;
  if (typeof options.webSearchEnabled === 'boolean') threadOptions.webSearchEnabled = options.webSearchEnabled;
  return threadOptions;
}

function getWhitelistedWorkingDirectories() {
  const rawWhitelist = typeof process.env.SDK_PROXY_WORKDIR_WHITELIST === 'string'
    ? process.env.SDK_PROXY_WORKDIR_WHITELIST
    : '';
  const entries = rawWhitelist
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
  if (entries.length > 0) {
    return entries;
  }

  // Default to the container's intended workspace.
  return [path.resolve('/home/node/workdir')];
}

function resolveWorkingDirectory(options, whitelistedDirectories) {
  const envWorkingDirectory = typeof process.env.SDK_PROXY_WORKDIR === 'string'
    ? process.env.SDK_PROXY_WORKDIR
    : '';
  const requestedWorkingDirectory = typeof options.workingDirectory === 'string'
    ? options.workingDirectory
    : (envWorkingDirectory.length ? envWorkingDirectory : whitelistedDirectories[0]);
  const resolvedWorkingDirectory = path.resolve(requestedWorkingDirectory);

  const matchesWhitelist = whitelistedDirectories.some((entry) =>
    resolvedWorkingDirectory === entry
    || resolvedWorkingDirectory.startsWith(`${entry}${path.sep}`),
  );

  if (!matchesWhitelist) {
    console.warn(`Working directory ${resolvedWorkingDirectory} is not in the whitelist; using ${whitelistedDirectories[0]} instead.`);
    return whitelistedDirectories[0];
  }

  return resolvedWorkingDirectory;
}

function buildUserInput(prompt, images) {
  if (prompt && images.length === 0) {
    return prompt;
  }

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

function resolveLocalAuthEnv() {
  const homeDir = process.env.HOME || os.homedir();
  const explicitAuthPath = process.env.CODEX_AUTH_PATH;
  const candidatePaths = [];

  if (explicitAuthPath) {
    candidatePaths.push(explicitAuthPath);
  }

  const defaultCodexHome = process.env.CODEX_HOME || path.join(homeDir, '.codex');
  candidatePaths.push(path.join(defaultCodexHome, 'auth.json'));

  for (const candidate of candidatePaths) {
    if (candidate && fs.existsSync(candidate)) {
      const codexHome = path.dirname(candidate);
      return {
        authPath: candidate,
        CODEX_HOME: codexHome,
        HOME: homeDir,
      };
    }
  }

  return null;
}

async function runSelfTest(CodexClass) {
  const localAuth = resolveLocalAuthEnv();
  if (!localAuth) {
    throw new Error('auth.json not found in CODEX_AUTH_PATH or default .codex directory inside the container');
  }

  const envOverrides = {};
  if (localAuth.CODEX_HOME) envOverrides.CODEX_HOME = localAuth.CODEX_HOME;
  if (localAuth.HOME) envOverrides.HOME = localAuth.HOME;
  envOverrides.CODEX_AUTO_APPROVE = envOverrides.CODEX_AUTO_APPROVE ?? '1';
  envOverrides.CODEX_APPROVAL_POLICY = envOverrides.CODEX_APPROVAL_POLICY ?? 'never';

  console.log(`Using auth from ${localAuth.authPath}`);

  const { codexOptions, threadOptions } = buildOptions({}, envOverrides, null);
  const codex = new CodexClass(codexOptions);
  const thread = codex.startThread(threadOptions);
  const input = [{ type: 'text', text: 'Say hello from the sdk proxy self-test.' }];
  let output = '';
  let failedEvent = null;
  const seenEvents = [];

  try {
    const { events } = await thread.runStreamed(input);
    for await (const event of events) {
      if (seenEvents.length < 5) {
        seenEvents.push(event?.type ?? 'unknown');
      }
      if (event?.type === 'message.delta') {
        const deltaText = event.delta?.text || '';
        output += deltaText;
        process.stdout.write(deltaText);
      }

      if (event?.type === 'message.completed' && event.message?.content?.length) {
        const text = event.message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
        if (text) {
          output += text;
        }
      }

      if (event?.type === 'item.completed' && event.item?.type === 'agent_message') {
        if (event.item.text) {
          output += event.item.text;
          process.stdout.write(event.item.text);
        }
      }

      if (event?.type === 'turn.failed') {
        failedEvent = event;
        break;
      }

      if (event?.type === 'turn.completed') {
        break;
      }
    }
  } catch (error) {
    console.error('\nSDK proxy self-test failed:', error);
    process.exitCode = 1;
    return;
  }

  if (failedEvent) {
    const reason = failedEvent.error?.message || failedEvent.error?.type || 'unknown failure';
    const status = failedEvent.status ? ` (status: ${failedEvent.status})` : '';
    console.error(`\nSDK proxy self-test failed: ${reason}${status}`);
    process.exitCode = 1;
    return;
  }

  if (!output.length) {
    const eventSummary = seenEvents.length ? ` Seen events: ${seenEvents.join(', ')}` : ' No events observed.';
    console.error(`\nSDK proxy self-test failed: no response produced — verify credentials and proxy options.${eventSummary}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nSDK proxy self-test completed successfully.');
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
