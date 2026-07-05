#!/bin/bash

# Run the generic web-development image with a host-mounted workspace. The
# mounted workspace owns site config, source trees, certs, and database imports.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
IMAGE_TAG=${CODEX_IMAGE_TAG:-my-codex-pi-web-image}
CONTAINER_NAME=${CODEX_CONTAINER_NAME:-codex-pi-web}
WORKSPACE_MOUNT=${WEBDEV_WORKSPACE_MOUNT:-$PWD}
DOCKER_NETWORK=${CODEX_DOCKER_NETWORK:-bridge}
WEBDEV_CONFIG_PATH=${WEBDEV_CONFIG:-/workspace/sites.json}
WEBDEV_HTTP_PORT=${WEBDEV_HTTP_PORT:-80}
WEBDEV_HTTPS_PORT=${WEBDEV_HTTPS_PORT:-443}
WEBDEV_VITE_PORT_RANGE=${WEBDEV_VITE_PORT_RANGE:-5173-5199}
WEBDEV_BIND_ADDRESS=${WEBDEV_BIND_ADDRESS:-127.0.0.1}
PUBLISH_WEB_PORTS=${PUBLISH_WEB_PORTS:-1}
PUBLISH_VITE_PORTS=${PUBLISH_VITE_PORTS:-1}

if [[ $# -eq 0 ]]; then
  set -- webdev serve
fi

docker_args=(
  run
  -it
  --rm
  --name "$CONTAINER_NAME"
  --network "$DOCKER_NETWORK"
  --add-host=host.docker.internal:host-gateway
  -e WEBDEV_WORKSPACE=/workspace
  -e WEBDEV_CONFIG="$WEBDEV_CONFIG_PATH"
  -e MYSQL_HOST="${MYSQL_HOST:-host.docker.internal}"
  -e MYSQL_PORT="${MYSQL_PORT:-3306}"
  -e MYSQL_USER="${MYSQL_USER:-webdev}"
  -e MYSQL_PASSWORD="${MYSQL_PASSWORD:-webdev}"
  -v "$WORKSPACE_MOUNT:/workspace"
)

if [[ "$PUBLISH_WEB_PORTS" == "1" ]]; then
  docker_args+=(
    -p "${WEBDEV_BIND_ADDRESS}:${WEBDEV_HTTP_PORT}:80"
    -p "${WEBDEV_BIND_ADDRESS}:${WEBDEV_HTTPS_PORT}:443"
  )
fi

if [[ "$PUBLISH_VITE_PORTS" == "1" ]]; then
  docker_args+=(
    -p "${WEBDEV_BIND_ADDRESS}:${WEBDEV_VITE_PORT_RANGE}:${WEBDEV_VITE_PORT_RANGE}"
  )
fi

exec docker "${docker_args[@]}" "$IMAGE_TAG" "$@"
