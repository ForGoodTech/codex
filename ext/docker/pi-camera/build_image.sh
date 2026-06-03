#!/bin/bash

# Build a Codex Docker image for Raspberry Pi camera access.
# This script stages runtime binaries from an upstream Codex release and bundles them into the
# local Docker image together with repository-local proxy/config/camera assets.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
CLI_ROOT="$REPO_ROOT/codex-cli"
IMAGE_TAG=${CODEX_IMAGE_TAG:-my-codex-pi-camera-image}
DEFAULT_CODEX_RELEASE_TAG="rust-v0.136.0"
CODEX_RELEASE_TAG=${CODEX_RELEASE_TAG:-$DEFAULT_CODEX_RELEASE_TAG}
PLAYWRIGHT_MCP_PACKAGE=${PLAYWRIGHT_MCP_PACKAGE:-@playwright/mcp}
PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION:-latest}
PLAYWRIGHT_BROWSER_SOURCE=${PLAYWRIGHT_BROWSER_SOURCE:-auto}
PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC=${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC:-600}
PLAYWRIGHT_MCP_EXECUTABLE_PATH=${PLAYWRIGHT_MCP_EXECUTABLE_PATH:-/opt/google/chrome/chrome}
CHROME_MCP_PACKAGE=${CHROME_MCP_PACKAGE:-chrome-devtools-mcp}
CHROME_MCP_VERSION=${CHROME_MCP_VERSION:-latest}
GITHUB_MCP_URL=${GITHUB_MCP_URL:-https://api.githubcopilot.com/mcp/}
OPENAI_DOCS_MCP_URL=${OPENAI_DOCS_MCP_URL:-https://developers.openai.com/mcp}
PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC=${PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC:-30}
INSTALL_RPICAM_PACKAGES=${INSTALL_RPICAM_PACKAGES:-auto}
RASPBERRY_PI_APT_SUITE=${RASPBERRY_PI_APT_SUITE:-bookworm}

if [[ $# -gt 2 ]]; then
  echo "Usage: $(basename "$0") [image-tag] [release-tag]" >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then
  IMAGE_TAG=$1
fi

if [[ $# -ge 2 ]]; then
  CODEX_RELEASE_TAG=$2
fi
VENDOR_DIR="$CLI_ROOT/vendor"

case "$PLAYWRIGHT_BROWSER_SOURCE" in
  auto|playwright|system) ;;
  *)
    echo "Unsupported PLAYWRIGHT_BROWSER_SOURCE=$PLAYWRIGHT_BROWSER_SOURCE; expected auto, playwright, or system" >&2
    exit 1
    ;;
esac

case "$PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC" in
  ''|*[!0-9]*|0)
    echo "PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC must be a positive integer number of seconds" >&2
    exit 1
    ;;
esac

if [[ ! -d "$CLI_ROOT" ]]; then
  echo "Codex CLI directory not found at: $CLI_ROOT" >&2
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

echo "Using Codex release tag: $CODEX_RELEASE_TAG (default: $DEFAULT_CODEX_RELEASE_TAG)"

pushd "$CLI_ROOT" > /dev/null

pnpm install

function fetch_release_binary() {
  local binary_name=$1
  local target_triple=$2
  local output_path=$3
  local required=${4:-1}
  local archive_name="${binary_name}-${target_triple}.tar.gz"
  local download_url="https://github.com/openai/codex/releases/download/${CODEX_RELEASE_TAG}/${archive_name}"
  local tmpdir
  tmpdir=$(mktemp -d)
  local archive_path="$tmpdir/$archive_name"

  if ! curl -fLsS "$download_url" -o "$archive_path"; then
    rm -rf "$tmpdir"
    if [[ "$required" -eq 1 ]]; then
      echo "Failed to download $archive_name from $download_url" >&2
      echo "If this release does not publish ${binary_name}-${target_triple}, set CODEX_RELEASE_TAG to a compatible tag." >&2
      exit 1
    fi
    return 1
  fi

  tar -xzf "$archive_path" -C "$tmpdir"
  local extracted_binary="$tmpdir/$binary_name"
  local triple_named_binary="$tmpdir/${binary_name}-${target_triple}"
  if [[ ! -f "$extracted_binary" && -f "$triple_named_binary" ]]; then
    extracted_binary="$triple_named_binary"
  fi

  if [[ ! -f "$extracted_binary" ]]; then
    local found_binary
    found_binary=$(find "$tmpdir" -maxdepth 3 -type f \( -name "$binary_name" -o -name "${binary_name}-${target_triple}" \) | head -n 1 || true)
    if [[ -n "$found_binary" ]]; then
      extracted_binary="$found_binary"
    fi
  fi

  if [[ ! -f "$extracted_binary" ]]; then
    if [[ "$required" -eq 1 ]]; then
      echo "Expected binary $binary_name was not found in $archive_name" >&2
      echo "Archive contents:" >&2
      find "$tmpdir" -maxdepth 3 -type f | sed "s|$tmpdir/||" >&2 || true
      rm -rf "$tmpdir"
      exit 1
    fi
    rm -rf "$tmpdir"
    return 1
  fi

  mkdir -p "$(dirname "$output_path")"
  cp -f "$extracted_binary" "$output_path"
  chmod 755 "$output_path" 2>/dev/null || true
  rm -rf "$tmpdir"
}

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
    local rg_root="$REPO_ROOT/target/ripgrep-install"
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

STAGED_BIN_ROOT="$REPO_ROOT/target/codex-release-bin/$CODEX_RELEASE_TAG/$TARGET_TRIPLE"
CODEX_BIN_SRC="$STAGED_BIN_ROOT/codex"

fetch_release_binary "codex" "$TARGET_TRIPLE" "$CODEX_BIN_SRC"
LINUX_SANDBOX_BIN_SRC=""
echo "Using bundled codex linux-sandbox shim for $TARGET_TRIPLE (no standalone codex-linux-sandbox release asset download)." >&2

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
cat > "$TARGET_VENDOR/codex-app-server/codex-app-server" <<'EOF'
#!/bin/sh
set -eu
SELF_PATH="${0}"
if command -v readlink >/dev/null 2>&1; then
  RESOLVED_PATH="$(readlink -f "$SELF_PATH" 2>/dev/null || true)"
  if [ -n "$RESOLVED_PATH" ]; then
    SELF_PATH="$RESOLVED_PATH"
  fi
fi
exec "$(dirname "$SELF_PATH")/../codex/codex" app-server "$@"
EOF
chmod 755 "$TARGET_VENDOR/codex-app-server/codex-app-server" 2>/dev/null || true
if [[ -n "$LINUX_SANDBOX_BIN_SRC" ]]; then
  stage_binary "$LINUX_SANDBOX_BIN_SRC" "$TARGET_VENDOR/codex-linux-sandbox/codex-linux-sandbox"
else
  cat > "$TARGET_VENDOR/codex-linux-sandbox/codex-linux-sandbox" <<'EOF'
#!/bin/sh
set -eu
SELF_PATH="${0}"
if command -v readlink >/dev/null 2>&1; then
  RESOLVED_PATH="$(readlink -f "$SELF_PATH" 2>/dev/null || true)"
  if [ -n "$RESOLVED_PATH" ]; then
    SELF_PATH="$RESOLVED_PATH"
  fi
fi
exec "$(dirname "$SELF_PATH")/../codex/codex" linux-sandbox "$@"
EOF
  chmod 755 "$TARGET_VENDOR/codex-linux-sandbox/codex-linux-sandbox" 2>/dev/null || true
fi
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
  --build-arg PLAYWRIGHT_BROWSER_SOURCE="$PLAYWRIGHT_BROWSER_SOURCE" \
  --build-arg PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC="$PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC" \
  --build-arg PLAYWRIGHT_MCP_EXECUTABLE_PATH="$PLAYWRIGHT_MCP_EXECUTABLE_PATH" \
  --build-arg CHROME_MCP_PACKAGE="$CHROME_MCP_PACKAGE" \
  --build-arg CHROME_MCP_VERSION="$CHROME_MCP_VERSION" \
  --build-arg GITHUB_MCP_URL="$GITHUB_MCP_URL" \
  --build-arg OPENAI_DOCS_MCP_URL="$OPENAI_DOCS_MCP_URL" \
  --build-arg PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC="$PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC" \
  --build-arg INSTALL_RPICAM_PACKAGES="$INSTALL_RPICAM_PACKAGES" \
  --build-arg RASPBERRY_PI_APT_SUITE="$RASPBERRY_PI_APT_SUITE" \
  -t "$IMAGE_TAG" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$REPO_ROOT"

docker run --rm \
  -e PLAYWRIGHT_MCP_PACKAGE="$PLAYWRIGHT_MCP_PACKAGE" \
  -e PLAYWRIGHT_MCP_VERSION="$PLAYWRIGHT_MCP_VERSION" \
  -e PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC="$PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC" \
  -e PLAYWRIGHT_MCP_EXECUTABLE_PATH="$PLAYWRIGHT_MCP_EXECUTABLE_PATH" \
  -e CHROME_MCP_PACKAGE="$CHROME_MCP_PACKAGE" \
  -e GITHUB_MCP_URL="$GITHUB_MCP_URL" \
  -e INSTALL_RPICAM_PACKAGES="$INSTALL_RPICAM_PACKAGES" \
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

source_file=/home/node/.codex/playwright-browser-source
requested_source_file=/home/node/.codex/playwright-browser-source-requested
if [[ ! -f "$source_file" ]]; then
  echo "Missing Playwright browser source marker: $source_file" >&2
  exit 1
fi

playwright_browser_source=$(<"$source_file")
requested_playwright_browser_source=unknown
if [[ -f "$requested_source_file" ]]; then
  requested_playwright_browser_source=$(<"$requested_source_file")
fi

case "$playwright_browser_source" in
  playwright)
    if rg -F -q "\"--executable-path\"" "$config_file"; then
      echo "Playwright-managed browser config should not include --executable-path in $config_file" >&2
      exit 1
    fi
    ;;
  system)
    if ! rg -F -q "\"--executable-path\", \"${PLAYWRIGHT_MCP_EXECUTABLE_PATH}\"" "$config_file"; then
      echo "Expected Playwright executable path not found in $config_file" >&2
      exit 1
    fi
    if [[ "$requested_playwright_browser_source" == "auto" ]]; then
      echo "WARNING: Playwright-managed Chromium was unavailable during build; using system Chromium at $PLAYWRIGHT_MCP_EXECUTABLE_PATH." >&2
      echo "To check whether Playwright-managed Chromium is downloadable now, run:" >&2
      echo "  docker run --rm ${IMAGE_TAG} bash -lc '\''timeout --kill-after=30s ${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}s npx -y ${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION} install-browser chromium chromium-headless-shell'\''" >&2
    fi
    ;;
  *)
    echo "Unsupported Playwright browser source marker: $playwright_browser_source" >&2
    exit 1
    ;;
esac

for binary in ffmpeg v4l2-ctl codex-camera-device-setup codex-camera-entrypoint codex-camera-smoke-test codex-camera-rtp-stream; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "Missing expected runtime binary: $binary" >&2
    exit 1
  fi
done

should_have_rpicam=0
case "${INSTALL_RPICAM_PACKAGES:-auto}" in
  auto)
    case "$(dpkg --print-architecture)" in
      arm64|armhf) should_have_rpicam=1 ;;
    esac
    ;;
  1|true|yes)
    should_have_rpicam=1
    ;;
  0|false|no)
    should_have_rpicam=0
    ;;
esac

if [[ "$should_have_rpicam" -eq 1 ]] && ! command -v rpicam-vid >/dev/null 2>&1; then
  echo "Missing rpicam-vid. Raspberry Pi camera builds should install rpicam-apps-core." >&2
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

if [[ "$playwright_browser_source" == "system" && ! -x "$PLAYWRIGHT_MCP_EXECUTABLE_PATH" ]]; then
  echo "Playwright MCP executable path is not executable: $PLAYWRIGHT_MCP_EXECUTABLE_PATH" >&2
  exit 1
fi

if ! NODE_PATH="$npm_root" PLAYWRIGHT_PACKAGE_ROOT="$playwright_package_root" PLAYWRIGHT_BROWSER_SOURCE_SELECTED="$playwright_browser_source" node <<"NODE"
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = process.env.PLAYWRIGHT_PACKAGE_ROOT;
if (!packageRoot) {
  throw new Error("PLAYWRIGHT_PACKAGE_ROOT is not set");
}

const selectedBrowserSource = process.env.PLAYWRIGHT_BROWSER_SOURCE_SELECTED;
if (selectedBrowserSource !== "playwright" && selectedBrowserSource !== "system") {
  throw new Error(`Unsupported PLAYWRIGHT_BROWSER_SOURCE_SELECTED: ${selectedBrowserSource}`);
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
  const launchOptions = { headless: true };
  if (selectedBrowserSource === "system") {
    const executablePath = process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH;
    if (!executablePath) {
      throw new Error("PLAYWRIGHT_MCP_EXECUTABLE_PATH is not set");
    }
    fs.accessSync(executablePath, fs.constants.X_OK);
    launchOptions.executablePath = executablePath;
  }
  const browser = await playwright.chromium.launch(launchOptions);
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
  if [[ "$playwright_browser_source" == "system" ]]; then
    echo "Expected Playwright to launch Chromium at: $PLAYWRIGHT_MCP_EXECUTABLE_PATH" >&2
  else
    echo "Expected Playwright-managed Chromium to launch from the image browser cache." >&2
  fi
  exit 1
fi

echo "Verified MCP server config, packages, and ${playwright_browser_source} Chromium launch smoke test in image $IMAGE_TAG"
'

popd > /dev/null
