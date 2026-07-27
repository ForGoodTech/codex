"use strict";

const traceVersion = 1;
const responseIdPrefixBytes = 4096;
const observedMethods = new Set([
  "thread/list",
  "thread/read",
  "thread/resume",
]);
const disabledValues = new Set(["0", "false", "no", "off"]);
const disabledTracker = Object.freeze({
  beginRequest: () => null,
  recordStdinWrite: () => {},
  recordStdinDrain: () => {},
  observeAppServerStdout: () => {},
  abandonPending: () => {},
});

function loggingEnabled(value) {
  return !disabledValues.has((value ?? "").toString().trim().toLowerCase());
}

function durationMs(startedAtNs, completedAtNs) {
  if (typeof startedAtNs !== "bigint" || typeof completedAtNs !== "bigint") {
    return null;
  }
  return Number(completedAtNs - startedAtNs) / 1_000_000;
}

function requestKey(requestId) {
  if (typeof requestId !== "number" && typeof requestId !== "string") {
    return null;
  }
  return `${typeof requestId}:${requestId}`;
}

function responseIdFromPrefix(prefix) {
  const match = prefix.match(
    /^\s*\{\s*"id"\s*:\s*("(?:\\.|[^"\\])*"|-?\d+)/,
  );
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function createThreadProxyPerfTracker(options = {}) {
  const configuredLogging =
    process.env.CODEX_THREAD_PERF_LOGGING ??
    process.env.CODEX_THREAD_LIST_PERF_LOGGING;
  const enabled =
    options.enabled ?? loggingEnabled(configuredLogging);
  if (!enabled) {
    return disabledTracker;
  }
  const nowNs = options.nowNs ?? (() => process.hrtime.bigint());
  const epochMs = options.epochMs ?? Date.now;
  const emit =
    options.emit ??
    ((record) => {
      console.log(`[ThreadPerf] ${JSON.stringify(record)}`);
    });
  const pending = new Map();
  let stdoutLineBytes = 0;
  let stdoutLinePrefix = Buffer.alloc(0);

  function resetStdoutObservation() {
    stdoutLineBytes = 0;
    stdoutLinePrefix = Buffer.alloc(0);
  }

  function log(event, entry, fields = {}) {
    emit({
      traceVersion,
      event,
      rpcId: entry.requestId,
      atEpochMs: epochMs(),
      ...fields,
    });
  }

  function beginRequest(frame, metrics = {}) {
    if (!frame || !observedMethods.has(frame.method)) {
      return null;
    }
    const key = requestKey(frame.id);
    if (!key) {
      return null;
    }
    if (pending.size === 0) {
      resetStdoutObservation();
    }
    const params = frame.params ?? {};
    const receivedAtNs = metrics.receivedAtNs ?? nowNs();
    const entry = {
      key,
      requestId: frame.id,
      rpcMethod: frame.method,
      receivedAtNs,
      requestBytes: metrics.requestBytes ?? 0,
      parseSerializeMs: metrics.parseSerializeMs ?? 0,
      stdinBufferedBefore: metrics.stdinBufferedBefore ?? 0,
      stdinWriteCompletedAtNs: null,
      stdinWriteCallMs: 0,
      stdinWriteAccepted: true,
      stdinBufferedAfter: 0,
      stdinBackpressureStartedAtNs: null,
      stdinDrainWaitMs: 0,
      cursorPresent:
        params.cursor !== undefined &&
        params.cursor !== null &&
        params.cursor !== "",
      requestedLimit: params.limit ?? 0,
      searchLength:
        typeof params.searchTerm === "string" ? params.searchTerm.length : 0,
      useStateDbOnly: params.useStateDbOnly === true,
      threadIdPresent:
        typeof params.threadId === "string" && params.threadId.trim() !== "",
      includeTurns: params.includeTurns === true,
    };
    pending.set(key, entry);
    return key;
  }

  function recordStdinWrite(key, metrics = {}) {
    const entry = pending.get(key);
    if (!entry) {
      return;
    }
    entry.stdinWriteCompletedAtNs = metrics.completedAtNs ?? nowNs();
    entry.stdinWriteCallMs = metrics.writeCallMs ?? 0;
    entry.stdinWriteAccepted = metrics.writeAccepted !== false;
    entry.stdinBufferedAfter = metrics.stdinBufferedAfter ?? 0;
    if (!entry.stdinWriteAccepted) {
      entry.stdinBackpressureStartedAtNs = entry.stdinWriteCompletedAtNs;
    }
    log("proxy.request_received", entry, {
      rpcMethod: entry.rpcMethod,
      requestBytes: entry.requestBytes,
      parseSerializeMs: entry.parseSerializeMs,
      cursorPresent: entry.cursorPresent,
      requestedLimit: entry.requestedLimit,
      searchLength: entry.searchLength,
      useStateDbOnly: entry.useStateDbOnly,
      threadIdPresent: entry.threadIdPresent,
      includeTurns: entry.includeTurns,
      stdinBufferedBefore: entry.stdinBufferedBefore,
    });
    log("proxy.request_forwarded", entry, {
      rpcMethod: entry.rpcMethod,
      parseSerializeMs: entry.parseSerializeMs,
      stdinWriteCallMs: entry.stdinWriteCallMs,
      stdinWriteAccepted: entry.stdinWriteAccepted,
      stdinBufferedBefore: entry.stdinBufferedBefore,
      stdinBufferedAfter: entry.stdinBufferedAfter,
    });
  }

  function recordStdinDrain(completedAtNs = nowNs()) {
    for (const entry of pending.values()) {
      if (entry.stdinBackpressureStartedAtNs === null) {
        continue;
      }
      entry.stdinDrainWaitMs +=
        durationMs(entry.stdinBackpressureStartedAtNs, completedAtNs) ?? 0;
      entry.stdinBackpressureStartedAtNs = null;
    }
  }

  function observeAppServerStdout(chunk, metrics = {}) {
    if (pending.size === 0) {
      return;
    }
    const chunkReceivedAtNs = metrics.chunkReceivedAtNs ?? nowNs();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < buffer.length) {
      const newlineIndex = buffer.indexOf(0x0a, offset);
      const end = newlineIndex < 0 ? buffer.length : newlineIndex;
      const segment = buffer.subarray(offset, end);
      stdoutLineBytes += segment.length;
      if (stdoutLinePrefix.length < responseIdPrefixBytes) {
        const remaining = responseIdPrefixBytes - stdoutLinePrefix.length;
        stdoutLinePrefix = Buffer.concat([
          stdoutLinePrefix,
          segment.subarray(0, remaining),
        ]);
      }
      if (newlineIndex < 0) {
        break;
      }

      const responseId = responseIdFromPrefix(stdoutLinePrefix.toString("utf8"));
      const key = requestKey(responseId);
      const entry = key ? pending.get(key) : null;
      if (entry) {
        pending.delete(key);
        const stdinWriteCompletedAtNs =
          entry.stdinWriteCompletedAtNs ?? entry.receivedAtNs;
        log("proxy.response_forwarded", entry, {
          rpcMethod: entry.rpcMethod,
          requestToResponseMs: durationMs(entry.receivedAtNs, chunkReceivedAtNs),
          appServerWaitMs: durationMs(stdinWriteCompletedAtNs, chunkReceivedAtNs),
          parseSerializeMs: entry.parseSerializeMs,
          stdinWriteCallMs: entry.stdinWriteCallMs,
          stdinWriteAccepted: entry.stdinWriteAccepted,
          stdinDrainWaitMs: entry.stdinDrainWaitMs,
          stdinBufferedBefore: entry.stdinBufferedBefore,
          stdinBufferedAfter: entry.stdinBufferedAfter,
          responseBytes: stdoutLineBytes,
          socketWriteCallMs: metrics.socketWriteCallMs ?? 0,
          socketWriteAccepted: metrics.socketWriteAccepted !== false,
          socketBufferedBefore: metrics.socketBufferedBefore ?? 0,
          socketBufferedAfter: metrics.socketBufferedAfter ?? 0,
        });
      }
      resetStdoutObservation();
      offset = newlineIndex + 1;
    }

    if (pending.size === 0) {
      resetStdoutObservation();
    }
  }

  function abandonPending(reason = "connection_closed") {
    for (const entry of pending.values()) {
      log("proxy.request_abandoned", entry, {
        rpcMethod: entry.rpcMethod,
        reason,
        elapsedMs: durationMs(entry.receivedAtNs, nowNs()),
      });
    }
    pending.clear();
    resetStdoutObservation();
  }

  return {
    beginRequest,
    recordStdinWrite,
    recordStdinDrain,
    observeAppServerStdout,
    abandonPending,
  };
}

module.exports = {
  createThreadProxyPerfTracker,
  createThreadListProxyPerfTracker: createThreadProxyPerfTracker,
};
