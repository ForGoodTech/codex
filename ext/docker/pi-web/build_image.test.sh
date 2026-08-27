#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
source "$SCRIPT_DIR/build_image.sh"

grep -Fq 'com.surestinfo.codex.runtime-profile="pi-web"' "$SCRIPT_DIR/Dockerfile"
grep -Fq 'webdev-deploy /usr/local/bin/webdev-deploy' "$SCRIPT_DIR/Dockerfile"

TEST_IMAGE_STATE=current
TEST_LABEL_STATE=current
BASE_BUILD_CALLS=0
NGINX_INCLUDE_CHECK_IMAGE=

function docker() {
  if [[ "$1" == "image" && "$2" == "inspect" ]]; then
    if [[ "${3:-}" == "--format" ]]; then
      if [[ "$TEST_LABEL_STATE" == "current" ]]; then
        printf '%s\n' "$CODEX_RUNTIME_IMAGE_CONTRACT_VERSION"
      else
        printf '%s\n' "stale"
      fi
    fi
    return 0
  fi
  if [[ "$1" == "run" && "${4:-}" == "bash" ]]; then
    NGINX_INCLUDE_CHECK_IMAGE=${5:-}
    return 0
  fi
  if [[ "$1" != "run" ]]; then
    echo "Unexpected docker command in test: $*" >&2
    return 2
  fi

  case "$TEST_IMAGE_STATE" in
    current)
      for index in "${!CODEX_RUNTIME_IMAGE_CONTRACT_SOURCES[@]}"; do
        printf '%s  %s\n' \
          "$(sha256sum "${CODEX_RUNTIME_IMAGE_CONTRACT_SOURCES[$index]}" | awk '{print $1}')" \
          "${CODEX_RUNTIME_IMAGE_CONTRACT_PATHS[$index]}"
      done
      ;;
    stale)
      for path in "${CODEX_RUNTIME_IMAGE_CONTRACT_PATHS[@]}"; do
        printf '%064d  %s\n' 0 "$path"
      done
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

codex_runtime_image_has_current_contract test-image

TEST_IMAGE_STATE=stale
if codex_runtime_image_has_current_contract test-image; then
  echo "Stale runtime image contract assets were accepted" >&2
  exit 1
fi

TEST_IMAGE_STATE=missing
if codex_runtime_image_has_current_contract test-image; then
  echo "Missing runtime image contract assets were accepted" >&2
  exit 1
fi

TEST_IMAGE_STATE=current
TEST_LABEL_STATE=stale
if codex_runtime_image_has_current_contract test-image; then
  echo "Stale runtime image contract label was accepted" >&2
  exit 1
fi

TEST_IMAGE_STATE=current
TEST_LABEL_STATE=current
BUILD_BASE_IMAGE=auto
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 0 ]]

TEST_IMAGE_STATE=stale
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 1 ]]

TEST_IMAGE_STATE=missing
build_base_if_needed
[[ "$BASE_BUILD_CALLS" -eq 2 ]]

verify_nginx_site_include test-pi-web-image
[[ "$NGINX_INCLUDE_CHECK_IMAGE" == "test-pi-web-image" ]]

echo "Pi Web runtime contract and Nginx include checks passed"
