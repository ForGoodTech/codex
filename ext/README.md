# Codex Extensions

This directory is a staging area for fork-only add-ons and generated assets. It now includes:

- `app-server-protocol-export/` – Generated TypeScript bindings and JSON Schemas for the Codex app-server protocol.
- `examples/` – Standalone scripts that show how to talk to the app server; start with `hello-app-server.js` for a minimal JSON-RPC client. The examples expect an already-running `codex app-server` exposed via stdio (e.g., FIFOs as documented in the example header).
