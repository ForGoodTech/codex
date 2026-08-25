#!/bin/bash

# Build the camera/vision extension of the shared Codex Pi runtime image.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
IMAGE_TAG=${CODEX_IMAGE_TAG:-my-codex-pi-camera-image}
BASE_IMAGE=${CODEX_BASE_IMAGE_TAG:-my-codex-docker-image}
BUILD_BASE_IMAGE=${BUILD_BASE_IMAGE:-auto}
DEFAULT_CODEX_RELEASE_TAG="rust-v0.149.1"
CODEX_RELEASE_TAG=${CODEX_RELEASE_TAG:-$DEFAULT_CODEX_RELEASE_TAG}
PLAYWRIGHT_MCP_PACKAGE=${PLAYWRIGHT_MCP_PACKAGE:-@playwright/mcp}
PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION:-latest}
PLAYWRIGHT_BROWSER_SOURCE=${PLAYWRIGHT_BROWSER_SOURCE:-system}
PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC=${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC:-300}
PLAYWRIGHT_MCP_EXECUTABLE_PATH=${PLAYWRIGHT_MCP_EXECUTABLE_PATH:-/opt/google/chrome/chrome}
CHROME_MCP_PACKAGE=${CHROME_MCP_PACKAGE:-chrome-devtools-mcp}
CHROME_MCP_VERSION=${CHROME_MCP_VERSION:-latest}
GITHUB_MCP_URL=${GITHUB_MCP_URL:-https://api.githubcopilot.com/mcp/}
OPENAI_DOCS_MCP_URL=${OPENAI_DOCS_MCP_URL:-https://developers.openai.com/mcp}
PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC=${PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC:-30}
INSTALL_RPICAM_PACKAGES=${INSTALL_RPICAM_PACKAGES:-auto}
RASPBERRY_PI_APT_SUITE=${RASPBERRY_PI_APT_SUITE:-bookworm}
DEFAULT_NCNN_VERSION="20260526"
DEFAULT_NCNN_SOURCE_SHA256="754659d6fe65545cf2ef4483ffb84526fea631f8764c44b150f1601d0fb4004b"
NCNN_VERSION=${NCNN_VERSION:-$DEFAULT_NCNN_VERSION}
NCNN_SOURCE_SHA256=${NCNN_SOURCE_SHA256:-$DEFAULT_NCNN_SOURCE_SHA256}
NCNN_VULKAN=${NCNN_VULKAN:-OFF}
source "$REPO_ROOT/ext/docker/pi/runtime-image-contract.sh"

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

case "$BUILD_BASE_IMAGE" in
  auto|true|false) ;;
  *)
    echo "Unsupported BUILD_BASE_IMAGE=$BUILD_BASE_IMAGE; expected auto, true, or false" >&2
    exit 1
    ;;
esac

if [[ ! "$NCNN_VERSION" =~ ^[0-9]{8}$ ]]; then
  echo "NCNN_VERSION must be an eight-digit release tag such as 20260526" >&2
  exit 1
fi

if [[ ! "$NCNN_SOURCE_SHA256" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "NCNN_SOURCE_SHA256 must be a 64-character SHA-256 digest" >&2
  exit 1
fi
NCNN_SOURCE_SHA256=${NCNN_SOURCE_SHA256,,}

case "${NCNN_VULKAN,,}" in
  1|true|yes|on)
    NCNN_VULKAN=ON
    ;;
  0|false|no|off)
    NCNN_VULKAN=OFF
    ;;
  *)
    echo "Unsupported NCNN_VULKAN=$NCNN_VULKAN; expected ON or OFF" >&2
    exit 1
    ;;
esac

echo "Using Codex release tag: $CODEX_RELEASE_TAG (default: $DEFAULT_CODEX_RELEASE_TAG)"
echo "Using NCNN release: $NCNN_VERSION (Vulkan: $NCNN_VULKAN)"

function build_base_image() {
  CODEX_IMAGE_TAG="$BASE_IMAGE" \
    CODEX_RELEASE_TAG="$CODEX_RELEASE_TAG" \
    PLAYWRIGHT_MCP_PACKAGE="$PLAYWRIGHT_MCP_PACKAGE" \
    PLAYWRIGHT_MCP_VERSION="$PLAYWRIGHT_MCP_VERSION" \
    PLAYWRIGHT_BROWSER_SOURCE="$PLAYWRIGHT_BROWSER_SOURCE" \
    PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC="$PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC" \
    PLAYWRIGHT_MCP_EXECUTABLE_PATH="$PLAYWRIGHT_MCP_EXECUTABLE_PATH" \
    CHROME_MCP_PACKAGE="$CHROME_MCP_PACKAGE" \
    CHROME_MCP_VERSION="$CHROME_MCP_VERSION" \
    GITHUB_MCP_URL="$GITHUB_MCP_URL" \
    OPENAI_DOCS_MCP_URL="$OPENAI_DOCS_MCP_URL" \
    PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC="$PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC" \
    "$REPO_ROOT/ext/docker/pi/build_image.sh"
}

function build_base_if_needed() {
  case "$BUILD_BASE_IMAGE" in
    false)
      return
      ;;
    true)
      build_base_image
      return
      ;;
    auto)
      if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
        if codex_runtime_image_has_current_contract "$BASE_IMAGE"; then
          echo "Reusing base image $BASE_IMAGE with current runtime image contract"
          return
        fi
        echo "Rebuilding base image $BASE_IMAGE because its runtime image contract is stale or missing"
      fi
      build_base_image
      ;;
  esac
}

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

function main() {
build_base_if_needed
cleanup_existing_image

docker build \
  --build-arg BASE_IMAGE="$BASE_IMAGE" \
  --build-arg NCNN_VERSION="$NCNN_VERSION" \
  --build-arg NCNN_SOURCE_SHA256="$NCNN_SOURCE_SHA256" \
  --build-arg NCNN_VULKAN="$NCNN_VULKAN" \
  --build-arg INSTALL_RPICAM_PACKAGES="$INSTALL_RPICAM_PACKAGES" \
  --build-arg RASPBERRY_PI_APT_SUITE="$RASPBERRY_PI_APT_SUITE" \
  -t "$IMAGE_TAG" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$REPO_ROOT"

if ! codex_runtime_image_has_current_contract "$IMAGE_TAG"; then
  echo "Built image $IMAGE_TAG does not satisfy inherited Codex runtime image contract v$CODEX_RUNTIME_IMAGE_CONTRACT_VERSION" >&2
  exit 1
fi

docker run --rm \
  -e PLAYWRIGHT_MCP_PACKAGE="$PLAYWRIGHT_MCP_PACKAGE" \
  -e PLAYWRIGHT_MCP_VERSION="$PLAYWRIGHT_MCP_VERSION" \
  -e PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC="$PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC" \
  -e PLAYWRIGHT_MCP_EXECUTABLE_PATH="$PLAYWRIGHT_MCP_EXECUTABLE_PATH" \
  -e CHROME_MCP_PACKAGE="$CHROME_MCP_PACKAGE" \
  -e GITHUB_MCP_URL="$GITHUB_MCP_URL" \
  -e INSTALL_RPICAM_PACKAGES="$INSTALL_RPICAM_PACKAGES" \
  -e NCNN_VERSION="$NCNN_VERSION" \
  -e NCNN_VULKAN="$NCNN_VULKAN" \
  -e IMAGE_TAG="$IMAGE_TAG" \
  "$IMAGE_TAG" bash -c '
set -euo pipefail

config_file=/home/node/.codex/config.toml
if [[ ! -f "$config_file" ]]; then
  echo "Missing default Codex MCP config file: $config_file" >&2
  exit 1
fi

for binary in codex codex-app-server codex-app-surface-send codex-linux-sandbox ffmpeg; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "Missing expected Codex runtime binary: $binary" >&2
    exit 1
  fi
done
for path in /home/node/app-surface-send.js /usr/local/bin/codex-app-surface-send; do
  if [[ ! -x "$path" ]]; then
    echo "Missing expected executable app-surface sender path: $path" >&2
    exit 1
  fi
done

if ! codex --version >/dev/null; then
  echo "Codex CLI launcher failed in image $IMAGE_TAG" >&2
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
install_status_file=/home/node/.codex/playwright-browser-install-status
if [[ ! -f "$source_file" ]]; then
  echo "Missing Playwright browser source marker: $source_file" >&2
  exit 1
fi

playwright_browser_source=$(<"$source_file")
requested_playwright_browser_source=unknown
if [[ -f "$requested_source_file" ]]; then
  requested_playwright_browser_source=$(<"$requested_source_file")
fi
playwright_browser_install_status=unknown
if [[ -f "$install_status_file" ]]; then
  playwright_browser_install_status=$(<"$install_status_file")
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
      case "$playwright_browser_install_status" in
        124)
          install_status_message="timed out after ${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}s"
          ;;
        137)
          install_status_message="was killed after timeout cleanup"
          ;;
        unknown)
          install_status_message="failed with unknown status"
          ;;
        *)
          install_status_message="exited with status ${playwright_browser_install_status}"
          ;;
      esac
      echo "WARNING: Playwright-managed Chromium ${install_status_message} during build; using system Chromium at $PLAYWRIGHT_MCP_EXECUTABLE_PATH." >&2
      echo "To check whether Playwright-managed Chromium is downloadable now, run:" >&2
      echo "  docker run --rm ${IMAGE_TAG} bash -c '\''timeout --kill-after=30s ${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}s npx -y ${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION} install-browser chromium chromium-headless-shell'\''" >&2
    fi
    ;;
  *)
    echo "Unsupported Playwright browser source marker: $playwright_browser_source" >&2
    exit 1
    ;;
esac

required_binaries=(
  python3
  ncnnoptimize
  v4l2-ctl
  codex-browser-audio-setup
  codex-browser-audio-rtp-stream
  codex-runtime-audio-setup
  codex-runtime-audio-rtp-stream
  codex-camera-device-setup
  codex-camera-entrypoint
  codex-camera-smoke-test
  codex-camera-rtp-stream
  codex-vision-smoke-test
)
for binary in "${required_binaries[@]}"; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "Missing expected runtime binary: $binary" >&2
    exit 1
  fi
done

for path in /opt/ncnn/include/ncnn/net.h /opt/ncnn/lib/libncnn.so; do
  if [[ ! -e "$path" ]]; then
    echo "Missing expected NCNN runtime path: $path" >&2
    exit 1
  fi
done

codex-vision-smoke-test

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

if [[ "$should_have_rpicam" -eq 1 ]] && ! dpkg-query -W rpicam-apps-opencv-postprocess >/dev/null 2>&1; then
  echo "Missing rpicam-apps-opencv-postprocess. Raspberry Pi camera builds should include the OpenCV post-processing stage." >&2
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

echo "Verified Codex runtime contract, CLI, OpenCV/NCNN vision runtime, MCP server config, packages, and ${playwright_browser_source} Chromium launch smoke test in image $IMAGE_TAG"
'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
