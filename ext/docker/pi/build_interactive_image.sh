#!/bin/bash

# Build a Codex Docker image for interactive use, ensuring native dependencies
# are installed before packaging the CLI.
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../..")
CLI_ROOT="$REPO_ROOT/codex-cli"
IMAGE_TAG=${CODEX_INTERACTIVE_IMAGE_TAG:-codex-interactive}

if [[ ! -d "$CLI_ROOT" ]]; then
  echo "Codex CLI directory not found at: $CLI_ROOT" >&2
  exit 1
fi

pushd "$CLI_ROOT" > /dev/null

pnpm install
python3 scripts/install_native_deps.py --component codex --component rg
pnpm run build

mkdir -p dist
rm -f dist/openai-codex-*.tgz dist/codex.tgz
pnpm pack --pack-destination dist
mv dist/openai-codex-*.tgz dist/codex.tgz

docker build -t "$IMAGE_TAG" -f Dockerfile .

popd > /dev/null
