#!/bin/bash
set -euo pipefail

specs=${CODEX_CAMERA_MKNOD_SPECS:-}
if [[ -z "$specs" ]]; then
  exit 0
fi

IFS=';' read -r -a entries <<< "$specs"
for entry in "${entries[@]}"; do
  [[ -n "$entry" ]] || continue

  IFS=',' read -r path major minor <<< "$entry"
  if [[ -z "${path:-}" || -z "${major:-}" || -z "${minor:-}" ]]; then
    echo "Ignoring malformed camera device spec: $entry" >&2
    continue
  fi

  mkdir -p "$(dirname "$path")"
  if [[ -e "$path" && ! -c "$path" ]]; then
    echo "Refusing to replace non-character device: $path" >&2
    exit 1
  fi

  rm -f "$path"
  mknod "$path" c "$major" "$minor"
  chown node:node "$path"
  chmod 660 "$path"
done
