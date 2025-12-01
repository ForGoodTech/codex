#!/bin/bash

# Build a Codex Docker image for interactive use on Raspberry Pi/Ubuntu. This
# script hydrates the CLI's vendor directory using the published npm package so
# native binaries for aarch64-linux are available without relying on the
# general-purpose installer.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
CLI_ROOT="$REPO_ROOT/codex-cli"
IMAGE_TAG=${CODEX_INTERACTIVE_IMAGE_TAG:-codex-interactive}
VENDOR_DIR="$CLI_ROOT/vendor"

if [[ ! -d "$CLI_ROOT" ]]; then
  echo "Codex CLI directory not found at: $CLI_ROOT" >&2
  exit 1
fi

pushd "$CLI_ROOT" > /dev/null

pnpm install

# Hydrate vendor/ from the published npm package (assumes version matches).
PACKAGE_VERSION=$(node -pe "require('./package.json').version")
TEMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

echo "Fetching vendor assets from npm for @openai/codex@$PACKAGE_VERSION..."
npm pack "@openai/codex@$PACKAGE_VERSION" --pack-destination "$TEMP_DIR"
TARBALL=$(ls "$TEMP_DIR"/openai-codex-*.tgz | head -n 1)
if [[ -z "$TARBALL" ]]; then
  echo "Failed to download @openai/codex@$PACKAGE_VERSION from npm." >&2
  exit 1
fi

tar -xzf "$TARBALL" -C "$TEMP_DIR"
if [[ ! -d "$TEMP_DIR/package/vendor" ]]; then
  echo "Downloaded package missing vendor directory." >&2
  exit 1
fi

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
cp -a "$TEMP_DIR/package/vendor/." "$VENDOR_DIR/"

mkdir -p dist
rm -f dist/openai-codex-*.tgz dist/codex.tgz
pnpm pack --pack-destination dist
mv dist/openai-codex-*.tgz dist/codex.tgz

docker build -t "$IMAGE_TAG" -f Dockerfile .

popd > /dev/null
