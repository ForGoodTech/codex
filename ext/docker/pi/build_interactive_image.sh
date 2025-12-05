#!/bin/bash

# Build a Codex Docker image for interactive use on Raspberry Pi/Ubuntu.
# This script builds the Codex binary from the local repository and stages
# vendor assets without relying on published npm artifacts.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
CLI_ROOT="$REPO_ROOT/codex-cli"
RUST_ROOT="$REPO_ROOT/codex-rs"
IMAGE_TAG=${CODEX_INTERACTIVE_IMAGE_TAG:-my-codex-docker-image}
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
    APP_SERVER_BIN_SRC="$RUST_ROOT/target/release/codex-app-server"
    ;;
  debug)
    CODEX_BIN_SRC="$RUST_ROOT/target/debug/codex"
    APP_SERVER_BIN_SRC="$RUST_ROOT/target/debug/codex-app-server"
    ;;
  *)
    echo "Unknown build profile: $BUILD_PROFILE" >&2
    exit 1
    ;;
esac

function ensure_binary() {
  local label=$1
  local binary_path=$2
  local cargo_args=(${@:3})

  if [[ -x "$binary_path" ]]; then
    return
  fi

  pushd "$RUST_ROOT" > /dev/null
  if [[ "$BUILD_PROFILE" == "debug" ]]; then
    cargo build "${cargo_args[@]}"
  else
    cargo build --release "${cargo_args[@]}"
  fi
  popd > /dev/null

  if [[ ! -x "$binary_path" ]]; then
    echo "Built $label binary not found at $binary_path" >&2
    exit 1
  fi
}

ensure_binary "Codex" "$CODEX_BIN_SRC" -p codex-cli --bin codex
ensure_binary "codex-app-server" "$APP_SERVER_BIN_SRC" -p codex-app-server --bin codex-app-server

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
mkdir -p "$TARGET_VENDOR/codex" "$TARGET_VENDOR/codex-app-server" "$TARGET_VENDOR/path"
install -Dm755 "$CODEX_BIN_SRC" "$TARGET_VENDOR/codex/codex"
install -Dm755 "$APP_SERVER_BIN_SRC" "$TARGET_VENDOR/codex-app-server/codex-app-server"
install -Dm755 "$RG_BIN_SRC" "$TARGET_VENDOR/path/rg"

mkdir -p dist
rm -f dist/openai-codex-*.tgz dist/codex.tgz
pnpm pack --pack-destination dist
mv dist/openai-codex-*.tgz dist/codex.tgz

docker build -t "$IMAGE_TAG" -f "$SCRIPT_DIR/Dockerfile" "$CLI_ROOT"

popd > /dev/null
