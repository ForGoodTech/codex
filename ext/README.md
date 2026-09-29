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

`app-server-protocol-export/` is a reference for developers and coding agents
working with the Codex app-server protocol. The runtime images do not consume
this directory.

### Building and releasing images

**You do not need to export the protocol or check your locally installed Codex
version to build or release the Pi, Camera, and Pi Web images.** Follow the image
build instructions for those targets.

The image build scripts use `CODEX_RELEASE_TAG` to select the release when
building the base runtime. The host's installed `codex` does not select that
version. Image builds do not regenerate the reference snapshot; updating the
release pin and refreshing the reference are separate maintenance tasks.

### Refreshing the reference during development

Refresh and review the reference when following upstream protocol changes.
Use a release's executable for a snapshot of that release, or the checked-out
source to inspect upstream development. The source checkout can contain changes
beyond the release selected for an image build.

The `export` binary in `codex-app-server-protocol` has been removed. Use the
`codex` CLI's `app-server generate-ts` and `app-server generate-json-schema`
commands to export the TypeScript bindings and JSON Schemas, respectively.

To export from the **current source checkout**, run the following Bash snippet
from the **Codex repository root**. It builds the CLI from the current checkout
and includes experimental methods and fields. Both exports go into a fresh
directory before replacing the snapshot, so obsolete files are removed and an
export failure leaves the existing snapshot intact:

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

For a **reference matching a particular release**, use that release's `codex`
executable and verify its version with `codex --version`. To match an image's
protocol, use the version selected by its `CODEX_RELEASE_TAG`. Inside the snippet
above, replace the two Cargo commands with these commands, keeping the same
staging and replacement steps:

```shell
codex app-server generate-ts --experimental --out "$protocol_export_dir"
codex app-server generate-json-schema --experimental --out "$protocol_export_dir"
```

This version check applies only to maintaining the reference snapshot.

The export commands unpack upstream's precomputed protocol bundles included in
the selected CLI. Repeating an export with the same bundles and options should
produce no changes. Maintaining this snapshot requires no edits to upstream's
Rust definitions or generated SDK files.
