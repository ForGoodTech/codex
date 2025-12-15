#!/usr/bin/env node
/**
 * Codex SDK TCP proxy (ext/docker/pi/sdk-proxy.js)
 *
 * What this does
 * --------------
 * - Listens on a TCP port (default 9400) for a single client at a time, just like
 *   the app-server proxy.
 * - Receives one JSONL control message `{ action: "exec", args, env }` that
 *   mirrors the Codex SDK exec options.
 * - Uses the Codex TypeScript SDK inside the container to run the turn and streams
 *   each emitted event back to the client as `{ type: "stdout", line }` so the
 *   client SDK can consume it transparently.
 * - Supports `{ action: "abort" }` to cancel the in-flight turn.
 *
 * Usage
 * -----
 * Inside the container:
 *   codex-sdk-proxy
 *
 * Start the container with a published port (default 9400). Client SDK scripts
 * should connect to the forwarded port, not to a local Codex binary.
 */

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { pathToFileURL } = require("node:url");

const host = process.env.CODEX_SDK_PROXY_HOST ?? "0.0.0.0";
const defaultPort = 9400;
const port = (() => {
  const raw = process.env.CODEX_SDK_PROXY_PORT;
  if (!raw) {
    return defaultPort;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`Ignoring invalid CODEX_SDK_PROXY_PORT value (${raw}); using ${defaultPort}.`);
    return defaultPort;
  }

  return parsed;
})();

let activeSocket = null;
let activeAbortController = null;
let sdkLoadPromise = null;

const SDK_EXPORT_PATH = path.join(__dirname, "..", "..", "sdk", "typescript", "dist", "index.js");
const INSTALLED_SDK_EXPORT_PATH = path.join(__dirname, "codex-sdk-dist", "index.js");
const sdkCandidates = [
  "@openai/codex-sdk",
  pathToFileURL(INSTALLED_SDK_EXPORT_PATH).href,
  pathToFileURL(SDK_EXPORT_PATH).href,
];

async function loadSdk() {
  if (sdkLoadPromise) {
    return sdkLoadPromise;
  }

  sdkLoadPromise = (async () => {
    for (const candidate of sdkCandidates) {
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(candidate).catch((error) => {
        console.warn(`Failed to load Codex SDK from ${candidate}:`, error?.message ?? error);
        return null;
      });
      if (mod) {
        return mod;
      }
    }
    throw new Error("Unable to load Codex SDK. Ensure @openai/codex-sdk is available.");
  })();

  return sdkLoadPromise;
}

function send(socket, payload) {
  socket.write(`${JSON.stringify(payload)}\n`);
}

function buildThreadOptions(args) {
  return {
    model: args.model,
    sandboxMode: args.sandboxMode,
    workingDirectory: args.workingDirectory,
    skipGitRepoCheck: args.skipGitRepoCheck,
    modelReasoningEffort: args.modelReasoningEffort,
    networkAccessEnabled: args.networkAccessEnabled,
    webSearchEnabled: args.webSearchEnabled,
    approvalPolicy: args.approvalPolicy,
    additionalDirectories: Array.isArray(args.additionalDirectories) ? args.additionalDirectories : undefined,
  };
}

function normalizeInput(args) {
  const images = Array.isArray(args.images) ? args.images : [];
  if (images.length === 0) {
    return args.input;
  }

  const items = [{ type: "text", text: args.input }];
  for (const imageEntry of images) {
    if (typeof imageEntry === "string") {
      items.push({ type: "local_image", path: imageEntry });
      continue;
    }

    if (!imageEntry || typeof imageEntry !== "object") {
      continue;
    }

    if (typeof imageEntry.url === "string") {
      items.push({ type: "image", url: imageEntry.url });
      continue;
    }

    if (typeof imageEntry.dataUrl === "string") {
      items.push({ type: "image", url: imageEntry.dataUrl });
      continue;
    }

    if (typeof imageEntry.path === "string") {
      items.push({ type: "local_image", path: imageEntry.path });
    }
  }
  return items;
}

function readOutputSchema(outputSchemaFile) {
  if (!outputSchemaFile) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(outputSchemaFile, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to read output schema file at ${outputSchemaFile}: ${error?.message ?? error}`);
  }
}

async function handleExec(socket, message) {
  if (activeAbortController) {
    send(socket, { type: "error", message: "A run is already in progress; try again later." });
    return;
  }

  const { args, env } = message;
  if (!args || typeof args.input !== "string") {
    send(socket, { type: "error", message: "Missing or invalid args.input in exec request." });
    return;
  }

  const sdk = await loadSdk();
  const Codex = sdk?.Codex;
  if (!Codex) {
    send(socket, { type: "error", message: "Codex SDK is unavailable in the proxy." });
    return;
  }

  const threadOptions = buildThreadOptions(args);
  let outputSchema;
  try {
    outputSchema = readOutputSchema(args.outputSchemaFile);
  } catch (error) {
    send(socket, { type: "error", message: error?.message ?? String(error) });
    return;
  }

  const input = normalizeInput(args);
  activeAbortController = new AbortController();

  const codexOptions = {
    baseUrl: args.baseUrl ?? env?.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
    apiKey: args.apiKey ?? env?.CODEX_API_KEY ?? process.env.CODEX_API_KEY,
    env: env ?? undefined,
  };

  const codex = new Codex(codexOptions);
  const thread = args.threadId ? codex.resumeThread(args.threadId, threadOptions) : codex.startThread(threadOptions);

  try {
    const { events } = await thread.runStreamed(input, { signal: activeAbortController.signal, outputSchema });
    for await (const event of events) {
      send(socket, { type: "stdout", line: JSON.stringify(event) });
    }
    send(socket, { type: "done", code: 0 });
  } catch (error) {
    if (activeAbortController?.signal.aborted) {
      send(socket, { type: "error", message: "Run aborted by client." });
    } else {
      send(socket, { type: "error", message: error?.message ?? String(error) });
    }
  } finally {
    activeAbortController = null;
  }
}

const server = net.createServer((socket) => {
  if (activeSocket) {
    socket.destroy(new Error("Proxy already has an active client; try again later."));
    return;
  }

  activeSocket = socket;
  console.log(`SDK proxy client connected from ${socket.remoteAddress}:${socket.remotePort}`);

  const lineReader = readline.createInterface({
    input: socket,
    crlfDelay: Infinity,
  });

  const cleanup = () => {
    lineReader.close();
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    if (!socket.destroyed) {
      socket.end();
    }
    activeSocket = null;
    console.log("Client disconnected; proxy ready for the next connection.");
  };

  lineReader.on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      send(socket, { type: "error", message: `Invalid JSON: ${line}` });
      return;
    }

    switch (message.action) {
      case "exec":
        handleExec(socket, message).catch((error) => {
          send(socket, { type: "error", message: error?.message ?? String(error) });
        });
        break;
      case "abort":
        if (activeAbortController) {
          activeAbortController.abort();
        }
        break;
      default:
        send(socket, { type: "error", message: `Unknown action: ${message.action}` });
        break;
    }
  });

  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

server.listen(port, host, () => {
  console.log(`SDK proxy listening on ${host}:${port}`);
});

process.on("SIGINT", () => {
  console.log("Shutting down SDK proxy...");
  server.close();
  if (activeAbortController) {
    activeAbortController.abort();
  }
});
