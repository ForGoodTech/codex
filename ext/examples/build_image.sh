#!/bin/bash

# Build a Docker image that packages the client-side example scripts.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../..")
IMAGE_TAG=${CODEX_EXAMPLES_IMAGE_TAG:-codex-examples}

if [[ $# -gt 1 ]]; then
  echo "Usage: $(basename "$0") [image-tag]" >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then
  IMAGE_TAG=$1
fi

docker build -t "$IMAGE_TAG" -f "$SCRIPT_DIR/Dockerfile" "$REPO_ROOT"
