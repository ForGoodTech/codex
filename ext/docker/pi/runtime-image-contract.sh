#!/bin/bash

# Shared contract for every gateway-managed Codex runtime image.
#
# Derived-image build scripts source this file and reject base/final images
# whose control-plane assets do not exactly match the canonical Pi sources.
# The image label is also checked by the gateway before it starts a runtime.

CODEX_RUNTIME_IMAGE_CONTRACT_LABEL="com.surestinfo.codex.runtime-contract"
CODEX_RUNTIME_IMAGE_CONTRACT_VERSION="2"

CODEX_RUNTIME_IMAGE_CONTRACT_SCRIPT_DIR=$(realpath "$(dirname "${BASH_SOURCE[0]}")")
CODEX_RUNTIME_IMAGE_CONTRACT_REPO_ROOT=$(realpath "$CODEX_RUNTIME_IMAGE_CONTRACT_SCRIPT_DIR/../../..")

CODEX_RUNTIME_IMAGE_CONTRACT_SOURCES=(
  "$CODEX_RUNTIME_IMAGE_CONTRACT_REPO_ROOT/ext/docker/pi/app-server-proxy.js"
  "$CODEX_RUNTIME_IMAGE_CONTRACT_REPO_ROOT/ext/docker/pi/app-server-proxy-perf.js"
  "$CODEX_RUNTIME_IMAGE_CONTRACT_REPO_ROOT/ext/docker/pi/cli-auth-broker.js"
  "$CODEX_RUNTIME_IMAGE_CONTRACT_REPO_ROOT/ext/docker/pi/app-surface-coordinator.js"
  "$CODEX_RUNTIME_IMAGE_CONTRACT_REPO_ROOT/ext/docker/pi/app-surface-send.js"
  "$CODEX_RUNTIME_IMAGE_CONTRACT_REPO_ROOT/ext/docker/pi/browser-audio-setup.sh"
  "$CODEX_RUNTIME_IMAGE_CONTRACT_REPO_ROOT/ext/docker/pi/browser-audio-rtp-stream.sh"
  "$CODEX_RUNTIME_IMAGE_CONTRACT_REPO_ROOT/ext/docker/pi/sdk-proxy.js"
)

CODEX_RUNTIME_IMAGE_CONTRACT_PATHS=(
  /home/node/app-server-proxy.js
  /home/node/app-server-proxy-perf.js
  /home/node/cli-auth-broker.js
  /home/node/app-surface-coordinator.js
  /home/node/app-surface-send.js
  /home/node/browser-audio-setup.sh
  /home/node/browser-audio-rtp-stream.sh
  /home/node/sdk-proxy.js
)

function codex_runtime_image_has_current_contract() {
  local image=$1
  local label_value
  local image_hash_output
  local -a image_hashes
  local index

  if ! label_value=$(
    docker image inspect \
      --format "{{ index .Config.Labels \"$CODEX_RUNTIME_IMAGE_CONTRACT_LABEL\" }}" \
      "$image" 2>/dev/null
  ); then
    return 1
  fi
  if [[ "$label_value" != "$CODEX_RUNTIME_IMAGE_CONTRACT_VERSION" ]]; then
    return 1
  fi

  if ! image_hash_output=$(
    docker run --rm --entrypoint sha256sum "$image" \
      "${CODEX_RUNTIME_IMAGE_CONTRACT_PATHS[@]}" 2>/dev/null
  ); then
    return 1
  fi
  mapfile -t image_hashes < <(awk '{print $1}' <<< "$image_hash_output")

  if [[ ${#image_hashes[@]} -ne ${#CODEX_RUNTIME_IMAGE_CONTRACT_SOURCES[@]} ]]; then
    return 1
  fi
  for index in "${!CODEX_RUNTIME_IMAGE_CONTRACT_SOURCES[@]}"; do
    if [[ "${image_hashes[$index]}" != "$(sha256sum "${CODEX_RUNTIME_IMAGE_CONTRACT_SOURCES[$index]}" | awk '{print $1}')" ]]; then
      return 1
    fi
  done
}
