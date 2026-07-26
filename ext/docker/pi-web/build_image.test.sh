#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
source "$SCRIPT_DIR/build_image.sh"

TEST_IMAGE_STATE=current
BASE_BUILD_CALLS=0

function docker() {
  if [[ "$1" == "image" && "$2" == "inspect" ]]; then
    return 0
  fi
  if [[ "$1" != "run" ]]; then
    echo "Unexpected docker command in test: $*" >&2
    return 2
  fi

  case "$TEST_IMAGE_STATE" in
    current)
      printf '%s  %s\n' \
        "$(sha256sum "$PI_PROXY_SOURCE" | awk '{print $1}')" \
        /home/node/app-server-proxy.js
      printf '%s  %s\n' \
        "$(sha256sum "$PI_PROXY_PERF_SOURCE" | awk '{print $1}')" \
        /home/node/app-server-proxy-perf.js
      ;;
    stale)
      printf '%064d  %s\n' 0 /home/node/app-server-proxy.js
      printf '%064d  %s\n' 0 /home/node/app-server-proxy-perf.js
      ;;
    missing)
      return 1
      ;;
    *)
      echo "Unexpected test image state: $TEST_IMAGE_STATE" >&2
      return 2
      ;;
  esac
}

function build_base_image() {
  BASE_BUILD_CALLS=$((BASE_BUILD_CALLS + 1))
}

image_has_current_pi_proxy_assets test-image

TEST_IMAGE_STATE=stale
if image_has_current_pi_proxy_assets test-image; then
  echo "Stale Pi proxy assets were accepted" >&2
  exit 1
fi

TEST_IMAGE_STATE=missing
if image_has_current_pi_proxy_assets test-image; then
  echo "Missing Pi proxy assets were accepted" >&2
  exit 1
fi

TEST_IMAGE_STATE=current
BUILD_BASE_IMAGE=auto
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 0 ]]

TEST_IMAGE_STATE=stale
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 1 ]]

TEST_IMAGE_STATE=missing
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 2 ]]

echo "Pi Web base-image proxy asset checks passed"
