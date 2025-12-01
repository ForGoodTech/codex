#!/bin/bash

# Build a Codex Docker image for interactive use on Raspberry Pi/Ubuntu.
# This script builds the Codex binary from the local repository and stages
# vendor assets without relying on published npm artifacts.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
CLI_ROOT="$REPO_ROOT/codex-cli"
RUST_ROOT="$REPO_ROOT/codex-rs"
IMAGE_TAG=${CODEX_INTERACTIVE_IMAGE_TAG:-codex-interactive}
VENDOR_DIR="$CLI_ROOT/vendor"

if [[ ! -d "$CLI_ROOT" ]]; then
  echo "Codex CLI directory not found at: $CLI_ROOT" >&2
  exit 1
fi

if [[ ! -d "$RUST_ROOT" ]]; then
  echo "codex-rs directory not found at: $RUST_ROOT" >&2
  exit 1
fi

# Determine the target triple expected by the CLI launcher.
ARCH=$(uname -m)
case "$ARCH" in
  aarch64)
    TARGET_TRIPLE="aarch64-unknown-linux-musl"
    ;;
  x86_64)
    TARGET_TRIPLE="x86_64-unknown-linux-musl"
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

pushd "$CLI_ROOT" > /dev/null

pnpm install

# Build the native Codex binary from the local workspace.
pushd "$RUST_ROOT" > /dev/null
cargo build --release -p codex-cli --bin codex
popd > /dev/null

CODEX_BIN_SRC="$RUST_ROOT/target/release/codex"
if [[ ! -x "$CODEX_BIN_SRC" ]]; then
  echo "Built Codex binary not found at $CODEX_BIN_SRC" >&2
  exit 1
fi

RG_BIN_SRC=$(command -v rg || true)
if [[ -z "$RG_BIN_SRC" ]]; then
  echo "ripgrep (rg) not found in PATH. Install it before running this script." >&2
  exit 1
fi

TARGET_VENDOR="$VENDOR_DIR/$TARGET_TRIPLE"
rm -rf "$TARGET_VENDOR"
mkdir -p "$TARGET_VENDOR/codex" "$TARGET_VENDOR/path"
install -Dm755 "$CODEX_BIN_SRC" "$TARGET_VENDOR/codex/codex"
install -Dm755 "$RG_BIN_SRC" "$TARGET_VENDOR/path/rg"

mkdir -p dist
rm -f dist/openai-codex-*.tgz dist/codex.tgz
pnpm pack --pack-destination dist
mv dist/openai-codex-*.tgz dist/codex.tgz

docker build -t "$IMAGE_TAG" -f Dockerfile .

popd > /dev/null
