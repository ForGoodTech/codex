# Codex Extensions

This directory is a staging area for fork-only add-ons and generated assets. It now includes:

- `app-server-protocol-export/` – Generated TypeScript bindings and JSON Schemas for the Codex app-server protocol.
- `examples/` – Standalone scripts that show how to talk to the app server; start with `hello-app-server.js` for a minimal JSON-RPC client. The examples expect an already-running `codex app-server` exposed via stdio (e.g., FIFOs as documented in the example header).

## Starting the app server from this repo

Assuming the CLI is already built, launch the app server from the repository root so examples can attach:

1. (Optional) Create shared FIFOs so multiple terminals can share the same server without mixing streams:

   ```shell
   mkfifo /tmp/codex-app-server.in /tmp/codex-app-server.out
   ```

2. Start the server, wiring stdio directly or via the FIFOs above. The `--manifest-path` flag keeps the command rooted here while targeting the `codex-rs` workspace:

   ```shell
   # Plain stdio
   cargo run --manifest-path codex-rs/Cargo.toml -p codex -- app-server
   # Or with the FIFOs created in step 1
   cargo run --manifest-path codex-rs/Cargo.toml -p codex -- app-server < /tmp/codex-app-server.in > /tmp/codex-app-server.out
   ```

3. Leave the server running and connect clients by writing JSONL (JSON-RPC 2.0 messages without the `jsonrpc` field) to the input stream and reading notifications from the output stream.
