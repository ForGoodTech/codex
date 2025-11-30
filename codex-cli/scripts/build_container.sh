#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
trap "popd >> /dev/null" EXIT
pushd "$SCRIPT_DIR/.." >> /dev/null || {
  echo "Error: Failed to change directory to $SCRIPT_DIR/.."
  exit 1
}

required_commands=(pnpm docker tar python3 zstd gh)
for cmd in "${required_commands[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: Required command '$cmd' not found in PATH"
    exit 1
  fi
done

install_native_deps=("$SCRIPT_DIR/install_native_deps.py")
if [[ -n "${CODEX_NATIVE_WORKFLOW_URL:-}" ]]; then
  install_native_deps+=("--workflow-url" "$CODEX_NATIVE_WORKFLOW_URL")
fi

pnpm install

if python3 - <<'PY'
import json
from pathlib import Path

pkg = json.loads(Path("package.json").read_text())
scripts = pkg.get("scripts", {})
build = scripts.get("build")
if build:
    raise SystemExit(0)
raise SystemExit(1)
PY
then
  pnpm run build
fi

echo "Installing native dependencies into vendor/"
"${install_native_deps[@]}"

rm -rf ./dist/openai-codex-*.tgz
pnpm pack --pack-destination ./dist
mv ./dist/openai-codex-*.tgz ./dist/codex.tgz

verify_tarball() {
  local tarball=$1
  local targets=(
    "x86_64-unknown-linux-musl"
    "aarch64-unknown-linux-musl"
    "x86_64-apple-darwin"
    "aarch64-apple-darwin"
    "x86_64-pc-windows-msvc"
    "aarch64-pc-windows-msvc"
  )

  for target in "${targets[@]}"; do
    local codex_path="package/vendor/${target}/codex/codex"
    if ! tar -tzf "$tarball" "$codex_path" >/dev/null 2>&1 \
      && ! tar -tzf "$tarball" "${codex_path}.exe" >/dev/null 2>&1; then
      echo "Error: Missing codex binary for target ${target} in ${tarball}"
      exit 1
    fi
  done
}

verify_tarball ./dist/codex.tgz

docker build -t codex -f "./Dockerfile" .
