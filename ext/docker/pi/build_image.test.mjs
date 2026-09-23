import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

// Exercise the actual script, tar extraction and npm packaging. Only external
// downloads and Docker are simulated so failure tests cannot affect a runtime.
function mockCommand() {
  const fs = require("node:fs");
  const path = require("node:path");
  const { createHash } = require("node:crypto");
  const args = process.argv.slice(2);
  const command = path.basename(process.argv[1]);
  const failure = process.env.TEST_FAILURE;
  process.on("uncaughtException", (error) => {
    fs.appendFileSync(
      process.env.TEST_LOG,
      JSON.stringify({ command: "mock-error", args: [error.stack] }) + "\n",
    );
    process.exit(1);
  });
  fs.appendFileSync(
    process.env.TEST_LOG,
    JSON.stringify({ command, args }) + "\n",
  );
  if (command === "curl") {
    if (failure === "download") process.exit(22);
    fs.copyFileSync(process.env.TEST_ARCHIVE, args[args.indexOf("-o") + 1]);
    process.exit(0);
  }

  const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE, "utf8"));
  if (args[0] === "info") {
    if (failure === "daemon") process.exit(1);
    console.log(process.env.TEST_PLATFORM);
  } else if (args[0] === "build") {
    if (failure === "build") process.exit(1);
    state.temporary = args[args.indexOf("-t") + 1];
  } else if (args[0] === "image" && args[1] === "inspect") {
    assertCandidate(args.at(-1));
    const contract = fs.readFileSync(
      path.join(process.env.TEST_PI_DIR, "runtime-image-contract.sh"),
      "utf8",
    );
    console.log(
      failure === "contract"
        ? "stale"
        : contract.match(
            /^CODEX_RUNTIME_IMAGE_CONTRACT_VERSION="?(\d+)"?$/m,
          )[1],
    );
  } else if (args[0] === "run" && args.includes("sha256sum")) {
    const index = args.indexOf("sha256sum");
    assertCandidate(args[index + 1]);
    for (const file of args.slice(index + 2)) {
      const content = fs.readFileSync(
        path.join(process.env.TEST_PI_DIR, path.basename(file)),
      );
      const hash = createHash("sha256").update(content).digest("hex");
      console.log((failure === "assets" ? "0".repeat(64) : hash) + "  " + file);
    }
  } else if (args[0] === "run") {
    assertCandidate(args[args.indexOf("bash") - 1]);
    if (failure === "smoke") process.exit(1);
    state.verified = true;
  } else if (args[0] === "image" && args[1] === "tag") {
    assertCandidate(args[2]);
    if (!state.verified) throw new Error("Image promoted before validation");
    if (failure === "promotion") process.exit(1);
    state.current = "new";
  } else if (args[0] === "image" && args[1] === "rm") {
    if (!args[2].startsWith("codex-pi-build:")) {
      throw new Error("Attempt to remove an existing runtime image");
    }
    state.temporary = null;
  } else {
    throw new Error("Unexpected Docker operation: " + args.join(" "));
  }
  fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));

  function assertCandidate(image) {
    if (!state.temporary || image !== state.temporary) {
      throw new Error("Validation did not use the newly built image");
    }
  }
}

function runBuild(t, { failure = "", platform = "linux/aarch64" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-build-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "checkout with spaces");
  const piDir = path.join(repo, "ext/docker/pi");
  const bin = path.join(root, "bin");
  const temporary = path.join(root, "tmp");
  mkdirSync(path.join(repo, "codex-cli"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(temporary);
  cpSync(sourceDir, piDir, { recursive: true });
  const shim =
    "#!" + process.execPath + "\n(" + mockCommand.toString() + ")();\n";
  for (const command of ["docker", "curl"]) {
    writeFileSync(path.join(bin, command), shim, { mode: 0o755 });
  }
  // Keep the tests independent of the host architecture.
  const packageDir = path.join(root, "package");
  for (const triple of [
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl",
  ]) {
    const vendor = path.join(packageDir, "vendor", triple);
    mkdirSync(path.join(vendor, "bin"), { recursive: true });
    writeFileSync(path.join(vendor, "bin/codex"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    writeFileSync(path.join(vendor, "codex-package.json"), "{}\n");
  }
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "0.155.1",
      files: ["vendor"],
    }),
  );
  const archive = path.join(root, "release.tgz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", root, "package"]);
  assert.equal(tar.status, 0, tar.stderr?.toString());
  const statePath = path.join(root, "state.json");
  const logPath = path.join(root, "calls.jsonl");
  writeFileSync(statePath, JSON.stringify({ current: "old", temporary: null }));
  writeFileSync(logPath, "");

  let commandPath = bin + path.delimiter + process.env.PATH;
  if (failure === "missing-tool") {
    // A controlled PATH with every prerequisite except curl.
    const restricted = path.join(root, "restricted");
    mkdirSync(restricted);
    for (const tool of [
      "bash",
      "dirname",
      "realpath",
      "docker",
      "node",
      "npm",
      "tar",
      "mktemp",
      "sha256sum",
      "awk",
      "find",
      "head",
    ]) {
      const resolved = spawnSync(
        "bash",
        ["-c", 'command -v "$1"', "test", tool],
        {
          env: { ...process.env, PATH: commandPath },
          encoding: "utf8",
        },
      );
      assert.equal(resolved.status, 0, "Missing test dependency " + tool);
      symlinkSync(resolved.stdout.trim(), path.join(restricted, tool));
    }
    commandPath = restricted;
  }

  const result = spawnSync(
    "bash",
    [path.join(piDir, "build_image.sh"), "existing-runtime"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: commandPath,
        TMPDIR: temporary,
        TEST_FAILURE: failure,
        TEST_PLATFORM: platform,
        TEST_PI_DIR: piDir,
        TEST_ARCHIVE: archive,
        TEST_STATE: statePath,
        TEST_LOG: logPath,
        npm_config_cache: path.join(root, "npm-cache"),
      },
    },
  );
  assert.ifError(result.error);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.deepEqual(
    calls.filter(({ command }) => command === "mock-error"),
    [],
  );
  assert.deepEqual(
    readdirSync(temporary).filter((name) => name.startsWith("codex-pi-build.")),
    [],
    "Temporary build files were leaked",
  );
  assert.equal(existsSync(path.join(repo, "sdk/typescript/dist")), false);
  return {
    ...result,
    calls,
    state: JSON.parse(readFileSync(statePath, "utf8")),
  };
}

for (const [platform, expected, npmPlatform] of [
  ["linux/aarch64", "linux/arm64", "linux-arm64"],
  ["linux/x86_64", "linux/amd64", "linux-x64"],
]) {
  test("validates and promotes a fresh build for " + platform, (t) => {
    const result = runBuild(t, { platform });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.state, {
      current: "new",
      temporary: null,
      verified: true,
    });
    const build = result.calls.find(({ args }) => args[0] === "build");
    assert.equal(build.args[build.args.indexOf("--platform") + 1], expected);
    const downloads = result.calls.filter(({ command }) => command === "curl");
    assert(
      downloads.some(({ args }) =>
        args.some((arg) => arg.includes(npmPlatform)),
      ),
    );
    assert(downloads.every(({ args }) => args.includes("--retry")));
  });
}

for (const [failure, expectedCommand] of [
  ["download", "curl"],
  ["build", "build"],
  ["contract", "inspect"],
  ["assets", "sha256sum"],
  ["smoke", "bash"],
  ["promotion", "tag"],
]) {
  test(failure + " failure preserves the previous image", (t) => {
    const result = runBuild(t, { failure });
    assert.notEqual(result.status, 0);
    assert(
      result.calls.some(
        ({ command, args }) =>
          command === expectedCommand || args.includes(expectedCommand),
      ),
      "The intended failure stage was not reached",
    );
    assert.equal(result.state.current, "old");
    assert.equal(result.state.temporary, null);
  });
}

for (const [failure, platform, message] of [
  ["missing-tool", "linux/aarch64", /Missing build tools: curl/],
  ["daemon", "linux/aarch64", /Cannot access Docker/],
  ["", "linux/armv7l", /Unsupported Docker platform/],
  ["", "windows/amd64", /Unsupported Docker platform/],
]) {
  test("preflight stops before downloading: " + (failure || platform), (t) => {
    const result = runBuild(t, { failure, platform });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.state.current, "old");
    assert(!result.calls.some(({ command }) => command === "curl"));
    assert(!result.calls.some(({ args }) => args[0] === "build"));
  });
}
