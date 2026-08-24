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
  CAMERA_LATEST_FRAME_PATH
                    atomically updated JPEG for OpenCV/NCNN consumers
                    (default: /tmp/codex-camera/latest.jpg; off disables)
  CAMERA_LATEST_FRAME_FPS
                    latest-frame refresh rate (default: 1)
  CAMERA_LATEST_FRAME_QUALITY
                    ffmpeg JPEG quality, 2 is high quality (default: 2)
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
CAMERA_LATEST_FRAME_PATH=${CAMERA_LATEST_FRAME_PATH-/tmp/codex-camera/latest.jpg}
CAMERA_LATEST_FRAME_FPS=${CAMERA_LATEST_FRAME_FPS:-1}
CAMERA_LATEST_FRAME_QUALITY=${CAMERA_LATEST_FRAME_QUALITY:-2}
case "${CAMERA_LATEST_FRAME_PATH,,}" in
  off|none|disabled) CAMERA_LATEST_FRAME_PATH="" ;;
esac

rpicam_cmd=(rpicam-vid -t 0 --inline -o -)
if [[ -n "$CAMERA_ARGS" ]]; then
  # Intentionally split like a shell command so Codex can pass normal rpicam flags.
  read -r -a extra_camera_args <<< "$CAMERA_ARGS"
  rpicam_cmd+=("${extra_camera_args[@]}")
fi

ffmpeg_cmd=(ffmpeg -hide_banner -y -fflags nobuffer -flags low_delay -f h264 -i - -map 0:v:0)
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
if [[ -n "$CAMERA_LATEST_FRAME_PATH" ]]; then
  mkdir -p -- "$(dirname "$CAMERA_LATEST_FRAME_PATH")"
  ffmpeg_cmd+=(
    -map 0:v:0
    -vf "fps=$CAMERA_LATEST_FRAME_FPS"
    -c:v mjpeg
    -q:v "$CAMERA_LATEST_FRAME_QUALITY"
    -update 1
    -atomic_writing 1
    -f image2
    "$CAMERA_LATEST_FRAME_PATH"
  )
fi

echo "Starting camera RTP stream to $DESTINATION" >&2
if [[ -n "$CAMERA_LATEST_FRAME_PATH" ]]; then
  echo "Publishing atomic analysis frames to $CAMERA_LATEST_FRAME_PATH" >&2
fi
"${rpicam_cmd[@]}" | "${ffmpeg_cmd[@]}"
