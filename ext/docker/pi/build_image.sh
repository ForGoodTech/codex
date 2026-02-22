#!/bin/bash

# Build a Codex Docker image for Raspberry Pi/Ubuntu.
# This script builds the Codex binary from the local repository and stages vendor assets without
# relying on published npm artifacts.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
CLI_ROOT="$REPO_ROOT/codex-cli"
RUST_ROOT="$REPO_ROOT/codex-rs"
SDK_ROOT="$REPO_ROOT/sdk/typescript"
IMAGE_TAG=${CODEX_IMAGE_TAG:-my-codex-docker-image}
BUILD_PROFILE=debug
FORCE_BUILD=0
PLAYWRIGHT_MCP_PACKAGE=${PLAYWRIGHT_MCP_PACKAGE:-@playwright/mcp}
PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION:-latest}
CHROME_MCP_PACKAGE=${CHROME_MCP_PACKAGE:-chrome-devtools-mcp}
CHROME_MCP_VERSION=${CHROME_MCP_VERSION:-latest}
GITHUB_MCP_PACKAGE=${GITHUB_MCP_PACKAGE:-@modelcontextprotocol/server-github}
GITHUB_MCP_VERSION=${GITHUB_MCP_VERSION:-latest}
OPENAI_DOCS_MCP_URL=${OPENAI_DOCS_MCP_URL:-https://developers.openai.com/mcp}

if [[ $# -gt 3 ]]; then
  echo "Usage: $(basename "$0") [image-tag] [build-profile] [--force]" >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then
  IMAGE_TAG=$1
fi

if [[ $# -ge 2 ]]; then
  BUILD_PROFILE=$2
fi
if [[ $# -ge 3 ]]; then
  if [[ "$3" == "--force" ]]; then
    FORCE_BUILD=1
  else
    echo "Unknown option: $3" >&2
    exit 1
  fi
fi
VENDOR_DIR="$CLI_ROOT/vendor"

if [[ ! -d "$CLI_ROOT" ]]; then
  echo "Codex CLI directory not found at: $CLI_ROOT" >&2
  exit 1
fi

if [[ ! -d "$SDK_ROOT" ]]; then
  echo "Codex SDK directory not found at: $SDK_ROOT" >&2
  exit 1
fi

if [[ ! -d "$RUST_ROOT" ]]; then
  echo "codex-rs directory not found at: $RUST_ROOT" >&2
  exit 1
fi

function resolve_rust_toolchain() {
  local toolchain_file="$RUST_ROOT/rust-toolchain.toml"
  if [[ -f "$toolchain_file" ]]; then
    local channel
    channel=$(grep -E '^[[:space:]]*channel[[:space:]]*=' "$toolchain_file" | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')
    if [[ -n "$channel" ]]; then
      echo "$channel"
      return
    fi
  fi
  echo "stable"
}

function ensure_toolchain() {
  local toolchain=$1
  if ! command -v rustup >/dev/null 2>&1; then
    echo "rustup is required to install the Rust toolchain and targets." >&2
    exit 1
  fi
  rustup toolchain install "$toolchain"
  rustup target add "$TARGET_TRIPLE" --toolchain "$toolchain"
  rustup component add rust-src --toolchain "$toolchain"
}

function ensure_musl_compiler() {
  if [[ "$TARGET_TRIPLE" != *-musl ]]; then
    return
  fi
  if command -v aarch64-linux-musl-gcc >/dev/null 2>&1; then
    return
  fi
  if command -v musl-gcc >/dev/null 2>&1; then
    return
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "musl-gcc not found and apt-get is unavailable; install musl-tools manually." >&2
    exit 1
  fi
  if [[ $(id -u) -eq 0 ]]; then
    DEBIAN_FRONTEND=noninteractive apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends musl-tools u-boot-tools
  elif command -v sudo >/dev/null 2>&1; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends musl-tools u-boot-tools
  else
    echo "musl-gcc not found and sudo is unavailable; install musl-tools manually." >&2
    exit 1
  fi
  if ! command -v musl-gcc >/dev/null 2>&1; then
    echo "musl-gcc is still unavailable after installing musl-tools." >&2
    exit 1
  fi
}

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

RUST_TOOLCHAIN=$(resolve_rust_toolchain)
ensure_toolchain "$RUST_TOOLCHAIN"
ensure_musl_compiler

pushd "$CLI_ROOT" > /dev/null

pnpm install

pushd "$SDK_ROOT" > /dev/null
pnpm install
pnpm run build
popd > /dev/null

# Build (or reuse) the native Codex binary from the local workspace.
case "$BUILD_PROFILE" in
  release)
    CODEX_BIN_SRC="$RUST_ROOT/target/$TARGET_TRIPLE/release/codex"
    APP_SERVER_BIN_SRC="$RUST_ROOT/target/$TARGET_TRIPLE/release/codex-app-server"
    LINUX_SANDBOX_BIN_SRC="$RUST_ROOT/target/$TARGET_TRIPLE/release/codex-linux-sandbox"
    ;;
  debug)
    CODEX_BIN_SRC="$RUST_ROOT/target/$TARGET_TRIPLE/debug/codex"
    APP_SERVER_BIN_SRC="$RUST_ROOT/target/$TARGET_TRIPLE/debug/codex-app-server"
    LINUX_SANDBOX_BIN_SRC="$RUST_ROOT/target/$TARGET_TRIPLE/debug/codex-linux-sandbox"
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

  if [[ "$FORCE_BUILD" -eq 0 && -x "$binary_path" ]]; then
    return
  fi

  pushd "$RUST_ROOT" > /dev/null
  local v_cc_musl=${CC_aarch64_unknown_linux_musl:-musl-gcc}
  if [[ "$BUILD_PROFILE" == "debug" ]]; then
    CC="$v_cc_musl" \
      CC_aarch64_unknown_linux_musl="$v_cc_musl" \
      cargo +"$RUST_TOOLCHAIN" build --target "$TARGET_TRIPLE" "${cargo_args[@]}"
  else
    CC="$v_cc_musl" \
      CC_aarch64_unknown_linux_musl="$v_cc_musl" \
      cargo +"$RUST_TOOLCHAIN" build --release --target "$TARGET_TRIPLE" "${cargo_args[@]}"
  fi
  popd > /dev/null

  if [[ ! -x "$binary_path" ]]; then
    echo "Built $label binary not found at $binary_path" >&2
    exit 1
  fi
}

ensure_binary "Codex" "$CODEX_BIN_SRC" -p codex-cli --bin codex
ensure_binary "codex-app-server" "$APP_SERVER_BIN_SRC" -p codex-app-server --bin codex-app-server
ensure_binary "codex-linux-sandbox" "$LINUX_SANDBOX_BIN_SRC" -p codex-linux-sandbox --bin codex-linux-sandbox

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
mkdir -p "$TARGET_VENDOR/codex" "$TARGET_VENDOR/codex-app-server" "$TARGET_VENDOR/codex-linux-sandbox" "$TARGET_VENDOR/path"

function stage_binary() {
  local src=$1
  local dest=$2

  if install -Dm755 "$src" "$dest" 2>/dev/null; then
    return
  fi

  cp -f "$src" "$dest"
  chmod 755 "$dest" 2>/dev/null || true
}

stage_binary "$CODEX_BIN_SRC" "$TARGET_VENDOR/codex/codex"
stage_binary "$APP_SERVER_BIN_SRC" "$TARGET_VENDOR/codex-app-server/codex-app-server"
stage_binary "$LINUX_SANDBOX_BIN_SRC" "$TARGET_VENDOR/codex-linux-sandbox/codex-linux-sandbox"
stage_binary "$RG_BIN_SRC" "$TARGET_VENDOR/path/rg"

mkdir -p dist
rm -f dist/openai-codex-*.tgz dist/codex.tgz
pnpm pack --pack-destination dist
mv dist/openai-codex-*.tgz dist/codex.tgz

function cleanup_existing_image() {
  if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    return
  fi

  local containers
  mapfile -t containers < <(docker ps -a --filter "ancestor=$IMAGE_TAG" -q)
  if [[ ${#containers[@]} -gt 0 ]]; then
    echo "Stopping and removing containers using image $IMAGE_TAG"
    for container_id in "${containers[@]}"; do
      docker stop "$container_id" >/dev/null 2>&1 || true
      for _ in $(seq 1 10); do
        if docker rm -f "$container_id" >/dev/null 2>&1; then
          break
        fi
        if ! docker container inspect "$container_id" >/dev/null 2>&1; then
          break
        fi
        sleep 1
      done
      if docker container inspect "$container_id" >/dev/null 2>&1; then
        echo "Failed to remove container $container_id while cleaning image $IMAGE_TAG" >&2
        exit 1
      fi
    done
  fi

  echo "Removing existing image $IMAGE_TAG"
  for _ in $(seq 1 10); do
    if docker rmi "$IMAGE_TAG" >/dev/null 2>&1; then
      return
    fi
    if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  echo "Failed to remove image $IMAGE_TAG after retries" >&2
  exit 1
}

cleanup_existing_image

docker build \
  --build-arg PLAYWRIGHT_MCP_PACKAGE="$PLAYWRIGHT_MCP_PACKAGE" \
  --build-arg PLAYWRIGHT_MCP_VERSION="$PLAYWRIGHT_MCP_VERSION" \
  --build-arg CHROME_MCP_PACKAGE="$CHROME_MCP_PACKAGE" \
  --build-arg CHROME_MCP_VERSION="$CHROME_MCP_VERSION" \
  --build-arg GITHUB_MCP_PACKAGE="$GITHUB_MCP_PACKAGE" \
  --build-arg GITHUB_MCP_VERSION="$GITHUB_MCP_VERSION" \
  --build-arg OPENAI_DOCS_MCP_URL="$OPENAI_DOCS_MCP_URL" \
  -t "$IMAGE_TAG" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$REPO_ROOT"

docker run --rm \
  -e PLAYWRIGHT_MCP_PACKAGE="$PLAYWRIGHT_MCP_PACKAGE" \
  -e CHROME_MCP_PACKAGE="$CHROME_MCP_PACKAGE" \
  -e GITHUB_MCP_PACKAGE="$GITHUB_MCP_PACKAGE" \
  -e IMAGE_TAG="$IMAGE_TAG" \
  "$IMAGE_TAG" bash -lc '
set -euo pipefail

config_file=/home/node/.codex/config.toml
if [[ ! -f "$config_file" ]]; then
  echo "Missing default Codex MCP config file: $config_file" >&2
  exit 1
fi

for server in openai_docs playwright chrome_devtools github; do
  if ! rg -q "^\\[mcp_servers\\.${server}\\]" "$config_file"; then
    echo "Missing MCP server configuration for $server in $config_file" >&2
    exit 1
  fi
done

npm_root=$(npm root -g)
for package in "$PLAYWRIGHT_MCP_PACKAGE" "$CHROME_MCP_PACKAGE" "$GITHUB_MCP_PACKAGE"; do
  if [[ ! -d "$npm_root/$package" ]]; then
    echo "Missing globally installed MCP package: $package" >&2
    exit 1
  fi
done

echo "Verified MCP server config and package installation in image $IMAGE_TAG"
'

cat <<EOF

Landlock support note:
  Docker's default seccomp profile blocks the Landlock syscalls. To enable
  Landlock inside the container, run it with a relaxed seccomp profile, e.g.:
    docker run --security-opt seccomp=unconfined ...

EOF

popd > /dev/null
