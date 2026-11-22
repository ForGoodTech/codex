# Codex Extensions

This directory contains helper assets for running Codex outside the main
workspace. The runtime-specific material lives under the target directories,
while shared protocol and example assets stay here.

Fork-specific changes are confined to `ext/`; files outside it follow upstream.

## Runtime targets

- `docker/pi/` - builds a Docker image that packages the Codex CLI,
  `codex-app-server`, and TCP proxies for the app server and Codex SDK. See
  [docker/pi/README.md](docker/pi/README.md).
- `vm/pi/` - builds a Firecracker-oriented root filesystem for running the
  Codex app-server proxy inside a disposable microVM. See
  [vm/pi/README.md](vm/pi/README.md).

## Shared assets

- `app-server-protocol-export/` - Generated TypeScript bindings and JSON
  Schemas used as a development reference for the Codex app-server protocol.
- `examples/` - Standalone scripts that demonstrate talking to the app server
  and SDK proxy. These are most often used with the Docker proxy workflow.

## Protocol exports

On the fork checkout prepared for `rust-v0.171.0`, run this Bash block from
the Codex repository root. Rustup selects the toolchain from the checkout
and Cargo builds the CLI from source. The block exports TypeScript and
JSON Schema, including experimental APIs, and replaces the previous snapshot
after both exports succeed.

```bash
(
  set -euo pipefail
  protocol_export_dir=$(mktemp -d "$PWD/ext/.app-server-protocol-export.XXXXXXXX")
  trap 'rm -rf -- "$protocol_export_dir"' EXIT

  (
    cd codex-rs
    cargo run -p codex-cli --bin codex -- \
      app-server generate-ts --experimental \
      --out "$protocol_export_dir"

    cargo run -p codex-cli --bin codex -- \
      app-server generate-json-schema --experimental \
      --out "$protocol_export_dir"
  )

  printf '%s\n' 'rust-v0.171.0' > "$protocol_export_dir/.codex-release"
  rm -rf -- ext/app-server-protocol-export
  mv -- "$protocol_export_dir" ext/app-server-protocol-export
  git diff --stat -- ext/app-server-protocol-export
  git status --short -- ext/app-server-protocol-export
)
```

Review, commit, and push the changes under `ext/app-server-protocol-export/`,
including `.codex-release`. SurestInfo CI checks the marker against the pinned
runtime version.
