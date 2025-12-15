#!/usr/bin/env node
/*
 * Simple client for the SDK TCP proxy.
 *
 * This script connects to the sdk-proxy TCP port (default 9400) and sends
 * one exec request. The proxy streams Codex SDK events back as JSONL and we
 * print them as they arrive.
 */

const net = require("node:net");

const host = process.env.CODEX_SDK_PROXY_HOST || "127.0.0.1";
const port = (() => {
  const raw = process.env.CODEX_SDK_PROXY_PORT;
  if (!raw) {
    return 9400;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`Invalid CODEX_SDK_PROXY_PORT (${raw}); falling back to 9400.`);
    return 9400;
  }
  return parsed;
})();

function requestFromArgs(prompt) {
  return {
    action: "exec",
    args: {
      input: prompt,
      model: process.env.CODEX_MODEL,
      sandboxMode: process.env.CODEX_SANDBOX_MODE,
      workingDirectory: process.env.CODEX_WORKDIR,
      additionalDirectories: process.env.CODEX_EXTRA_DIRS?.split(",")?.filter(Boolean),
      outputSchemaFile: process.env.CODEX_OUTPUT_SCHEMA,
      modelReasoningEffort: process.env.CODEX_MODEL_REASONING_EFFORT,
      networkAccessEnabled: process.env.CODEX_NETWORK_ACCESS === "1",
      webSearchEnabled: process.env.CODEX_WEB_SEARCH === "1",
      approvalPolicy: process.env.CODEX_APPROVAL_POLICY,
    },
    env: {
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    },
  };
}

function main() {
  const prompt = process.argv.slice(2).join(" ") || "explain what this script does";
  const socket = net.createConnection({ host, port }, () => {
    console.log(`Connected to sdk-proxy at ${host}:${port}`);
    socket.write(`${JSON.stringify(requestFromArgs(prompt))}\n`);
  });

  socket.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        console.log("proxy ->", message);
      } catch (error) {
        console.error("Failed to parse proxy message:", line, error);
      }
    }
  });

  socket.on("close", () => {
    console.log("Disconnected from proxy");
  });

  socket.on("error", (error) => {
    console.error("Proxy connection error:", error.message);
    process.exitCode = 1;
  });
}

main();
