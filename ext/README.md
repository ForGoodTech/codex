# Codex Extensions

This directory contains helper assets for running Codex outside the main
workspace. The runtime-specific material lives under the target directories,
while shared protocol and example assets stay here.

## Runtime targets

- `docker/pi/` - builds a Docker image that packages the Codex CLI,
  `codex-app-server`, and TCP proxies for the app server and Codex SDK. See
  [docker/pi/README.md](docker/pi/README.md).
- `vm/pi/` - builds a Firecracker-oriented root filesystem for running the
  Codex app-server proxy inside a disposable microVM. See
  [vm/pi/README.md](vm/pi/README.md).

## Shared assets

- `app-server-protocol-export/` - Generated TypeScript bindings and JSON
  Schemas for the Codex app-server protocol.
- `examples/` - Standalone scripts that demonstrate talking to the app server
  and SDK proxy. These are most often used with the Docker proxy workflow.

## Protocol exports

To regenerate `app-server-protocol-export/` from the Rust protocol definitions,
run this from the repository root:

```shell
cargo run --manifest-path codex-rs/Cargo.toml \
  -p codex-app-server-protocol \
  --bin export \
  -- \
  --out ext/app-server-protocol-export/
```
