"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createThreadProxyPerfTracker,
} = require("./app-server-proxy-perf.js");

function createHarness() {
  let currentNs = 0n;
  const records = [];
  const tracker = createThreadProxyPerfTracker({
    enabled: true,
    nowNs: () => currentNs,
    epochMs: () => 1_785_100_000_000,
    emit: (record) => records.push(record),
  });
  return {
    records,
    tracker,
    setNs(value) {
      currentNs = BigInt(value);
    },
  };
}

test("reports proxy and app-server timing for a thread/list response", () => {
  const harness = createHarness();
  harness.setNs(1_000_000);
  const key = harness.tracker.beginRequest(
    {
      id: 42,
      method: "thread/list",
      params: {
        cursor: "",
        limit: 40,
        searchTerm: "",
        useStateDbOnly: false,
      },
    },
    {
      receivedAtNs: 1_000_000n,
      requestBytes: 180,
      parseSerializeMs: 0.25,
      stdinBufferedBefore: 0,
    },
  );
  harness.tracker.recordStdinWrite(key, {
    completedAtNs: 2_000_000n,
    writeCallMs: 0.1,
    writeAccepted: true,
    stdinBufferedAfter: 180,
  });

  const response = `${JSON.stringify({ id: 42, result: { data: [] } })}\n`;
  harness.tracker.observeAppServerStdout(Buffer.from(response), {
    chunkReceivedAtNs: 302_000_000n,
    socketWriteCallMs: 0.04,
    socketWriteAccepted: true,
    socketBufferedBefore: 0,
    socketBufferedAfter: Buffer.byteLength(response),
  });

  assert.deepEqual(harness.records, [
    {
      traceVersion: 1,
      event: "proxy.request_received",
      rpcId: 42,
      atEpochMs: 1_785_100_000_000,
      rpcMethod: "thread/list",
      requestBytes: 180,
      parseSerializeMs: 0.25,
      cursorPresent: false,
      requestedLimit: 40,
      searchLength: 0,
      useStateDbOnly: false,
      threadIdPresent: false,
      includeTurns: false,
      stdinBufferedBefore: 0,
    },
    {
      traceVersion: 1,
      event: "proxy.request_forwarded",
      rpcId: 42,
      atEpochMs: 1_785_100_000_000,
      rpcMethod: "thread/list",
      parseSerializeMs: 0.25,
      stdinWriteCallMs: 0.1,
      stdinWriteAccepted: true,
      stdinBufferedBefore: 0,
      stdinBufferedAfter: 180,
    },
    {
      traceVersion: 1,
      event: "proxy.response_forwarded",
      rpcId: 42,
      atEpochMs: 1_785_100_000_000,
      rpcMethod: "thread/list",
      requestToResponseMs: 301,
      appServerWaitMs: 300,
      parseSerializeMs: 0.25,
      stdinWriteCallMs: 0.1,
      stdinWriteAccepted: true,
      stdinDrainWaitMs: 0,
      stdinBufferedBefore: 0,
      stdinBufferedAfter: 180,
      responseBytes: Buffer.byteLength(response.trim()),
      socketWriteCallMs: 0.04,
      socketWriteAccepted: true,
      socketBufferedBefore: 0,
      socketBufferedAfter: Buffer.byteLength(response),
    },
  ]);
});

test("matches a UTF-8 response split across stdout chunks", () => {
  const harness = createHarness();
  const key = harness.tracker.beginRequest(
    {
      id: "request-7",
      method: "thread/list",
      params: {},
    },
    { receivedAtNs: 0n },
  );
  harness.tracker.recordStdinWrite(key, { completedAtNs: 1_000_000n });

  const response = Buffer.from(
    `${JSON.stringify({ id: "request-7", result: { preview: "你好" } })}\n`,
  );
  const unicodeStart = response.indexOf(Buffer.from("你"));
  harness.tracker.observeAppServerStdout(
    response.subarray(0, unicodeStart + 1),
    {
      chunkReceivedAtNs: 50_000_000n,
    },
  );
  assert.equal(
    harness.records.some(
      (record) => record.event === "proxy.response_forwarded",
    ),
    false,
  );

  harness.tracker.observeAppServerStdout(response.subarray(unicodeStart + 1), {
    chunkReceivedAtNs: 101_000_000n,
  });
  const responseRecord = harness.records.find(
    (record) => record.event === "proxy.response_forwarded",
  );
  assert.equal(responseRecord.rpcId, "request-7");
  assert.equal(responseRecord.requestToResponseMs, 101);
  assert.equal(responseRecord.appServerWaitMs, 100);
  assert.equal(responseRecord.responseBytes, response.length - 1);
});

test("reports a large thread/resume response without logging thread contents", () => {
  const harness = createHarness();
  const secretThreadId = "thread-private-123";
  const secretContent = "private-tool-output-".repeat(100_000);
  const key = harness.tracker.beginRequest(
    {
      id: 77,
      method: "thread/resume",
      params: { threadId: secretThreadId },
    },
    {
      receivedAtNs: 1_000_000n,
      requestBytes: 96,
    },
  );
  harness.tracker.recordStdinWrite(key, {
    completedAtNs: 2_000_000n,
  });

  const response = Buffer.from(
    `${JSON.stringify({
      id: 77,
      result: {
        thread: {
          id: secretThreadId,
          turns: [{ items: [{ content: secretContent }] }],
        },
      },
    })}\n`,
  );
  const splitAt = 137;
  harness.tracker.observeAppServerStdout(response.subarray(0, splitAt), {
    chunkReceivedAtNs: 200_000_000n,
  });
  harness.tracker.observeAppServerStdout(response.subarray(splitAt), {
    chunkReceivedAtNs: 402_000_000n,
  });

  const requestRecord = harness.records.find(
    (record) => record.event === "proxy.request_received",
  );
  assert.equal(requestRecord.rpcMethod, "thread/resume");
  assert.equal(requestRecord.threadIdPresent, true);
  assert.equal(requestRecord.includeTurns, false);

  const responseRecord = harness.records.find(
    (record) => record.event === "proxy.response_forwarded",
  );
  assert.equal(responseRecord.rpcMethod, "thread/resume");
  assert.equal(responseRecord.requestToResponseMs, 401);
  assert.equal(responseRecord.appServerWaitMs, 400);
  assert.equal(responseRecord.responseBytes, response.length - 1);

  const serializedRecords = JSON.stringify(harness.records);
  assert.equal(serializedRecords.includes(secretThreadId), false);
  assert.equal(serializedRecords.includes(secretContent.slice(0, 40)), false);
});

test("reports thread/read intent without logging its thread id", () => {
  const harness = createHarness();
  const key = harness.tracker.beginRequest({
    id: 78,
    method: "thread/read",
    params: {
      threadId: "private-read-thread",
      includeTurns: true,
    },
  });
  harness.tracker.recordStdinWrite(key);
  harness.tracker.observeAppServerStdout(
    Buffer.from('{"id":78,"result":{"thread":{"turns":[]}}}\n'),
  );

  const requestRecord = harness.records.find(
    (record) => record.event === "proxy.request_received",
  );
  assert.equal(requestRecord.rpcMethod, "thread/read");
  assert.equal(requestRecord.threadIdPresent, true);
  assert.equal(requestRecord.includeTurns, true);
  assert.equal(JSON.stringify(harness.records).includes("private-read-thread"), false);
});

test("records stdin backpressure without logging request values", () => {
  const harness = createHarness();
  const secretSearch = "private-search-contents";
  const secretCursor = "private-cursor";
  const secretProjectPath = "/home/node/workdir/private-project";
  const key = harness.tracker.beginRequest(
    {
      id: 9,
      method: "thread/list",
      params: {
        cwd: secretProjectPath,
        cursor: secretCursor,
        searchTerm: secretSearch,
        limit: 25,
      },
    },
    { receivedAtNs: 0n },
  );
  harness.tracker.recordStdinWrite(key, {
    completedAtNs: 5_000_000n,
    writeAccepted: false,
  });
  harness.tracker.recordStdinDrain(25_000_000n);
  harness.tracker.observeAppServerStdout(
    Buffer.from('{"id":9,"result":{"data":[]}}\n'),
    {
      chunkReceivedAtNs: 105_000_000n,
      socketWriteAccepted: false,
    },
  );

  const responseRecord = harness.records.find(
    (record) => record.event === "proxy.response_forwarded",
  );
  assert.equal(responseRecord.stdinDrainWaitMs, 20);
  assert.equal(responseRecord.stdinWriteAccepted, false);
  assert.equal(responseRecord.socketWriteAccepted, false);

  const serializedRecords = JSON.stringify(harness.records);
  assert.equal(serializedRecords.includes(secretSearch), false);
  assert.equal(serializedRecords.includes(secretCursor), false);
  assert.equal(serializedRecords.includes(secretProjectPath), false);
  assert.match(serializedRecords, /"searchLength":23/);
  assert.match(serializedRecords, /"cursorPresent":true/);
});

test("ignores unrelated requests and reports abandoned observed requests", () => {
  const harness = createHarness();
  const unrelatedKey = harness.tracker.beginRequest({
    id: 1,
    method: "account/read",
    params: {},
  });
  assert.equal(unrelatedKey, null);

  harness.setNs(10_000_000);
  const key = harness.tracker.beginRequest(
    {
      id: 2,
      method: "thread/list",
      params: {},
    },
    { receivedAtNs: 10_000_000n },
  );
  harness.tracker.recordStdinWrite(key, {
    completedAtNs: 11_000_000n,
  });
  harness.setNs(40_000_000);
  harness.tracker.abandonPending("client_disconnected");

  assert.deepEqual(
    harness.records.map((record) => record.event),
    [
      "proxy.request_received",
      "proxy.request_forwarded",
      "proxy.request_abandoned",
    ],
  );
  assert.equal(harness.records.at(-1).elapsedMs, 30);
  assert.equal(harness.records.at(-1).reason, "client_disconnected");
  assert.equal(harness.records.at(-1).rpcMethod, "thread/list");
});

test("becomes a no-op when performance logging is disabled by environment", () => {
  const records = [];
  const previousGeneralValue = process.env.CODEX_THREAD_PERF_LOGGING;
  const previousListValue = process.env.CODEX_THREAD_LIST_PERF_LOGGING;
  delete process.env.CODEX_THREAD_PERF_LOGGING;
  process.env.CODEX_THREAD_LIST_PERF_LOGGING = "0";
  try {
    const tracker = createThreadProxyPerfTracker({
      emit: (record) => records.push(record),
    });

    const key = tracker.beginRequest({
      id: 12,
      method: "thread/list",
      params: {
        cursor: "cursor",
        searchTerm: "search",
      },
    });
    tracker.recordStdinWrite(key);
    tracker.recordStdinDrain();
    tracker.observeAppServerStdout(
      Buffer.from('{"id":12,"result":{"data":[]}}\n'),
    );
    tracker.abandonPending();

    assert.equal(key, null);
    assert.deepEqual(records, []);
  } finally {
    if (previousGeneralValue === undefined) {
      delete process.env.CODEX_THREAD_PERF_LOGGING;
    } else {
      process.env.CODEX_THREAD_PERF_LOGGING = previousGeneralValue;
    }
    if (previousListValue === undefined) {
      delete process.env.CODEX_THREAD_LIST_PERF_LOGGING;
    } else {
      process.env.CODEX_THREAD_LIST_PERF_LOGGING = previousListValue;
    }
  }
});
