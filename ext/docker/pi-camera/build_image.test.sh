#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
source "$SCRIPT_DIR/build_image.sh"

TEST_CONTRACT_STATE=current
BASE_BUILD_CALLS=0

function docker() {
  if [[ "$1" == "image" && "$2" == "inspect" ]]; then
    return 0
  fi
  echo "Unexpected docker command in test: $*" >&2
  return 2
}

function codex_runtime_image_has_current_contract() {
  [[ "$TEST_CONTRACT_STATE" == "current" ]]
}

function build_base_image() {
  BASE_BUILD_CALLS=$((BASE_BUILD_CALLS + 1))
}

BUILD_BASE_IMAGE=auto
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 0 ]]

TEST_CONTRACT_STATE=stale
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 1 ]]

BUILD_BASE_IMAGE=true
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 2 ]]

BUILD_BASE_IMAGE=false
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 2 ]]

if ! rg -F -q 'FROM ${BASE_IMAGE}' "$SCRIPT_DIR/Dockerfile"; then
  echo "Pi Camera runtime stage does not inherit BASE_IMAGE" >&2
  exit 1
fi
if rg -q 'pi-camera/(app-server-proxy|sdk-proxy)\.js' "$SCRIPT_DIR/Dockerfile"; then
  echo "Pi Camera Dockerfile must not install private copies of shared runtime proxies" >&2
  exit 1
fi

echo "Pi Camera base-image runtime contract checks passed"
