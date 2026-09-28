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
  Schemas used as a development reference for the Codex app-server protocol.
- `examples/` - Standalone scripts that demonstrate talking to the app server
  and SDK proxy. These are most often used with the Docker proxy workflow.

## Protocol exports

`app-server-protocol-export/` is a reference for developers and coding agents
working on the gateway. The gateway implements its protocol handling in Go;
it does not import these exported files, and the runtime images do not consume
this directory.

### Building and releasing images

**You do not need to export the protocol or check your locally installed Codex
version to build or release the Pi, Camera, and Pi Web images.** Follow the image
build instructions for those targets.

The local build scripts use `CODEX_RELEASE_TAG` to select the release when
building the base runtime. In the parent `surestinfo-workspace` repository, the
GitHub Production images workflow uses the pin in
`scripts/images/image-build-defaults.env` (or an explicit workflow override),
downloads and verifies the release assets, and builds the base runtime. Camera
and Web images in that workflow use the resulting base image's exact digest.
The host's installed `codex` does not select the runtime version.

Neither local image builds nor GitHub releases regenerate this reference
snapshot. Updating the Codex release pin and refreshing the reference are
separate repository maintenance tasks; release runs use the configured pin
without automatically advancing to newer upstream releases.

### Refreshing the reference during development

When a Codex upgrade changes the protocol, the developer or coding agent
maintaining the gateway should refresh and review the reference as part of that
upgrade. Exporting files alone does not update the gateway's implementation.

Choose the export source for the development task: use the deployed release's
executable to document the running runtime, or the checked-out source to inspect
upstream development. The source checkout can contain changes beyond the
deployed release.

The `export` binary in `codex-app-server-protocol` has been removed. Use the
`codex` CLI's `app-server generate-ts` and `app-server generate-json-schema`
commands to export the TypeScript bindings and JSON Schemas, respectively.

To export from the **current source checkout**, run the following Bash snippet
from the **Codex repository root** (`codex/` in the parent workspace).
It builds the CLI from the current checkout and includes
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

For a **reference matching a deployed release**, the maintainer doing the export
must use that release's `codex` executable. Verify its `codex --version` matches
the version in the build's `CODEX_RELEASE_TAG`. Inside the snippet above, replace
the two Cargo commands with these commands, keeping the same staging and
replacement steps:

```shell
codex app-server generate-ts --experimental --out "$protocol_export_dir"
codex app-server generate-json-schema --experimental --out "$protocol_export_dir"
```

This version check applies only to maintaining the reference snapshot.

### After editing Rust protocol definitions

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
