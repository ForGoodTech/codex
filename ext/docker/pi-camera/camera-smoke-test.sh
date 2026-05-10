#!/bin/bash
set -euo pipefail

CAPTURE_MS=${CAPTURE_MS:-1000}
CAPTURE_TIMEOUT_SEC=${CAPTURE_TIMEOUT_SEC:-15}
RUN_CAPTURE=1

for arg in "$@"; do
  case "$arg" in
    --no-capture)
      RUN_CAPTURE=0
      ;;
    -h|--help)
      cat <<'EOF'
Usage: codex-camera-smoke-test [--no-capture]

Checks that the container can see Raspberry Pi camera device nodes and that the
camera toolchain is present. By default it also captures a short H.264 stream
and asks ffmpeg to decode one frame.

Environment:
  CAPTURE_MS           rpicam-vid capture duration in milliseconds (default: 1000)
  CAPTURE_TIMEOUT_SEC  timeout for the capture pipeline in seconds (default: 15)
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    return 1
  fi
}

echo "user=$(id -un) uid=$(id -u) groups=$(id -Gn)"
echo "arch=$(dpkg --print-architecture 2>/dev/null || uname -m)"

echo "camera device nodes:"
shopt -s nullglob
devices=(/dev/video* /dev/media* /dev/v4l-subdev* /dev/dri/* /dev/dma_heap/* /dev/vchiq /dev/vcsm-cma /dev/vcio)
if [[ ${#devices[@]} -eq 0 ]]; then
  echo "  (none found)"
else
  ls -l "${devices[@]}"
fi

require_cmd ffmpeg
ffmpeg -hide_banner -version | sed -n '1p'

require_cmd rpicam-vid
rpicam-vid --version || true

if command -v rpicam-hello >/dev/null 2>&1; then
  echo "available cameras:"
  rpicam-hello --list-cameras
fi

if [[ "$RUN_CAPTURE" -eq 0 ]]; then
  exit 0
fi

echo "capturing ${CAPTURE_MS}ms H.264 stream and decoding one frame with ffmpeg..."
timeout "$CAPTURE_TIMEOUT_SEC" \
  bash -o pipefail -c \
    'rpicam-vid -t "$1" -n --inline -o - | ffmpeg -hide_banner -loglevel error -f h264 -i - -frames:v 1 -f null -' \
    _ "$CAPTURE_MS"
echo "camera smoke test passed"
