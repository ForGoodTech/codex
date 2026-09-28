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

The `export` binary in `codex-app-server-protocol` has been removed. Use the
`codex` CLI's `app-server generate-ts` and `app-server generate-json-schema`
commands to export the TypeScript bindings and JSON Schemas, respectively.

Run the following Bash snippet from the **Codex repository root** (`codex/` in
the parent workspace). It builds the CLI from the current checkout and includes
the experimental API used by the gateway. Both exports go into a fresh directory
before replacing the snapshot, so obsolete files are removed and an export
failure leaves the existing snapshot intact:

```bash
(
  set -euo pipefail
  protocol_export_dir=$(mktemp -d ext/.app-server-protocol-export.XXXXXXXX)
  trap 'rm -rf -- "$protocol_export_dir"' EXIT

  cargo run --manifest-path codex-rs/Cargo.toml \
    -p codex-cli --bin codex -- \
    app-server generate-ts --experimental \
    --out "$protocol_export_dir"

  cargo run --manifest-path codex-rs/Cargo.toml \
    -p codex-cli --bin codex -- \
    app-server generate-json-schema --experimental \
    --out "$protocol_export_dir"

  rm -rf -- ext/app-server-protocol-export
  mv -- "$protocol_export_dir" ext/app-server-protocol-export
  git diff --stat -- ext/app-server-protocol-export
  git status --short -- ext/app-server-protocol-export
)
```

To export the protocol for a deployed runtime release, use that release's
`codex` executable instead. Check `codex --version` against the runtime build's
`CODEX_RELEASE_VERSION` (see [docker/pi/README.md](docker/pi/README.md)). In the
snippet above, replace each `cargo run --manifest-path codex-rs/Cargo.toml -p
codex-cli --bin codex --` prefix with `codex`, keeping the `app-server` arguments.
The checked-out source can differ from the release used by the runtime.

These commands unpack precomputed exports bundled with the CLI. Repeating an
export with the same bundles and options should produce no changes. If you edit
the Rust protocol definitions, first regenerate the bundles from the Codex
repository root, then rerun the Cargo snippet above to rebuild the CLI and export
them:

```shell
just write-app-server-schema
just write-app-server-schema --experimental
```

The stable regeneration command also updates the Python SDK's generated types.
