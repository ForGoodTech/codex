#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../..")
CLI_ROOT="$REPO_ROOT/codex-cli"
IMAGE_TAG=${CODEX_INTERACTIVE_IMAGE_TAG:-codex-interactive}

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
