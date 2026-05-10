#!/bin/bash
set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  codex-camera-device-setup

  export HOME=/home/node
  export USER=node
  export LOGNAME=node

  node_uid=$(id -u node)
  node_gid=$(id -g node)
  exec setpriv --reuid "$node_uid" --regid "$node_gid" --keep-groups "$@"
fi

exec "$@"
