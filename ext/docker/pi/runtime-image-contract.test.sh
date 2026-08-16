#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
source "$SCRIPT_DIR/runtime-image-contract.sh"

if ! rg -F -q \
  "LABEL $CODEX_RUNTIME_IMAGE_CONTRACT_LABEL=\"$CODEX_RUNTIME_IMAGE_CONTRACT_VERSION\"" \
  "$SCRIPT_DIR/Dockerfile"; then
  echo "Pi base Dockerfile does not publish runtime image contract v$CODEX_RUNTIME_IMAGE_CONTRACT_VERSION" >&2
  exit 1
fi

for index in "${!CODEX_RUNTIME_IMAGE_CONTRACT_SOURCES[@]}"; do
  source_path=${CODEX_RUNTIME_IMAGE_CONTRACT_SOURCES[$index]#"$REPO_ROOT/"}
  image_path=${CODEX_RUNTIME_IMAGE_CONTRACT_PATHS[$index]}
  if ! rg -F -q "COPY --chown=node:node $source_path $image_path" "$SCRIPT_DIR/Dockerfile"; then
    echo "Pi base Dockerfile does not install contract asset $source_path at $image_path" >&2
    exit 1
  fi
done

for variant_dir in "$REPO_ROOT"/ext/docker/pi-*; do
  [[ -d "$variant_dir" ]] || continue
  variant_name=$(basename "$variant_dir")
  dockerfile="$variant_dir/Dockerfile"
  build_script="$variant_dir/build_image.sh"
  if [[ ! -f "$dockerfile" || ! -f "$build_script" ]]; then
    echo "Runtime image variant $variant_name must provide Dockerfile and build_image.sh" >&2
    exit 1
  fi
  if ! rg -F -q 'FROM ${BASE_IMAGE}' "$dockerfile"; then
    echo "Runtime image variant $variant_name must inherit its runtime stage from BASE_IMAGE" >&2
    exit 1
  fi
  if ! rg -F -q 'ext/docker/pi/runtime-image-contract.sh' "$build_script"; then
    echo "Runtime image variant $variant_name must source the shared runtime image contract" >&2
    exit 1
  fi
  if ! rg -F -q 'codex_runtime_image_has_current_contract "$IMAGE_TAG"' "$build_script"; then
    echo "Runtime image variant $variant_name must verify its completed image contract" >&2
    exit 1
  fi
done

echo "Pi base and derived runtime image contract declarations passed"
