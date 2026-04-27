#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
REPO_ROOT=$(realpath "$SCRIPT_DIR/../../../..")
CLI_ROOT="$REPO_ROOT/codex/codex-cli"
SDK_ROOT="$REPO_ROOT/codex/sdk/typescript"
DOCKER_PI_DIR="$REPO_ROOT/codex/ext/docker/pi"

DEFAULT_CODEX_RELEASE_TAG="rust-v0.125.0"
CODEX_RELEASE_TAG=${CODEX_RELEASE_TAG:-$DEFAULT_CODEX_RELEASE_TAG}
NODE_VERSION=${NODE_VERSION:-24.11.0}
PLAYWRIGHT_MCP_PACKAGE=${PLAYWRIGHT_MCP_PACKAGE:-@playwright/mcp}
PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION:-latest}
CHROME_MCP_PACKAGE=${CHROME_MCP_PACKAGE:-chrome-devtools-mcp}
CHROME_MCP_VERSION=${CHROME_MCP_VERSION:-latest}
GITHUB_MCP_URL=${GITHUB_MCP_URL:-https://api.githubcopilot.com/mcp/}
OPENAI_DOCS_MCP_URL=${OPENAI_DOCS_MCP_URL:-https://developers.openai.com/mcp}
PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC=${PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC:-30}
CHROME_MCP_STARTUP_TIMEOUT_SEC=${CHROME_MCP_STARTUP_TIMEOUT_SEC:-30}
DISTRO_RELEASE=${DISTRO_RELEASE:-bookworm}
ROOTFS_SIZE_GB=${ROOTFS_SIZE_GB:-12}
DEBIAN_MIRROR=${DEBIAN_MIRROR:-http://deb.debian.org/debian}
OUTPUT_ROOT=${OUTPUT_ROOT:-"$REPO_ROOT/target/codex-vm/pi/$CODEX_RELEASE_TAG"}
VENDOR_DIR="$CLI_ROOT/vendor"
VM_PROFILE=${VM_PROFILE:-default}
DEBUG_SSH_AUTHORIZED_KEYS_FILE=${DEBUG_SSH_AUTHORIZED_KEYS_FILE:-}
DEBUG_SSH_USER=${DEBUG_SSH_USER:-node}
DEBUG_SSH_GUEST_IP_CIDR=${DEBUG_SSH_GUEST_IP_CIDR:-172.16.0.2/24}
DEBUG_SSH_HOST_IP_CIDR=${DEBUG_SSH_HOST_IP_CIDR:-172.16.0.1/24}
DEBUG_SSH_GUEST_MAC=${DEBUG_SSH_GUEST_MAC:-06:00:ac:10:00:02}
DEFAULT_FIRECRACKER_BOOT_ARGS="console=ttyS0 reboot=k panic=1 pci=off ip=dhcp root=/dev/vda rw"
if [[ "$VM_PROFILE" == "debug-ssh" ]]; then
  DEFAULT_FIRECRACKER_BOOT_ARGS="console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw"
fi
FIRECRACKER_BOOT_ARGS=${FIRECRACKER_BOOT_ARGS:-$DEFAULT_FIRECRACKER_BOOT_ARGS}
FIRECRACKER_VCPU_COUNT=${FIRECRACKER_VCPU_COUNT:-2}
FIRECRACKER_MEM_MIB=${FIRECRACKER_MEM_MIB:-4096}
KERNEL_IMAGE=${KERNEL_IMAGE:-}

ARCH=$(uname -m)
case "$ARCH" in
  aarch64)
    TARGET_TRIPLE="aarch64-unknown-linux-musl"
    DEBOOTSTRAP_ARCH="arm64"
    NODE_ARCH="arm64"
    ;;
  x86_64)
    TARGET_TRIPLE="x86_64-unknown-linux-musl"
    DEBOOTSTRAP_ARCH="amd64"
    NODE_ARCH="x64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

case "$VM_PROFILE" in
  default)
    ARTIFACT_ROOT="$OUTPUT_ROOT/$ARCH"
    ;;
  debug-ssh)
    ARTIFACT_ROOT="$OUTPUT_ROOT/$ARCH/$VM_PROFILE"
    ;;
  *)
    echo "Unsupported VM_PROFILE: $VM_PROFILE" >&2
    exit 1
    ;;
esac
PAYLOAD_DIR="$ARTIFACT_ROOT/payload"
ROOTFS_DIR="$ARTIFACT_ROOT/rootfs"
ROOTFS_IMAGE="$ARTIFACT_ROOT/rootfs.ext4"
MANIFEST_PATH="$ARTIFACT_ROOT/manifest.json"
BOOT_ARGS_PATH="$ARTIFACT_ROOT/firecracker.boot_args"
CONFIG_TEMPLATE_PATH="$ARTIFACT_ROOT/firecracker_vm_config.template.json"
STAGED_BIN_ROOT="$REPO_ROOT/target/codex-release-bin/$CODEX_RELEASE_TAG/$TARGET_TRIPLE"
CODEX_BIN_SRC="$STAGED_BIN_ROOT/codex"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

install_host_file() {
  local src=$1
  local dest=$2
  local mode=${3:-}

  mkdir -p "$(dirname "$dest")"
  cp -f "$src" "$dest"
  if [[ -n "$mode" ]]; then
    chmod "$mode" "$dest" 2>/dev/null || true
  fi
}

for cmd in curl debootstrap find install jq mkfs.ext4 mount mountpoint npm pnpm rsync sudo tar truncate umount; do
  require_cmd "$cmd"
done

if [[ ! -d "$CLI_ROOT" ]]; then
  echo "Codex CLI directory not found at: $CLI_ROOT" >&2
  exit 1
fi

if [[ ! -d "$SDK_ROOT/dist" ]]; then
  echo "Codex SDK dist directory not found at: $SDK_ROOT/dist" >&2
  exit 1
fi

if [[ "$VM_PROFILE" == "debug-ssh" ]]; then
  if [[ -z "$DEBUG_SSH_AUTHORIZED_KEYS_FILE" ]]; then
    echo "DEBUG_SSH_AUTHORIZED_KEYS_FILE is required when VM_PROFILE=debug-ssh." >&2
    exit 1
  fi
  if [[ ! -f "$DEBUG_SSH_AUTHORIZED_KEYS_FILE" ]]; then
    echo "Missing authorized keys file: $DEBUG_SSH_AUTHORIZED_KEYS_FILE" >&2
    exit 1
  fi
fi

mkdir -p "$ARTIFACT_ROOT" "$PAYLOAD_DIR" "$ROOTFS_DIR" "$STAGED_BIN_ROOT"

pushd "$CLI_ROOT" >/dev/null
pnpm install

fetch_release_binary() {
  local binary_name=$1
  local target_triple=$2
  local output_path=$3
  local archive_name="${binary_name}-${target_triple}.tar.gz"
  local download_url="https://github.com/openai/codex/releases/download/${CODEX_RELEASE_TAG}/${archive_name}"
  local tmpdir
  tmpdir=$(mktemp -d)
  local archive_path="$tmpdir/$archive_name"

  curl -fLsS "$download_url" -o "$archive_path"
  tar -xzf "$archive_path" -C "$tmpdir"

  local extracted_binary="$tmpdir/$binary_name"
  local triple_named_binary="$tmpdir/${binary_name}-${target_triple}"
  if [[ ! -f "$extracted_binary" && -f "$triple_named_binary" ]]; then
    extracted_binary="$triple_named_binary"
  fi

  if [[ ! -f "$extracted_binary" ]]; then
    extracted_binary=$(find "$tmpdir" -maxdepth 3 -type f \( -name "$binary_name" -o -name "${binary_name}-${target_triple}" \) | head -n 1 || true)
  fi
  if [[ -z "$extracted_binary" || ! -f "$extracted_binary" ]]; then
    echo "Expected binary $binary_name was not found in $archive_name" >&2
    exit 1
  fi

  install_host_file "$extracted_binary" "$output_path" 755
  rm -rf "$tmpdir"
}

ensure_rg_binary() {
  local rg_path
  rg_path=$(command -v rg || true)
  if [[ -n "$rg_path" ]]; then
    echo "$rg_path"
    return
  fi
  echo "ripgrep (rg) not found in PATH." >&2
  exit 1
}

stage_binary() {
  local src=$1
  local dest=$2
  install_host_file "$src" "$dest" 755
}

RG_BIN_SRC=$(ensure_rg_binary)
fetch_release_binary "codex" "$TARGET_TRIPLE" "$CODEX_BIN_SRC"

TARGET_VENDOR="$VENDOR_DIR/$TARGET_TRIPLE"
rm -rf "$TARGET_VENDOR"
mkdir -p "$TARGET_VENDOR/codex" "$TARGET_VENDOR/codex-app-server" "$TARGET_VENDOR/codex-linux-sandbox" "$TARGET_VENDOR/path"
stage_binary "$CODEX_BIN_SRC" "$TARGET_VENDOR/codex/codex"
cat > "$TARGET_VENDOR/codex-app-server/codex-app-server" <<'EOF'
#!/bin/sh
set -eu
SELF_PATH="${0}"
if command -v readlink >/dev/null 2>&1; then
  RESOLVED_PATH="$(readlink -f "$SELF_PATH" 2>/dev/null || true)"
  if [ -n "$RESOLVED_PATH" ]; then
    SELF_PATH="$RESOLVED_PATH"
  fi
fi
exec "$(dirname "$SELF_PATH")/../codex/codex" app-server "$@"
EOF
chmod 755 "$TARGET_VENDOR/codex-app-server/codex-app-server"
cat > "$TARGET_VENDOR/codex-linux-sandbox/codex-linux-sandbox" <<'EOF'
#!/bin/sh
set -eu
SELF_PATH="${0}"
if command -v readlink >/dev/null 2>&1; then
  RESOLVED_PATH="$(readlink -f "$SELF_PATH" 2>/dev/null || true)"
  if [ -n "$RESOLVED_PATH" ]; then
    SELF_PATH="$RESOLVED_PATH"
  fi
fi
exec "$(dirname "$SELF_PATH")/../codex/codex" linux-sandbox "$@"
EOF
chmod 755 "$TARGET_VENDOR/codex-linux-sandbox/codex-linux-sandbox"
stage_binary "$RG_BIN_SRC" "$TARGET_VENDOR/path/rg"

mkdir -p dist
rm -f dist/openai-codex-*.tgz dist/codex.tgz
pnpm pack --pack-destination dist
mv dist/openai-codex-*.tgz dist/codex.tgz
popd >/dev/null

rm -rf "$PAYLOAD_DIR"
mkdir -p "$PAYLOAD_DIR/sdk"
install_host_file "$CLI_ROOT/dist/codex.tgz" "$PAYLOAD_DIR/codex.tgz" 644
install_host_file "$DOCKER_PI_DIR/app-server-proxy.js" "$PAYLOAD_DIR/app-server-proxy.js" 755
install_host_file "$DOCKER_PI_DIR/sdk-proxy.js" "$PAYLOAD_DIR/sdk-proxy.js" 755
install_host_file "$SCRIPT_DIR/codex-proxy.service" "$PAYLOAD_DIR/codex-proxy.service" 644
install_host_file "$SCRIPT_DIR/20-eth0.network" "$PAYLOAD_DIR/20-eth0.network" 644
if [[ "$VM_PROFILE" == "debug-ssh" ]]; then
  install_host_file "$DEBUG_SSH_AUTHORIZED_KEYS_FILE" "$PAYLOAD_DIR/debug_authorized_keys" 600
fi
install_host_file "$SDK_ROOT/package.json" "$PAYLOAD_DIR/sdk/package.json" 644
rsync -a --delete "$SDK_ROOT/dist/" "$PAYLOAD_DIR/sdk/dist/"
rsync -a --delete "$CLI_ROOT/vendor/" "$PAYLOAD_DIR/sdk/vendor/"

sudo rm -rf "$ROOTFS_DIR"
sudo debootstrap --arch="$DEBOOTSTRAP_ARCH" "$DISTRO_RELEASE" "$ROOTFS_DIR" "$DEBIAN_MIRROR"
sudo mkdir -p "$ROOTFS_DIR/tmp/codex-vm-payload"
sudo rsync -a "$PAYLOAD_DIR/" "$ROOTFS_DIR/tmp/codex-vm-payload/"
sudo install -m 755 "$SCRIPT_DIR/provision_rootfs.sh" "$ROOTFS_DIR/tmp/provision_rootfs.sh"
sudo install -d "$ROOTFS_DIR/etc/systemd/system/multi-user.target.wants"

cleanup_mounts() {
  for mounted_path in "$ROOTFS_DIR/dev/pts" "$ROOTFS_DIR/dev" "$ROOTFS_DIR/proc" "$ROOTFS_DIR/sys"; do
    if mountpoint -q "$mounted_path"; then
      sudo umount "$mounted_path"
    fi
  done
}

trap cleanup_mounts EXIT
sudo mount --bind /dev "$ROOTFS_DIR/dev"
sudo mount --bind /dev/pts "$ROOTFS_DIR/dev/pts"
sudo mount --bind /proc "$ROOTFS_DIR/proc"
sudo mount --bind /sys "$ROOTFS_DIR/sys"

sudo chroot "$ROOTFS_DIR" /usr/bin/env \
  PAYLOAD_DIR=/tmp/codex-vm-payload \
  NODE_VERSION="$NODE_VERSION" \
  NODE_ARCH="$NODE_ARCH" \
  PLAYWRIGHT_MCP_PACKAGE="$PLAYWRIGHT_MCP_PACKAGE" \
  PLAYWRIGHT_MCP_VERSION="$PLAYWRIGHT_MCP_VERSION" \
  CHROME_MCP_PACKAGE="$CHROME_MCP_PACKAGE" \
  CHROME_MCP_VERSION="$CHROME_MCP_VERSION" \
  GITHUB_MCP_URL="$GITHUB_MCP_URL" \
  OPENAI_DOCS_MCP_URL="$OPENAI_DOCS_MCP_URL" \
  PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC="$PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC" \
  CHROME_MCP_STARTUP_TIMEOUT_SEC="$CHROME_MCP_STARTUP_TIMEOUT_SEC" \
  ROOT_DEVICE=/dev/vda \
  GUEST_HOSTNAME=codex-firecracker \
  VM_PROFILE="$VM_PROFILE" \
  DEBUG_SSH_USER="$DEBUG_SSH_USER" \
  DEBUG_SSH_GUEST_IP_CIDR="$DEBUG_SSH_GUEST_IP_CIDR" \
  DEBUG_SSH_HOST_IP_CIDR="$DEBUG_SSH_HOST_IP_CIDR" \
  DEBUG_SSH_GUEST_MAC="$DEBUG_SSH_GUEST_MAC" \
  /tmp/provision_rootfs.sh

cleanup_mounts
trap - EXIT

rm -f "$ROOTFS_IMAGE"
truncate -s "${ROOTFS_SIZE_GB}G" "$ROOTFS_IMAGE"
mkfs.ext4 -F -L rootfs "$ROOTFS_IMAGE"

MOUNT_DIR=$(mktemp -d)
cleanup_image_mount() {
  if mountpoint -q "$MOUNT_DIR"; then
    sudo umount "$MOUNT_DIR"
  fi
  rm -rf "$MOUNT_DIR"
}
trap cleanup_image_mount EXIT

sudo mount -o loop "$ROOTFS_IMAGE" "$MOUNT_DIR"
sudo rsync -aHAX --delete "$ROOTFS_DIR/" "$MOUNT_DIR/"
sudo umount "$MOUNT_DIR"
rm -rf "$MOUNT_DIR"
trap - EXIT

printf '%s\n' "$FIRECRACKER_BOOT_ARGS" > "$BOOT_ARGS_PATH"
sed \
  -e "s|__KERNEL_IMAGE_PATH__|${KERNEL_IMAGE:-/path/to/kernel-image}|g" \
  -e "s|__ROOTFS_IMAGE_PATH__|$ROOTFS_IMAGE|g" \
  "$SCRIPT_DIR/firecracker_vm_config.template.json" > "$CONFIG_TEMPLATE_PATH"

cat > "$MANIFEST_PATH" <<EOF
{
  "artifactType": "codex-firecracker-rootfs",
  "artifactVersion": 1,
  "vmProfile": "$VM_PROFILE",
  "arch": "$ARCH",
  "debootstrapArch": "$DEBOOTSTRAP_ARCH",
  "targetTriple": "$TARGET_TRIPLE",
  "codexReleaseTag": "$CODEX_RELEASE_TAG",
  "nodeVersion": "$NODE_VERSION",
  "distroRelease": "$DISTRO_RELEASE",
  "rootfsImage": "$ROOTFS_IMAGE",
  "kernelImage": "${KERNEL_IMAGE}",
  "bootArgs": "$FIRECRACKER_BOOT_ARGS",
  "firecrackerConfigTemplate": "$CONFIG_TEMPLATE_PATH",
  "firecracker": {
    "machineConfig": {
      "vcpu_count": $FIRECRACKER_VCPU_COUNT,
      "mem_size_mib": $FIRECRACKER_MEM_MIB
    }
  },
  "debug": {
    "sshUser": "$DEBUG_SSH_USER",
    "hostIpCidr": "$DEBUG_SSH_HOST_IP_CIDR",
    "guestIpCidr": "$DEBUG_SSH_GUEST_IP_CIDR",
    "guestMac": "$DEBUG_SSH_GUEST_MAC"
  },
  "proxyPort": 9395
}
EOF

echo "Built Codex Firecracker rootfs:"
echo "  Rootfs image: $ROOTFS_IMAGE"
echo "  Manifest:     $MANIFEST_PATH"
echo "  Boot args:    $BOOT_ARGS_PATH"
