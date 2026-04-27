#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../../..")
ARCH=$(uname -m)
ARTIFACT_ROOT=${ARTIFACT_ROOT:-}
KERNEL_IMAGE=${KERNEL_IMAGE:-}
FIRECRACKER_BIN=${FIRECRACKER_BIN:-$(command -v firecracker || true)}
DEBUG_SSH_PRIVATE_KEY_FILE=${DEBUG_SSH_PRIVATE_KEY_FILE:-}
APP_SERVER_PROXY_TOKEN=${APP_SERVER_PROXY_TOKEN:-}
TAP_DEV=${TAP_DEV:-fc-tap0}
DELETE_TAP_ON_EXIT=${DELETE_TAP_ON_EXIT:-1}
LOG_TIMEOUT_SEC=${LOG_TIMEOUT_SEC:-180}

for cmd in curl ip jq node rg ssh sudo; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
done

if [[ -z "$FIRECRACKER_BIN" ]]; then
  echo "firecracker binary not found; set FIRECRACKER_BIN." >&2
  exit 1
fi

if [[ -z "$DEBUG_SSH_PRIVATE_KEY_FILE" || ! -f "$DEBUG_SSH_PRIVATE_KEY_FILE" ]]; then
  echo "Missing DEBUG_SSH_PRIVATE_KEY_FILE. Point it at the private key matching the public key baked into the debug-ssh rootfs." >&2
  exit 1
fi

if [[ -z "$ARTIFACT_ROOT" ]]; then
  CODEX_RELEASE_TAG=${CODEX_RELEASE_TAG:-rust-v0.125.0}
  ARTIFACT_ROOT="$REPO_ROOT/target/codex-vm/pi/$CODEX_RELEASE_TAG/$ARCH/debug-ssh"
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

VM_PROFILE=$(jq -r '.vmProfile // "default"' "$MANIFEST_PATH")
if [[ "$VM_PROFILE" != "debug-ssh" ]]; then
  echo "Artifact profile is '$VM_PROFILE', not 'debug-ssh': $MANIFEST_PATH" >&2
  exit 1
fi

BOOT_ARGS=$(jq -r '.bootArgs // "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw"' "$MANIFEST_PATH")
VCPU_COUNT=$(jq -r '.firecracker.machineConfig.vcpu_count // 2' "$MANIFEST_PATH")
MEM_SIZE_MIB=$(jq -r '.firecracker.machineConfig.mem_size_mib // 4096' "$MANIFEST_PATH")
SSH_USER=$(jq -r '.debug.sshUser // "node"' "$MANIFEST_PATH")
HOST_IP_CIDR=$(jq -r '.debug.hostIpCidr // "172.16.0.1/24"' "$MANIFEST_PATH")
GUEST_IP_CIDR=$(jq -r '.debug.guestIpCidr // "172.16.0.2/24"' "$MANIFEST_PATH")
GUEST_IP=${GUEST_IP_CIDR%/*}
GUEST_MAC=$(jq -r '.debug.guestMac // "06:00:ac:10:00:02"' "$MANIFEST_PATH")

RUN_DIR=$(mktemp -d)
API_SOCKET="$RUN_DIR/firecracker.sock"
FC_LOG="$RUN_DIR/firecracker.log"
FC_METRICS="$RUN_DIR/firecracker.metrics"
SERIAL_LOG="$RUN_DIR/serial.log"
ROOTFS_RW="$RUN_DIR/rootfs-rw.ext4"
KNOWN_HOSTS="$RUN_DIR/known_hosts"
CREATED_TAP=0
TEST_FAILED=0

cleanup() {
  if [[ -n "${FC_PID:-}" ]] && kill -0 "$FC_PID" >/dev/null 2>&1; then
    kill "$FC_PID" >/dev/null 2>&1 || true
    wait "$FC_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$CREATED_TAP" -eq 1 && "$DELETE_TAP_ON_EXIT" -eq 1 ]]; then
    sudo ip link del "$TAP_DEV" >/dev/null 2>&1 || true
  fi
  if [[ "$TEST_FAILED" -eq 1 ]]; then
    echo "Preserving run directory for inspection: $RUN_DIR" >&2
    return
  fi
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

setup_tap() {
  local owner=${SUDO_USER:-$USER}
  if ip link show "$TAP_DEV" >/dev/null 2>&1; then
    sudo ip addr flush dev "$TAP_DEV"
  else
    sudo ip tuntap add dev "$TAP_DEV" mode tap user "$owner"
    CREATED_TAP=1
  fi
  sudo ip addr add "$HOST_IP_CIDR" dev "$TAP_DEV"
  sudo ip link set "$TAP_DEV" up
}

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
    sed -n '1,220p' "$FC_LOG" >&2 || true
    echo "Serial log:" >&2
    sed -n '1,220p' "$SERIAL_LOG" >&2 || true
    exit 1
  fi
}

wait_for_ssh() {
  local deadline=$((SECONDS + LOG_TIMEOUT_SEC))
  while (( SECONDS < deadline )); do
    if ssh -o BatchMode=yes \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile="$KNOWN_HOSTS" \
      -o ConnectTimeout=2 \
      -i "$DEBUG_SSH_PRIVATE_KEY_FILE" \
      "${SSH_USER}@${GUEST_IP}" true >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$FC_PID" >/dev/null 2>&1; then
      TEST_FAILED=1
      echo "Firecracker exited before SSH became reachable." >&2
      echo "Serial log:" >&2
      sed -n '1,240p' "$SERIAL_LOG" >&2 || true
      echo "Firecracker log:" >&2
      sed -n '1,240p' "$FC_LOG" >&2 || true
      return 1
    fi
    sleep 1
  done
  TEST_FAILED=1
  echo "Timed out waiting for SSH on ${SSH_USER}@${GUEST_IP}." >&2
  echo "Serial log:" >&2
  sed -n '1,240p' "$SERIAL_LOG" >&2 || true
  echo "Firecracker log:" >&2
  sed -n '1,240p' "$FC_LOG" >&2 || true
  return 1
}

run_protocol_probe() {
  APP_SERVER_TCP_HOST="$GUEST_IP" \
  APP_SERVER_TCP_PORT=9395 \
  APP_SERVER_PROXY_TOKEN="$APP_SERVER_PROXY_TOKEN" \
  node "$SCRIPT_DIR/probe_app_server_proxy.js"
}

setup_tap
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
  TEST_FAILED=1
  echo "Firecracker API socket did not appear: $API_SOCKET" >&2
  exit 1
fi

fc_put "logger" "$(jq -nc --arg log_path "$FC_LOG" '{log_path:$log_path, level:"Info", show_level:true, show_log_origin:false}')"
fc_put "metrics" "$(jq -nc --arg metrics_path "$FC_METRICS" '{metrics_path:$metrics_path}')"
fc_put "machine-config" "$(jq -nc --argjson vcpu "$VCPU_COUNT" --argjson mem "$MEM_SIZE_MIB" '{vcpu_count:$vcpu, mem_size_mib:$mem, smt:false}')"
fc_put "boot-source" "$(jq -nc --arg kernel "$KERNEL_IMAGE" --arg args "$BOOT_ARGS" '{kernel_image_path:$kernel, boot_args:$args}')"
fc_put "drives/rootfs" "$(jq -nc --arg path "$ROOTFS_RW" '{drive_id:"rootfs", path_on_host:$path, is_root_device:true, is_read_only:false}')"
fc_put "network-interfaces/eth0" "$(jq -nc --arg tap "$TAP_DEV" --arg mac "$GUEST_MAC" '{iface_id:"eth0", host_dev_name:$tap, guest_mac:$mac}')"
fc_put "actions" '{"action_type":"InstanceStart"}'

wait_for_ssh
PROBE_OUTPUT=$(run_protocol_probe) || {
  TEST_FAILED=1
  echo "App-server protocol probe failed." >&2
  echo "Serial log:" >&2
  sed -n '1,260p' "$SERIAL_LOG" >&2 || true
  echo "Firecracker log:" >&2
  sed -n '1,260p' "$FC_LOG" >&2 || true
  exit 1
}

echo "$PROBE_OUTPUT"
