# Codex Extensions

This directory is a staging area for fork-only add-ons and generated assets. It now includes:

- `app-server-protocol-export/` – Generated TypeScript bindings and JSON Schemas for the Codex app-server protocol.
- `examples/` – Standalone scripts that show how to talk to the app server; start with `hello-app-server.js` for a minimal JSON-RPC client. The examples expect an already-running `codex app-server` exposed via stdio (e.g., FIFOs as documented in the example header).

## Starting the app server from this repo

Use these steps from the repository root to boot the Codex app server for the examples to consume:

1. Build the CLI binary from source (stay at repo root by using `--manifest-path`):

   ```shell
   cargo build --manifest-path codex-rs/Cargo.toml -p codex
   ```

2. (Optional) Create shared FIFOs so multiple terminals can attach to the same server without mixing streams:

   ```shell
   mkfifo /tmp/codex-app-server.in /tmp/codex-app-server.out
   ```

3. Start the server, wiring stdio directly or via the FIFOs above. Using `--manifest-path` lets you launch the binary from the repo root while pointing at the `codex-rs` workspace:

   ```shell
   # Plain stdio
   cargo run --manifest-path codex-rs/Cargo.toml -p codex -- app-server
   # Or with the FIFOs created in step 2
   cargo run --manifest-path codex-rs/Cargo.toml -p codex -- app-server < /tmp/codex-app-server.in > /tmp/codex-app-server.out
   ```

4. Leave the server running and connect clients by writing JSONL (JSON-RPC 2.0 messages without the `jsonrpc` field) to the input stream and reading notifications from the output stream.
