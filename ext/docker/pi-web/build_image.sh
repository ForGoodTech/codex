#!/bin/bash

# Build the generic Codex Pi web-development image. The actual websites,
# domains, certificates, and databases stay outside this image and are mounted
# at runtime.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
IMAGE_TAG=${CODEX_IMAGE_TAG:-my-codex-pi-web-image}
BASE_IMAGE=${CODEX_BASE_IMAGE_TAG:-my-codex-docker-image}
BUILD_BASE_IMAGE=${BUILD_BASE_IMAGE:-auto}
DEFAULT_CODEX_RELEASE_TAG="rust-v0.143.0"
CODEX_RELEASE_TAG=${CODEX_RELEASE_TAG:-$DEFAULT_CODEX_RELEASE_TAG}

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

function build_base_if_needed() {
  case "$BUILD_BASE_IMAGE" in
    false)
      return
      ;;
    true)
      CODEX_IMAGE_TAG="$BASE_IMAGE" CODEX_RELEASE_TAG="$CODEX_RELEASE_TAG" "$REPO_ROOT/ext/docker/pi/build_image.sh"
      return
      ;;
    auto)
      if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
        return
      fi
      CODEX_IMAGE_TAG="$BASE_IMAGE" CODEX_RELEASE_TAG="$CODEX_RELEASE_TAG" "$REPO_ROOT/ext/docker/pi/build_image.sh"
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

build_base_if_needed
cleanup_existing_image

docker build \
  --build-arg BASE_IMAGE="$BASE_IMAGE" \
  -t "$IMAGE_TAG" \
  -f "$SCRIPT_DIR/Dockerfile" \
  "$REPO_ROOT"

docker run --rm "$IMAGE_TAG" webdev doctor --no-config

echo "Built and verified $IMAGE_TAG from base image $BASE_IMAGE"
