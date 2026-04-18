#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../../..")
ARCH=$(uname -m)
ARTIFACT_ROOT=${ARTIFACT_ROOT:-}
KERNEL_IMAGE=${KERNEL_IMAGE:-}
FIRECRACKER_BIN=${FIRECRACKER_BIN:-$(command -v firecracker || true)}
LOG_TIMEOUT_SEC=${LOG_TIMEOUT_SEC:-90}

for cmd in curl jq rg; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
done

if [[ -z "$FIRECRACKER_BIN" ]]; then
  echo "firecracker binary not found; set FIRECRACKER_BIN." >&2
  exit 1
fi

if [[ -z "$ARTIFACT_ROOT" ]]; then
  CODEX_RELEASE_TAG=${CODEX_RELEASE_TAG:-rust-v0.118.0}
  ARTIFACT_ROOT="$REPO_ROOT/target/codex-vm/pi/$CODEX_RELEASE_TAG/$ARCH"
fi

ROOTFS_IMAGE="$ARTIFACT_ROOT/rootfs.ext4"
MANIFEST_PATH="$ARTIFACT_ROOT/manifest.json"

if [[ ! -f "$ROOTFS_IMAGE" ]]; then
  echo "Missing rootfs image: $ROOTFS_IMAGE" >&2
  exit 1
fi

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "Missing manifest: $MANIFEST_PATH" >&2
  exit 1
fi

if [[ -z "$KERNEL_IMAGE" ]]; then
  KERNEL_IMAGE=$(jq -r '.kernelImage // empty' "$MANIFEST_PATH")
fi

if [[ -z "$KERNEL_IMAGE" || ! -f "$KERNEL_IMAGE" ]]; then
  echo "Missing kernel image. Set KERNEL_IMAGE or populate manifest kernelImage." >&2
  exit 1
fi

KERNEL_FILE_DESC=""
if command -v file >/dev/null 2>&1; then
  KERNEL_FILE_DESC=$(file -b "$KERNEL_IMAGE" 2>/dev/null || true)
fi

BOOT_ARGS=$(jq -r '.bootArgs // "console=ttyS0 reboot=k panic=1 pci=off ip=dhcp root=/dev/vda rw"' "$MANIFEST_PATH")
VCPU_COUNT=$(jq -r '.firecracker.machineConfig.vcpu_count // 2' "$MANIFEST_PATH")
MEM_SIZE_MIB=$(jq -r '.firecracker.machineConfig.mem_size_mib // 4096' "$MANIFEST_PATH")

RUN_DIR=$(mktemp -d)
API_SOCKET="$RUN_DIR/firecracker.sock"
FC_LOG="$RUN_DIR/firecracker.log"
FC_METRICS="$RUN_DIR/firecracker.metrics"
SERIAL_LOG="$RUN_DIR/serial.log"
ROOTFS_RW="$RUN_DIR/rootfs-rw.ext4"
KEEP_RUN_DIR_ON_FAILURE=${KEEP_RUN_DIR_ON_FAILURE:-1}
TEST_FAILED=0

cleanup() {
  if [[ -n "${FC_PID:-}" ]] && kill -0 "$FC_PID" >/dev/null 2>&1; then
    kill "$FC_PID" >/dev/null 2>&1 || true
    wait "$FC_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$TEST_FAILED" -eq 1 && "$KEEP_RUN_DIR_ON_FAILURE" -eq 1 ]]; then
    echo "Preserving run directory for inspection: $RUN_DIR" >&2
    return
  fi
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

cp --reflink=auto "$ROOTFS_IMAGE" "$ROOTFS_RW"

"$FIRECRACKER_BIN" --api-sock "$API_SOCKET" >"$SERIAL_LOG" 2>"$FC_LOG" &
FC_PID=$!

for _ in $(seq 1 100); do
  if [[ -S "$API_SOCKET" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -S "$API_SOCKET" ]]; then
  echo "Firecracker API socket did not appear: $API_SOCKET" >&2
  exit 1
fi

fc_put() {
  local path=$1
  local json=$2
  local response_file="$RUN_DIR/curl-response-$(echo "$path" | tr '/:' '__').txt"
  local status
  status=$(curl --silent --show-error \
    --output "$response_file" \
    --write-out '%{http_code}' \
    --unix-socket "$API_SOCKET" \
    -X PUT \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    "http://localhost/${path}" \
    -d "$json")
  if [[ "$status" != "204" && "$status" != "200" && "$status" != "201" ]]; then
    TEST_FAILED=1
    echo "Firecracker API request failed: PUT /${path} -> HTTP ${status}" >&2
    if [[ -s "$response_file" ]]; then
      echo "Response body:" >&2
      cat "$response_file" >&2
    fi
    echo "Firecracker log:" >&2
    sed -n '1,200p' "$FC_LOG" >&2 || true
    echo "Serial log:" >&2
    sed -n '1,200p' "$SERIAL_LOG" >&2 || true
    if rg -q 'Kernel Loader: failed to load PE kernel image: PE Kernel Loader: invalid Image magic number' "$response_file" "$FC_LOG"; then
      echo "Kernel hint:" >&2
      echo "  Host architecture: $ARCH" >&2
      echo "  Kernel image path: $KERNEL_IMAGE" >&2
      if [[ -n "$KERNEL_FILE_DESC" ]]; then
        echo "  file(1): $KERNEL_FILE_DESC" >&2
      fi
      echo "  Firecracker on aarch64 loads the guest kernel via its PE loader." >&2
      echo "  This usually means KERNEL_IMAGE is not a bootable arm64 Firecracker kernel for this host." >&2
      echo "  Use an aarch64 kernel artifact that matches Firecracker's guest-kernel expectations for arm64," >&2
      echo "  such as the official Firecracker CI kernel for aarch64, instead of an x86 kernel or a random file named vmlinux." >&2
    fi
    return 1
  fi
}

fc_put "logger" "$(jq -nc --arg log_path "$FC_LOG" '{log_path:$log_path, level:"Info", show_level:true, show_log_origin:false}')"
fc_put "metrics" "$(jq -nc --arg metrics_path "$FC_METRICS" '{metrics_path:$metrics_path}')"
fc_put "machine-config" "$(jq -nc --argjson vcpu "$VCPU_COUNT" --argjson mem "$MEM_SIZE_MIB" '{vcpu_count:$vcpu, mem_size_mib:$mem, smt:false}')"
fc_put "boot-source" "$(jq -nc --arg kernel "$KERNEL_IMAGE" --arg args "$BOOT_ARGS" '{kernel_image_path:$kernel, boot_args:$args}')"
fc_put "drives/rootfs" "$(jq -nc --arg path "$ROOTFS_RW" '{drive_id:"rootfs", path_on_host:$path, is_root_device:true, is_read_only:false}')"
fc_put "actions" '{"action_type":"InstanceStart"}'

deadline=$((SECONDS + LOG_TIMEOUT_SEC))
while (( SECONDS < deadline )); do
  if rg -q "Server listening|Client connected|Using APP_SERVER_PROXY_TOKEN|Starting codex-app-server" "$SERIAL_LOG"; then
    echo "Firecracker smoke test passed."
    echo "Serial log: $SERIAL_LOG"
    echo "Firecracker log: $FC_LOG"
    exit 0
  fi
  if ! kill -0 "$FC_PID" >/dev/null 2>&1; then
    echo "Firecracker exited before proxy startup was observed." >&2
    echo "Serial log:" >&2
    sed -n '1,200p' "$SERIAL_LOG" >&2 || true
    echo "Firecracker log:" >&2
    sed -n '1,200p' "$FC_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

echo "Timed out waiting for proxy startup log on serial console." >&2
echo "Serial log:" >&2
sed -n '1,200p' "$SERIAL_LOG" >&2 || true
echo "Firecracker log:" >&2
sed -n '1,200p' "$FC_LOG" >&2 || true
exit 1
