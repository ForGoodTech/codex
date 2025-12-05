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
BUILD_PROFILE=debug

if [[ $# -gt 2 ]]; then
  echo "Usage: $(basename "$0") [image-tag] [build-profile]" >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then
  IMAGE_TAG=$1
fi

if [[ $# -ge 2 ]]; then
  BUILD_PROFILE=$2
fi
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

# Build (or reuse) the native Codex binary from the local workspace.
case "$BUILD_PROFILE" in
  release)
    CODEX_BIN_SRC="$RUST_ROOT/target/release/codex"
    ;;
  debug)
    CODEX_BIN_SRC="$RUST_ROOT/target/debug/codex"
    ;;
  *)
    echo "Unknown build profile: $BUILD_PROFILE" >&2
    exit 1
    ;;
esac

if [[ ! -x "$CODEX_BIN_SRC" ]]; then
  pushd "$RUST_ROOT" > /dev/null
  if [[ "$BUILD_PROFILE" == "debug" ]]; then
    cargo build -p codex-cli --bin codex
  else
    cargo build --release -p codex-cli --bin codex
  fi
  popd > /dev/null
fi

if [[ ! -x "$CODEX_BIN_SRC" ]]; then
  echo "Built Codex binary not found at $CODEX_BIN_SRC" >&2
  exit 1
fi

function ensure_rg_binary() {
  local rg_path
  rg_path=$(command -v rg || true)
  if [[ -n "$rg_path" ]]; then
    echo "$rg_path"
    return
  fi

  if command -v apt-get >/dev/null 2>&1 && [[ $(id -u) -eq 0 ]]; then
    apt-get update
    apt-get install -y --no-install-recommends ripgrep
    rg_path=$(command -v rg || true)
    if [[ -n "$rg_path" ]]; then
      echo "$rg_path"
      return
    fi
  fi

  if command -v cargo >/dev/null 2>&1; then
    local rg_root="$RUST_ROOT/target/ripgrep-install"
    mkdir -p "$rg_root"
    cargo install --locked ripgrep --root "$rg_root"
    if [[ -x "$rg_root/bin/rg" ]]; then
      echo "$rg_root/bin/rg"
      return
    fi
  fi

  echo "ripgrep (rg) not found in PATH and automatic installation failed." >&2
  echo "Install ripgrep manually (e.g., via apt or cargo install ripgrep) and re-run." >&2
  exit 1
}

RG_BIN_SRC=$(ensure_rg_binary)

TARGET_VENDOR="$VENDOR_DIR/$TARGET_TRIPLE"
rm -rf "$TARGET_VENDOR"
mkdir -p "$TARGET_VENDOR/codex" "$TARGET_VENDOR/path"
install -Dm755 "$CODEX_BIN_SRC" "$TARGET_VENDOR/codex/codex"
install -Dm755 "$RG_BIN_SRC" "$TARGET_VENDOR/path/rg"

mkdir -p dist
rm -f dist/openai-codex-*.tgz dist/codex.tgz
pnpm pack --pack-destination dist
mv dist/openai-codex-*.tgz dist/codex.tgz

docker build -t "$IMAGE_TAG" -f "$SCRIPT_DIR/Dockerfile" "$CLI_ROOT"

popd > /dev/null
