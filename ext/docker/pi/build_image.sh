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
GITHUB_MCP_URL=${GITHUB_MCP_URL:-https://api.githubcopilot.com/mcp/}
OPENAI_DOCS_MCP_URL=${OPENAI_DOCS_MCP_URL:-https://developers.openai.com/mcp}
PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC=${PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC:-30}

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
  if [[ "$TARGET_TRIPLE" == "aarch64-unknown-linux-musl" ]] && command -v aarch64-linux-musl-gcc >/dev/null 2>&1; then
    return
  fi
  if [[ "$TARGET_TRIPLE" == "x86_64-unknown-linux-musl" ]] && command -v x86_64-linux-musl-gcc >/dev/null 2>&1; then
    return
  fi
  if command -v musl-gcc >/dev/null 2>&1; then
    return
  fi
  echo "No musl C compiler found for $TARGET_TRIPLE." >&2
  echo "Install a target compiler (preferred) or musl-gcc manually, then re-run." >&2
  exit 1
}

function ensure_linux_sandbox_build_deps() {
  if ! command -v pkg-config >/dev/null 2>&1; then
    echo "pkg-config is required to build codex-linux-sandbox; install pkg-config and libcap-dev manually." >&2
    exit 1
  fi

  if ! pkg-config --exists libcap; then
    echo "libcap development headers are required to build codex-linux-sandbox; install libcap-dev manually." >&2
    exit 1
  fi
}

function resolve_musl_compiler() {
  local v_cc_musl
  if [[ "$TARGET_TRIPLE" == "aarch64-unknown-linux-musl" ]] && command -v aarch64-linux-musl-gcc >/dev/null 2>&1; then
    v_cc_musl=${CC_aarch64_unknown_linux_musl:-aarch64-linux-musl-gcc}
  elif [[ "$TARGET_TRIPLE" == "x86_64-unknown-linux-musl" ]] && command -v x86_64-linux-musl-gcc >/dev/null 2>&1; then
    v_cc_musl=${CC_x86_64_unknown_linux_musl:-x86_64-linux-musl-gcc}
  else
    v_cc_musl=${CC_aarch64_unknown_linux_musl:-musl-gcc}
  fi
  echo "$v_cc_musl"
}

function resolve_target_cflags() {
  local target_cflags=${CFLAGS_aarch64_unknown_linux_musl:-}
  local include_candidates=()
  local gcc_multiarch
  gcc_multiarch=$(gcc -print-multiarch 2>/dev/null || true)
  if [[ -n "$gcc_multiarch" ]]; then
    include_candidates+=("/usr/include/$gcc_multiarch")
  fi
  if [[ "$TARGET_TRIPLE" == "aarch64-unknown-linux-musl" ]]; then
    include_candidates+=("/usr/include/aarch64-linux-gnu")
  elif [[ "$TARGET_TRIPLE" == "x86_64-unknown-linux-musl" ]]; then
    include_candidates+=("/usr/include/x86_64-linux-gnu")
  fi

  local include_dir
  for include_dir in "${include_candidates[@]}"; do
    if [[ -d "$include_dir" && "$target_cflags" != *"-idirafter$include_dir"* ]]; then
      if [[ -n "$target_cflags" ]]; then
        target_cflags+=" "
      fi
      target_cflags+="-idirafter$include_dir"
    fi
  done

  echo "$target_cflags"
}

function resolve_target_linker_env_var() {
  if [[ "$TARGET_TRIPLE" == "aarch64-unknown-linux-musl" ]]; then
    echo "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER"
  elif [[ "$TARGET_TRIPLE" == "x86_64-unknown-linux-musl" ]]; then
    echo "CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER"
  else
    echo ""
  fi
}

function precheck_rust_target_linker() {
  local v_cc_musl
  v_cc_musl=$(resolve_musl_compiler)
  local linker_env_var
  linker_env_var=$(resolve_target_linker_env_var)
  if [[ -z "$linker_env_var" ]]; then
    return
  fi
  local precheck_rs
  precheck_rs=$(mktemp)
  local precheck_bin
  precheck_bin=$(mktemp)
  cat > "$precheck_rs" <<'EOF'
fn main() {}
EOF
  if ! env "$linker_env_var=$v_cc_musl" rustc +"$RUST_TOOLCHAIN" --target "$TARGET_TRIPLE" "$precheck_rs" -o "$precheck_bin" >/dev/null 2>&1; then
    rm -f "$precheck_rs" "$precheck_bin"
    echo "Rust target linker precheck failed before cargo build." >&2
    echo "Target: $TARGET_TRIPLE" >&2
    echo "Compiler/linker: $v_cc_musl" >&2
    echo "Set $linker_env_var or install/fix the target musl toolchain, then re-run." >&2
    exit 1
  fi
  rm -f "$precheck_rs" "$precheck_bin"
}

function precheck_linux_sandbox_compile_conditions() {
  local v_cc_musl
  v_cc_musl=$(resolve_musl_compiler)
  local target_cflags
  target_cflags=$(resolve_target_cflags)
  local precheck_src
  precheck_src=$(mktemp)
  cat > "$precheck_src" <<'EOF'
#include <sys/capability.h>
#include <linux/types.h>
#include <linux/loop.h>
int main(void) {
  return 0;
}
EOF
  local cflags_args=()
  if [[ -n "$target_cflags" ]]; then
    read -r -a cflags_args <<< "$target_cflags"
  fi
  if ! "$v_cc_musl" -fsyntax-only -x c -idirafter/usr/include "${cflags_args[@]}" "$precheck_src" >/dev/null 2>&1; then
    rm -f "$precheck_src"
    echo "codex-linux-sandbox precheck failed before cargo build." >&2
    echo "Compiler: $v_cc_musl" >&2
    echo "CFLAGS_aarch64_unknown_linux_musl: $target_cflags" >&2
    echo "Missing linux/libcap headers for musl compile path (e.g. asm/types.h)." >&2
    echo "Install/fix target headers or override CC/CFLAGS, then re-run." >&2
    exit 1
  fi
  rm -f "$precheck_src"
}

function precheck_linux_sandbox_link_conditions() {
  local v_cc_musl
  v_cc_musl=$(resolve_musl_compiler)
  local target_cflags
  target_cflags=$(resolve_target_cflags)
  local precheck_src
  precheck_src=$(mktemp)
  local precheck_bin
  precheck_bin=$(mktemp)
  cat > "$precheck_src" <<'EOF'
#include <sys/capability.h>
int main(void) {
  cap_t caps = cap_get_proc();
  if (caps) {
    cap_free(caps);
  }
  return 0;
}
EOF
  local cflags_args=()
  if [[ -n "$target_cflags" ]]; then
    read -r -a cflags_args <<< "$target_cflags"
  fi
  local libcap_cflags=()
  local libcap_libs=()
  local pkg_cflags
  pkg_cflags=$(pkg-config --cflags libcap)
  if [[ -n "$pkg_cflags" ]]; then
    read -r -a libcap_cflags <<< "$pkg_cflags"
  fi
  local pkg_libs
  pkg_libs=$(pkg-config --libs libcap)
  if [[ -n "$pkg_libs" ]]; then
    read -r -a libcap_libs <<< "$pkg_libs"
  fi
  if ! "$v_cc_musl" -x c "$precheck_src" -o "$precheck_bin" -static -idirafter/usr/include "${cflags_args[@]}" "${libcap_cflags[@]}" "${libcap_libs[@]}" >/dev/null 2>&1; then
    rm -f "$precheck_src" "$precheck_bin"
    echo "codex-linux-sandbox link precheck failed before cargo build." >&2
    echo "Compiler/linker: $v_cc_musl" >&2
    echo "pkg-config --libs libcap: $pkg_libs" >&2
    echo "The discovered libcap library is not linkable for $TARGET_TRIPLE." >&2
    echo "Install a musl-compatible libcap toolchain/sysroot or set pkg-config vars to one, then re-run." >&2
    exit 1
  fi
  rm -f "$precheck_src" "$precheck_bin"
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
ensure_linux_sandbox_build_deps
precheck_linux_sandbox_compile_conditions
precheck_linux_sandbox_link_conditions
precheck_rust_target_linker

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
  local v_cc_musl
  v_cc_musl=$(resolve_musl_compiler)
  local target_cflags
  target_cflags=$(resolve_target_cflags)
  local linker_env_var
  linker_env_var=$(resolve_target_linker_env_var)
  if [[ "$BUILD_PROFILE" == "debug" ]]; then
    env "$linker_env_var=$v_cc_musl" \
      CC="$v_cc_musl" \
      CC_aarch64_unknown_linux_musl="$v_cc_musl" \
      PKG_CONFIG_ALLOW_CROSS="${PKG_CONFIG_ALLOW_CROSS:-1}" \
      PKG_CONFIG_ALLOW_CROSS_aarch64_unknown_linux_musl="${PKG_CONFIG_ALLOW_CROSS_aarch64_unknown_linux_musl:-${PKG_CONFIG_ALLOW_CROSS:-1}}" \
      PKG_CONFIG_ALLOW_CROSS_x86_64_unknown_linux_musl="${PKG_CONFIG_ALLOW_CROSS_x86_64_unknown_linux_musl:-${PKG_CONFIG_ALLOW_CROSS:-1}}" \
      CFLAGS_aarch64_unknown_linux_musl="$target_cflags" \
      TARGET_CFLAGS="$target_cflags" \
      cargo +"$RUST_TOOLCHAIN" build --target "$TARGET_TRIPLE" "${cargo_args[@]}"
  else
    env "$linker_env_var=$v_cc_musl" \
      CC="$v_cc_musl" \
      CC_aarch64_unknown_linux_musl="$v_cc_musl" \
      PKG_CONFIG_ALLOW_CROSS="${PKG_CONFIG_ALLOW_CROSS:-1}" \
      PKG_CONFIG_ALLOW_CROSS_aarch64_unknown_linux_musl="${PKG_CONFIG_ALLOW_CROSS_aarch64_unknown_linux_musl:-${PKG_CONFIG_ALLOW_CROSS:-1}}" \
      PKG_CONFIG_ALLOW_CROSS_x86_64_unknown_linux_musl="${PKG_CONFIG_ALLOW_CROSS_x86_64_unknown_linux_musl:-${PKG_CONFIG_ALLOW_CROSS:-1}}" \
      CFLAGS_aarch64_unknown_linux_musl="$target_cflags" \
      TARGET_CFLAGS="$target_cflags" \
      cargo +"$RUST_TOOLCHAIN" build --release --target "$TARGET_TRIPLE" "${cargo_args[@]}"
  fi
  popd > /dev/null

  if [[ ! -x "$binary_path" ]]; then
    echo "Built $label binary not found at $binary_path" >&2
    exit 1
  fi
}

ensure_binary "codex-linux-sandbox" "$LINUX_SANDBOX_BIN_SRC" -p codex-linux-sandbox --bin codex-linux-sandbox
ensure_binary "Codex" "$CODEX_BIN_SRC" -p codex-cli --bin codex
ensure_binary "codex-app-server" "$APP_SERVER_BIN_SRC" -p codex-app-server --bin codex-app-server

pushd "$CLI_ROOT" > /dev/null

pnpm install

pushd "$SDK_ROOT" > /dev/null
pnpm install
pnpm run build
popd > /dev/null

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
  --build-arg GITHUB_MCP_URL="$GITHUB_MCP_URL" \
  --build-arg OPENAI_DOCS_MCP_URL="$OPENAI_DOCS_MCP_URL" \
  --build-arg PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC="$PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC" \
  -t "$IMAGE_TAG" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$REPO_ROOT"

docker run --rm \
  -e PLAYWRIGHT_MCP_PACKAGE="$PLAYWRIGHT_MCP_PACKAGE" \
  -e CHROME_MCP_PACKAGE="$CHROME_MCP_PACKAGE" \
  -e GITHUB_MCP_URL="$GITHUB_MCP_URL" \
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

if ! rg -q "^url = \"${GITHUB_MCP_URL}\"$" "$config_file"; then
  echo "Expected GitHub MCP URL not found in $config_file" >&2
  exit 1
fi

if rg -q "(?i)(github[_-]?token|authorization|GITHUB_TOKEN|\$\{?GITHUB_TOKEN\}?)" "$config_file"; then
  echo "GitHub MCP server config must not include token or token env references in $config_file" >&2
  exit 1
fi

if ! rg -q "^startup_timeout_sec = ${PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC}$" "$config_file"; then
  echo "Expected Playwright startup timeout not found in $config_file" >&2
  exit 1
fi

npm_root=$(npm root -g)
for package in "$PLAYWRIGHT_MCP_PACKAGE" "$CHROME_MCP_PACKAGE"; do
  if [[ ! -d "$npm_root/$package" ]]; then
    echo "Missing globally installed MCP package: $package" >&2
    exit 1
  fi
done

playwright_package_root="$npm_root/$PLAYWRIGHT_MCP_PACKAGE"
if [[ ! -d "$playwright_package_root" ]]; then
  echo "Playwright MCP package root not found at $playwright_package_root" >&2
  exit 1
fi

playwright_cache_dir=${PLAYWRIGHT_BROWSERS_PATH:-/home/node/.cache/ms-playwright}
if [[ ! -d "$playwright_cache_dir" ]]; then
  echo "Playwright browser cache directory not found: $playwright_cache_dir" >&2
  echo "Ensure browser binaries are installed in the image (for example: npx playwright install chromium)." >&2
  exit 1
fi

if ! find "$playwright_cache_dir" -maxdepth 5 -type f \( -name chrome -o -name chromium -o -name chromium-headless-shell \) | head -n 1 | rg -q .; then
  echo "No Chromium executable found under Playwright cache: $playwright_cache_dir" >&2
  echo "Ensure browser binaries are installed in the image (for example: npx playwright install chromium)." >&2
  exit 1
fi

if ! NODE_PATH="$npm_root" PLAYWRIGHT_PACKAGE_ROOT="$playwright_package_root" node <<"NODE"
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = process.env.PLAYWRIGHT_PACKAGE_ROOT;
if (!packageRoot) {
  throw new Error("PLAYWRIGHT_PACKAGE_ROOT is not set");
}

const entryCandidates = [
  "node_modules/playwright/index.js",
  "node_modules/playwright-core/index.js",
];

const entry = entryCandidates
  .map((candidate) => path.join(packageRoot, candidate))
  .find((candidate) => fs.existsSync(candidate));

if (!entry) {
  throw new Error(
    `Could not find playwright or playwright-core under ${packageRoot}/node_modules`,
  );
}

const playwright = require(entry);
if (!playwright.chromium) {
  throw new Error(`Chromium launcher was not found in ${entry}`);
}

(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  await browser.close();
  console.log("Playwright Chromium launch smoke test passed");
})().catch((error) => {
  console.error("Playwright Chromium launch smoke test failed:", error);
  process.exit(1);
});
NODE
then
  echo "Playwright Chromium launch smoke test failed." >&2
  echo "This usually means runtime browser/system dependencies are missing in the image." >&2
  echo "If Chromium is not installed, add browser installation in Dockerfile (for example: npx playwright install chromium)." >&2
  echo "If Chromium is installed but launch still fails, add missing OS deps (for example: npx playwright install-deps chromium)." >&2
  exit 1
fi

echo "Verified MCP server config, packages, and Playwright Chromium launch smoke test in image $IMAGE_TAG"
'

cat <<EOF

Landlock support note:
  Docker's default seccomp profile blocks the Landlock syscalls. To enable
  Landlock inside the container, run it with a relaxed seccomp profile, e.g.:
    docker run --security-opt seccomp=unconfined ...

EOF

popd > /dev/null
