#!/bin/bash
set -euo pipefail

usage() {
  local script_name
  script_name=$(basename "$0")
  cat <<'EOF' | sed "s/SCRIPT_NAME/$script_name/g"
Usage: SCRIPT_NAME <audio-rtp-url>

Streams runtime audio as Opus RTP. By default it tries to capture the
PulseAudio monitor created by codex-runtime-audio-setup and falls back to a
lavfi source when PulseAudio is unavailable.

Environment:
  CODEX_RUNTIME_AUDIO_CAPTURE        auto, pulse, lavfi, or alsa (default: auto)
  CODEX_RUNTIME_AUDIO_SRC            lavfi source when capture=lavfi
  APP_SERVER_APP_SURFACE_AUDIO_SRC   app-surface lavfi source override
  CAMERA_AUDIO_SRC                   camera lavfi source override
  CODEX_RUNTIME_AUDIO_SINK           PulseAudio sink name (default: codex_runtime_sink)
  CODEX_RUNTIME_PULSE_MONITOR        PulseAudio monitor source override
  CODEX_RUNTIME_ALSA_DEVICE          ALSA input device when capture=alsa

Legacy CODEX_BROWSER_AUDIO_* variables are also accepted.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

audio_rtp_url=$1
capture=${CODEX_RUNTIME_AUDIO_CAPTURE:-${CODEX_BROWSER_AUDIO_CAPTURE:-}}
audio_src=${CODEX_RUNTIME_AUDIO_SRC:-${CODEX_BROWSER_AUDIO_SRC:-}}

for env_key in APP_SERVER_APP_SURFACE_AUDIO_CAPTURE CAMERA_AUDIO_CAPTURE; do
  env_value=${!env_key:-}
  if [[ -n "$env_value" ]]; then
    capture=$env_value
  fi
done

for env_key in APP_SERVER_APP_SURFACE_AUDIO_SRC CAMERA_AUDIO_SRC; do
  env_value=${!env_key:-}
  if [[ -n "$env_value" ]]; then
    audio_src=$env_value
  fi
done

if [[ -z "$capture" ]]; then
  if [[ -n "$audio_src" ]]; then
    capture=lavfi
  else
    capture=auto
  fi
fi

capture=$(printf '%s' "$capture" | tr '[:upper:]' '[:lower:]')
default_lavfi_src='anullsrc=channel_layout=stereo:sample_rate=48000'
ffmpeg_loglevel=${FFMPEG_LOGLEVEL:-warning}
input_args=()

setup_pulse() {
  if [[ -r /home/node/runtime-audio-setup.sh ]]; then
    # shellcheck source=/home/node/runtime-audio-setup.sh
    . /home/node/runtime-audio-setup.sh
  elif [[ -r /home/node/browser-audio-setup.sh ]]; then
    # shellcheck source=/home/node/browser-audio-setup.sh
    . /home/node/browser-audio-setup.sh
  fi
  local sink=${CODEX_RUNTIME_AUDIO_SINK:-${CODEX_BROWSER_AUDIO_SINK:-codex_runtime_sink}}
  local monitor=${CODEX_RUNTIME_PULSE_MONITOR:-${CODEX_BROWSER_PULSE_MONITOR:-${sink}.monitor}}
  command -v pactl >/dev/null 2>&1 \
    && pactl info >/dev/null 2>&1 \
    && pactl list short sources 2>/dev/null | awk '{print $2}' | grep -Fx "$monitor" >/dev/null 2>&1
}

use_lavfi() {
  local src=${audio_src:-$default_lavfi_src}
  input_args=(-re -f lavfi -i "$src")
}

case "$capture" in
  auto)
    if setup_pulse; then
      sink=${CODEX_RUNTIME_AUDIO_SINK:-${CODEX_BROWSER_AUDIO_SINK:-codex_runtime_sink}}
      pulse_monitor=${CODEX_RUNTIME_PULSE_MONITOR:-${CODEX_BROWSER_PULSE_MONITOR:-${sink}.monitor}}
      input_args=(-f pulse -i "$pulse_monitor")
    else
      echo "$(basename "$0"): PulseAudio unavailable; falling back to lavfi audio" >&2
      use_lavfi
    fi
    ;;
  pulse)
    if ! setup_pulse; then
      echo "$(basename "$0"): PulseAudio capture requested but unavailable" >&2
      exit 1
    fi
    sink=${CODEX_RUNTIME_AUDIO_SINK:-${CODEX_BROWSER_AUDIO_SINK:-codex_runtime_sink}}
    pulse_monitor=${CODEX_RUNTIME_PULSE_MONITOR:-${CODEX_BROWSER_PULSE_MONITOR:-${sink}.monitor}}
    input_args=(-f pulse -i "$pulse_monitor")
    ;;
  lavfi)
    use_lavfi
    ;;
  alsa)
    input_args=(-f alsa -i "${CODEX_RUNTIME_ALSA_DEVICE:-${CODEX_BROWSER_ALSA_DEVICE:-default}}")
    ;;
  *)
    echo "Unsupported CODEX_RUNTIME_AUDIO_CAPTURE value: $capture" >&2
    exit 2
    ;;
esac

exec ffmpeg -hide_banner -loglevel "$ffmpeg_loglevel" \
  "${input_args[@]}" \
  -vn -c:a libopus -ar 48000 -ac 2 -application lowdelay \
  -f rtp "$audio_rtp_url"
