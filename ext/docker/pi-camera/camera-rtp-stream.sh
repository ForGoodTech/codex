#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: codex-camera-rtp-stream <rtp-url>

Starts a low-latency Raspberry Pi camera stream and writes it to an RTP
destination, for example:

  codex-camera-rtp-stream 'rtp://receiver:5004?pkt_size=1200'

Environment:
  CAMERA_ARGS       extra rpicam-vid arguments (default: empty)
  FFMPEG_VCODEC     ffmpeg video codec, e.g. copy or libx264 (default: libx264)
  FFMPEG_GOP        GOP size when transcoding (default: 30)
  FFMPEG_PRESET     x264 preset when transcoding (default: ultrafast)
  FFMPEG_TUNE       x264 tune when transcoding (default: zerolatency)
EOF
}

if [[ $# -ne 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  if [[ $# -eq 1 ]]; then
    exit 0
  fi
  exit 2
fi

DESTINATION=$1
FFMPEG_VCODEC=${FFMPEG_VCODEC:-libx264}
FFMPEG_GOP=${FFMPEG_GOP:-30}
FFMPEG_PRESET=${FFMPEG_PRESET:-ultrafast}
FFMPEG_TUNE=${FFMPEG_TUNE:-zerolatency}
CAMERA_ARGS=${CAMERA_ARGS:-}

rpicam_cmd=(rpicam-vid -t 0 --inline -o -)
if [[ -n "$CAMERA_ARGS" ]]; then
  # Intentionally split like a shell command so Codex can pass normal rpicam flags.
  read -r -a extra_camera_args <<< "$CAMERA_ARGS"
  rpicam_cmd+=("${extra_camera_args[@]}")
fi

ffmpeg_cmd=(ffmpeg -hide_banner -fflags nobuffer -flags low_delay -f h264 -i -)
case "$FFMPEG_VCODEC" in
  copy)
    ffmpeg_cmd+=(-c:v copy)
    ;;
  libx264)
    ffmpeg_cmd+=(-c:v libx264 -g "$FFMPEG_GOP" -preset "$FFMPEG_PRESET" -tune "$FFMPEG_TUNE")
    ;;
  *)
    ffmpeg_cmd+=(-c:v "$FFMPEG_VCODEC")
    ;;
esac
ffmpeg_cmd+=(-f rtp "$DESTINATION")

echo "Starting camera RTP stream to $DESTINATION" >&2
"${rpicam_cmd[@]}" | "${ffmpeg_cmd[@]}"
