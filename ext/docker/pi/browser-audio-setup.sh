#!/bin/sh

# Source this before launching a browser, media player, or other program so
# runtime audio has a capturable per-container PulseAudio sink. It is
# intentionally best-effort; callers can still fall back to lavfi/ALSA audio
# sources when PulseAudio is unavailable.

CODEX_RUNTIME_AUDIO_SINK="${CODEX_RUNTIME_AUDIO_SINK:-${CODEX_BROWSER_AUDIO_SINK:-codex_runtime_sink}}"
CODEX_BROWSER_AUDIO_SINK="${CODEX_BROWSER_AUDIO_SINK:-$CODEX_RUNTIME_AUDIO_SINK}"
export CODEX_RUNTIME_AUDIO_SINK
export CODEX_BROWSER_AUDIO_SINK

if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  v_uid="$(id -u 2>/dev/null || printf '1000')"
  XDG_RUNTIME_DIR="/tmp/codex-runtime-${v_uid}"
  export XDG_RUNTIME_DIR
fi

mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

PULSE_SERVER="${PULSE_SERVER:-unix:${XDG_RUNTIME_DIR}/pulse/native}"
export PULSE_SERVER

codex_runtime_audio_debug()
{
  if [ "${CODEX_RUNTIME_AUDIO_SETUP_DEBUG:-${CODEX_BROWSER_AUDIO_SETUP_DEBUG:-0}}" = "1" ]; then
    printf '%s\n' "$*" >&2
  fi
}

if command -v pulseaudio >/dev/null 2>&1; then
  if ! pulseaudio --check >/dev/null 2>&1; then
    pulseaudio --start --exit-idle-time=-1 --log-target=stderr \
      >>/tmp/codex-pulseaudio.log 2>&1 || \
      codex_runtime_audio_debug "PulseAudio start failed; see /tmp/codex-pulseaudio.log"
  fi
fi

if command -v pactl >/dev/null 2>&1; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if pactl info >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if pactl info >/dev/null 2>&1; then
    if ! pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -Fx "$CODEX_RUNTIME_AUDIO_SINK" >/dev/null 2>&1; then
      pactl load-module module-null-sink \
        sink_name="$CODEX_RUNTIME_AUDIO_SINK" \
        rate=48000 \
        channels=2 \
        sink_properties=device.description=CodexRuntimeAudioSink \
        >/dev/null 2>&1 || true
    fi
    if pactl list short sources 2>/dev/null | awk '{print $2}' | grep -Fx "${CODEX_RUNTIME_AUDIO_SINK}.monitor" >/dev/null 2>&1; then
      pactl set-default-sink "$CODEX_RUNTIME_AUDIO_SINK" >/dev/null 2>&1 || true
      pactl set-default-source "${CODEX_RUNTIME_AUDIO_SINK}.monitor" >/dev/null 2>&1 || true
      CODEX_RUNTIME_AUDIO_READY=1
      CODEX_BROWSER_AUDIO_READY=1
      export CODEX_RUNTIME_AUDIO_READY
      export CODEX_BROWSER_AUDIO_READY
    fi
  fi
fi

return 0 2>/dev/null || exit 0
