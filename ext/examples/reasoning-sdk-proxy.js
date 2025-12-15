#!/usr/bin/env node
/**
 * Reasoning loop via the Codex SDK proxy.
 * ---------------------------------------
 * Connects to the sdk-proxy TCP endpoint (inside Docker by default), submits
 * prompts over the Codex TypeScript SDK, and streams agent replies while hiding
 * reasoning details. Maintains a single thread across prompts so conversation
 * state is preserved between turns.
 */

const net = require("node:net");
const readline = require("node:readline");

const host = process.env.CODEX_SDK_PROXY_HOST || "127.0.0.1";
const port = (() => {
  const raw = process.env.CODEX_SDK_PROXY_PORT;
  if (!raw) {
    return 9400;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 9400 : parsed;
})();

let threadId = process.env.CODEX_THREAD_ID || null;
let activeRun = null;

const socket = net.createConnection({ host, port }, () => {
  console.log(`Connected to sdk-proxy at ${host}:${port}`);
  promptLoop();
});

const lines = readline.createInterface({ input: socket });

socket.on("error", (error) => {
  console.error("Proxy connection error:", error.message);
  process.exitCode = 1;
});

socket.on("close", () => {
  console.log("Disconnected from proxy");
  process.exit(activeRun ? 1 : 0);
});

function send(payload) {
  socket.write(`${JSON.stringify(payload)}\n`);
}

function buildArgs(input) {
  return {
    input,
    threadId: threadId || undefined,
    model: process.env.CODEX_MODEL,
    sandboxMode: process.env.CODEX_SANDBOX_MODE,
    workingDirectory: process.env.CODEX_WORKDIR,
    additionalDirectories: process.env.CODEX_EXTRA_DIRS?.split(",")?.filter(Boolean),
    outputSchemaFile: process.env.CODEX_OUTPUT_SCHEMA,
    modelReasoningEffort: process.env.CODEX_MODEL_REASONING_EFFORT,
    networkAccessEnabled: process.env.CODEX_NETWORK_ACCESS === "1",
    webSearchEnabled: process.env.CODEX_WEB_SEARCH === "1",
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY,
  };
}

function startRun(input, onTurnDone) {
  if (activeRun) {
    console.error("A turn is already running; wait for it to finish.");
    return;
  }

  const args = buildArgs(input);
  activeRun = {
    latestMessage: "",
    onTurnDone,
  };
  send({
    action: "exec",
    args,
    env: {
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    },
  });
}

function handleThreadEvent(event) {
  if (event.type === "thread.started" && event.thread_id) {
    threadId = event.thread_id;
    return;
  }

  if (event.type === "item.updated" || event.type === "item.completed") {
    const item = event.item;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      activeRun.latestMessage = item.text;
      return;
    }

    if (item?.type === "reasoning" && event.type === "item.updated") {
      process.stdout.write(".");
      return;
    }
  }

  if (event.type === "turn.completed") {
    if (activeRun.latestMessage) {
      if (activeRun.latestMessage.endsWith("\n")) {
        process.stdout.write("\n");
      }
      console.log(activeRun.latestMessage.trim());
    } else {
      console.log("Turn completed without an agent message.");
    }
    activeRun.onTurnDone();
    activeRun = null;
    return;
  }

  if (event.type === "turn.failed") {
    console.error("Turn failed:", event.error?.message ?? "unknown error");
    activeRun.onTurnDone();
    activeRun = null;
  }
}

lines.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error("Failed to parse proxy message:", line);
    return;
  }

  if (!activeRun) {
    console.warn("Received message with no active turn:", message);
    return;
  }

  switch (message.type) {
    case "stdout": {
      try {
        const event = JSON.parse(message.line);
        handleThreadEvent(event);
      } catch (error) {
        console.error("Unable to parse event:", error?.message ?? error);
      }
      break;
    }
    case "error":
      console.error("Proxy error:", message.message ?? "unknown error");
      activeRun.onTurnDone();
      activeRun = null;
      break;
    case "done":
      if (activeRun) {
        activeRun.onTurnDone();
        activeRun = null;
      }
      break;
    default:
      console.warn("Unknown proxy message:", message);
  }
});

function askQuestion(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const prompt = await askQuestion("\nEnter a prompt (or type 'exit' to quit): ");
    if (!prompt || prompt.toLowerCase() === "exit") {
      console.log("Goodbye.");
      socket.end();
      return;
    }

    await new Promise((resolve) => {
      startRun(prompt, resolve);
    });
  }
}
