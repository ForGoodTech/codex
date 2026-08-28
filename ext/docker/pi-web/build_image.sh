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
DEFAULT_CODEX_RELEASE_TAG="rust-v0.149.1"
CODEX_RELEASE_TAG=${CODEX_RELEASE_TAG:-$DEFAULT_CODEX_RELEASE_TAG}
source "$REPO_ROOT/ext/docker/pi/runtime-image-contract.sh"

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

function verify_nginx_site_include() {
  local image=$1

  docker run --rm --entrypoint bash "$image" -c '
set -euo pipefail

# A complete Nginx configuration may share this state directory with the
# generated site fragment. The system configuration must ignore it.
printf "%s\n" "user node;" > /home/node/.webdev/nginx/nginx.conf
nginx -t
'
}

function verify_webdev_nginx_startup() {
  local image=$1

  docker run --rm --entrypoint bash "$image" -c '
set -euo pipefail

test_root=$(mktemp -d)
workspace="$test_root/workspace"
state="$test_root/state"
log="$test_root/webdev.log"
serve_pid=""

cleanup() {
  if [[ -n "$serve_pid" ]]; then
    kill -TERM "$serve_pid" >/dev/null 2>&1 || true
    wait "$serve_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$test_root"
}
trap cleanup EXIT

chmod 755 "$test_root"
mkdir -p "$workspace"
cat >"$workspace/sites.json" <<JSON
{
  "sites": [{
    "name": "vite-php.local.test",
    "host": "vite-php.local.test",
    "root": "/workspace/vite-php",
    "mode": "vite-php",
    "vitePort": 5173
  }, {
    "name": "php.local.test",
    "host": "php.local.test",
    "root": "/workspace/php",
    "mode": "php"
  }]
}
JSON

WEBDEV_WORKSPACE="$workspace" \
WEBDEV_CONFIG="$workspace/sites.json" \
WEBDEV_DECLARED_WORKSPACE=/workspace \
WEBDEV_STATE_DIR="$state" \
WEBDEV_HTTP_PORT=8080 \
WEBDEV_HTTPS_PORT=8443 \
WEBDEV_ALLOW_SELF_SIGNED=1 \
WEBDEV_PERMISSIVE_WORKSPACE=0 \
webdev serve >"$log" 2>&1 &
serve_pid=$!

for _ in $(seq 1 300); do
  if grep -Fq "Starting Nginx on HTTP" "$log"; then
    sleep 0.2
    if kill -0 "$serve_pid" >/dev/null 2>&1; then
      exit 0
    fi
    cat "$log" >&2
    echo "Pi Web Nginx exited immediately after successful configuration validation" >&2
    exit 1
  fi
  if ! kill -0 "$serve_pid" >/dev/null 2>&1; then
    set +e
    wait "$serve_pid"
    status=$?
    set -e
    serve_pid=""
    cat "$log" >&2
    if [[ "$status" -eq 0 ]]; then
      echo "Pi Web startup exited before starting Nginx" >&2
      exit 1
    fi
    exit "$status"
  fi
  sleep 0.1
done

cat "$log" >&2
echo "Timed out waiting for Pi Web Nginx startup" >&2
exit 1
'
}

function main() {
  build_base_if_needed
  cleanup_existing_image

  docker build \
    --build-arg BASE_IMAGE="$BASE_IMAGE" \
    -t "$IMAGE_TAG" \
    -f "$SCRIPT_DIR/Dockerfile" \
    "$REPO_ROOT"

  if ! codex_runtime_image_has_current_contract "$IMAGE_TAG"; then
    echo "Built image $IMAGE_TAG does not satisfy inherited Codex runtime image contract v$CODEX_RUNTIME_IMAGE_CONTRACT_VERSION" >&2
    exit 1
  fi

  docker run --rm "$IMAGE_TAG" webdev doctor --no-config
  verify_nginx_site_include "$IMAGE_TAG"
  verify_webdev_nginx_startup "$IMAGE_TAG"

  echo "Built and verified $IMAGE_TAG from base image $BASE_IMAGE"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
