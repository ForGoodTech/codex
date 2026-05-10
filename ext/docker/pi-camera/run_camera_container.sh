#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")

IMAGE_TAG=${CODEX_IMAGE_TAG:-my-codex-pi-camera-image}
CONTAINER_NAME=${CODEX_CONTAINER_NAME:-codex-pi-camera}
WORKDIR_MOUNT=${CODEX_WORKDIR_MOUNT:-$REPO_ROOT}
DOCKER_NETWORK=${CODEX_DOCKER_NETWORK:-bridge}
PUBLISH_APP_SERVER_PORT=${PUBLISH_APP_SERVER_PORT:-0}
APP_SERVER_PROXY_TOKEN=${APP_SERVER_PROXY_TOKEN:-}
CODEX_DOCKER_EXTRA_ARGS=${CODEX_DOCKER_EXTRA_ARGS:-}

usage() {
  cat <<'EOF'
Usage: run_camera_container.sh [command...]

Runs the Codex Pi camera image with selected host camera devices exposed to the
container. If no command is provided, the container starts an interactive shell.

Environment:
  CODEX_IMAGE_TAG           image to run (default: my-codex-pi-camera-image)
  CODEX_CONTAINER_NAME      container name (default: codex-pi-camera)
  CODEX_WORKDIR_MOUNT       host workspace mounted at /home/node/workdir
  CODEX_DOCKER_NETWORK      Docker network to use (default: bridge)
  PUBLISH_APP_SERVER_PORT   set to 1 to publish host port 9395 to the app-server proxy
  APP_SERVER_PROXY_TOKEN    proxy handshake token passed through to the container
  CODEX_DOCKER_EXTRA_ARGS   extra docker run arguments for local debugging
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

for cmd in docker realpath stat; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
done

if [[ ! -d "$WORKDIR_MOUNT" ]]; then
  echo "Workspace mount does not exist: $WORKDIR_MOUNT" >&2
  exit 1
fi

docker_args=(
  run
  -it
  --rm
  --name "$CONTAINER_NAME"
  --security-opt no-new-privileges:true
  --cap-drop=ALL
  --network "$DOCKER_NETWORK"
  -e CODEX_CAMERA_CONTAINER=1
  -e APP_SERVER_PROXY_TOKEN="$APP_SERVER_PROXY_TOKEN"
  -v "$WORKDIR_MOUNT:/home/node/workdir"
)

if [[ "$PUBLISH_APP_SERVER_PORT" == "1" ]]; then
  docker_args+=(-p 127.0.0.1:9395:9395)
fi

if [[ -d /run/udev ]]; then
  docker_args+=(--mount type=bind,src=/run/udev,dst=/run/udev,ro)
fi

if [[ -n "$CODEX_DOCKER_EXTRA_ARGS" ]]; then
  read -r -a extra_docker_args <<< "$CODEX_DOCKER_EXTRA_ARGS"
  docker_args+=("${extra_docker_args[@]}")
fi

declare -A group_ids=()
device_count=0

add_device() {
  local device=$1
  if [[ ! -e "$device" ]]; then
    return
  fi
  docker_args+=(--device "$device:$device")
  device_count=$((device_count + 1))

  local gid
  gid=$(stat -c '%g' "$device")
  if [[ -n "$gid" && "$gid" != "0" ]]; then
    group_ids["$gid"]=1
  fi
}

shopt -s nullglob
for device in \
  /dev/video* \
  /dev/media* \
  /dev/v4l-subdev* \
  /dev/dri/* \
  /dev/dma_heap/* \
  /dev/vchiq \
  /dev/vcsm-cma \
  /dev/vcio; do
  add_device "$device"
done

for gid in "${!group_ids[@]}"; do
  docker_args+=(--group-add "$gid")
done

if [[ "$device_count" -eq 0 ]]; then
  echo "Warning: no camera-related /dev nodes were found on the host." >&2
fi

if [[ $# -eq 0 ]]; then
  set -- bash
fi

exec docker "${docker_args[@]}" "$IMAGE_TAG" "$@"
