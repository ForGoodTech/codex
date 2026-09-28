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

The checked-in snapshot matches the fork's upstream `rust-v0.157.1` base and
the Docker runtime release. It includes experimental methods and fields because
the SurestInfo gateway enables `experimentalApi` during initialization.

Upstream removed the `codex-app-server-protocol` `export` binary. Use the matching
Codex executable's export commands instead. From this repository's root, run
the following in Bash; set `CODEX_BIN` to an absolute executable path if the
`codex` on your PATH is a different version:

```shell
(
  set -euo pipefail
  codex_bin=${CODEX_BIN:-codex}
  codex_version=$("$codex_bin" --version)
  if [[ "$codex_version" != "codex-cli 0.157.1" ]]; then
    printf 'Expected codex-cli 0.157.1, got %s; set CODEX_BIN to the matching executable.\n' "$codex_version" >&2
    exit 1
  fi

  protocol_export_dir=$(mktemp -d ext/.app-server-protocol-export.XXXXXXXX)
  trap 'rm -rf -- "$protocol_export_dir"' EXIT
  "$codex_bin" app-server generate-ts --experimental --out "$protocol_export_dir"
  "$codex_bin" app-server generate-json-schema --experimental --out "$protocol_export_dir"

  rm -rf -- ext/app-server-protocol-export
  mv -- "$protocol_export_dir" ext/app-server-protocol-export
) && git diff --stat -- ext/app-server-protocol-export
```

Both exports must succeed before the old snapshot is replaced. Starting from
an empty directory also removes types and schemas deleted upstream. Repeating
the export with the same executable and options should leave no additional
changes.

These CLI commands extract precomputed schemas bundled into the executable.
After editing Rust protocol definitions locally, run `just write-app-server-schema`
and `just write-app-server-schema --experimental` from `codex-rs/`, rebuild the
Codex CLI, and point `CODEX_BIN` at that build before exporting. Keep the upstream
source revision, runtime release pins, executable version, and this snapshot
aligned when upgrading Codex.
