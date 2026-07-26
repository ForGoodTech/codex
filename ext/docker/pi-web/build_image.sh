#!/bin/bash

# Build the generic Codex Pi web-development image. The actual websites,
# domains, certificates, and databases stay outside this image and are mounted
# at runtime.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "${BASH_SOURCE[0]}")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
IMAGE_TAG=${CODEX_IMAGE_TAG:-my-codex-pi-web-image}
BASE_IMAGE=${CODEX_BASE_IMAGE_TAG:-my-codex-docker-image}
BUILD_BASE_IMAGE=${BUILD_BASE_IMAGE:-auto}
DEFAULT_CODEX_RELEASE_TAG="rust-v0.145.0"
CODEX_RELEASE_TAG=${CODEX_RELEASE_TAG:-$DEFAULT_CODEX_RELEASE_TAG}
PI_PROXY_SOURCE="$REPO_ROOT/ext/docker/pi/app-server-proxy.js"
PI_PROXY_PERF_SOURCE="$REPO_ROOT/ext/docker/pi/app-server-proxy-perf.js"

if [[ $# -gt 2 ]]; then
  echo "Usage: $(basename "$0") [image-tag] [base-image-tag]" >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then
  IMAGE_TAG=$1
fi

if [[ $# -ge 2 ]]; then
  BASE_IMAGE=$2
fi

case "$BUILD_BASE_IMAGE" in
  auto|true|false) ;;
  *)
    echo "Unsupported BUILD_BASE_IMAGE=$BUILD_BASE_IMAGE; expected auto, true, or false" >&2
    exit 1
    ;;
esac

function image_has_current_pi_proxy_assets() {
  local image=$1
  local image_hash_output
  local -a image_hashes
  local expected_proxy_hash
  local expected_perf_hash

  expected_proxy_hash=$(sha256sum "$PI_PROXY_SOURCE" | awk '{print $1}')
  expected_perf_hash=$(sha256sum "$PI_PROXY_PERF_SOURCE" | awk '{print $1}')
  if ! image_hash_output=$(
    docker run --rm --entrypoint sha256sum "$image" \
      /home/node/app-server-proxy.js \
      /home/node/app-server-proxy-perf.js 2>/dev/null
  ); then
    return 1
  fi
  mapfile -t image_hashes < <(awk '{print $1}' <<< "$image_hash_output")

  [[ ${#image_hashes[@]} -eq 2 ]] &&
    [[ "${image_hashes[0]}" == "$expected_proxy_hash" ]] &&
    [[ "${image_hashes[1]}" == "$expected_perf_hash" ]]
}

function build_base_image() {
  CODEX_IMAGE_TAG="$BASE_IMAGE" \
    CODEX_RELEASE_TAG="$CODEX_RELEASE_TAG" \
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
        if image_has_current_pi_proxy_assets "$BASE_IMAGE"; then
          echo "Reusing base image $BASE_IMAGE with current Pi proxy assets"
          return
        fi
        echo "Rebuilding base image $BASE_IMAGE because its Pi proxy assets are stale or missing"
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
    -t "$IMAGE_TAG" \
    -f "$SCRIPT_DIR/Dockerfile" \
    "$REPO_ROOT"

  if ! image_has_current_pi_proxy_assets "$IMAGE_TAG"; then
    echo "Built image $IMAGE_TAG does not contain the current inherited Pi proxy assets" >&2
    exit 1
  fi

  docker run --rm "$IMAGE_TAG" webdev doctor --no-config

  echo "Built and verified $IMAGE_TAG from base image $BASE_IMAGE"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
