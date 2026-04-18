#!/bin/bash
set -euo pipefail

PAYLOAD_DIR=${PAYLOAD_DIR:-/tmp/codex-vm-payload}
NODE_VERSION=${NODE_VERSION:-24.11.0}
NODE_ARCH=${NODE_ARCH:-arm64}
PLAYWRIGHT_MCP_PACKAGE=${PLAYWRIGHT_MCP_PACKAGE:-@playwright/mcp}
PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION:-latest}
CHROME_MCP_PACKAGE=${CHROME_MCP_PACKAGE:-chrome-devtools-mcp}
CHROME_MCP_VERSION=${CHROME_MCP_VERSION:-latest}
GITHUB_MCP_URL=${GITHUB_MCP_URL:-https://api.githubcopilot.com/mcp/}
OPENAI_DOCS_MCP_URL=${OPENAI_DOCS_MCP_URL:-https://developers.openai.com/mcp}
PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC=${PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC:-30}
CHROME_MCP_STARTUP_TIMEOUT_SEC=${CHROME_MCP_STARTUP_TIMEOUT_SEC:-30}
ROOT_DEVICE=${ROOT_DEVICE:-/dev/vda}
GUEST_HOSTNAME=${GUEST_HOSTNAME:-codex-firecracker}
VM_PROFILE=${VM_PROFILE:-default}
DEBUG_SSH_USER=${DEBUG_SSH_USER:-node}
DEBUG_SSH_GUEST_IP_CIDR=${DEBUG_SSH_GUEST_IP_CIDR:-172.16.0.2/24}
DEBUG_SSH_HOST_IP_CIDR=${DEBUG_SSH_HOST_IP_CIDR:-172.16.0.1/24}
DEBUG_SSH_GUEST_MAC=${DEBUG_SSH_GUEST_MAC:-06:00:ac:10:00:02}

if [[ ! -d "$PAYLOAD_DIR" ]]; then
  echo "Missing payload directory: $PAYLOAD_DIR" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  aggregate \
  ca-certificates \
  curl \
  dbus-x11 \
  dnsutils \
  fonts-liberation \
  git \
  gnupg2 \
  iproute2 \
  ipset \
  iptables \
  iputils-ping \
  jq \
  less \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libatspi2.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libssl3 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  man-db \
  procps \
  ripgrep \
  systemd \
  systemd-sysv \
  unzip \
  xz-utils \
  xauth \
  xvfb \
  zsh

apt-get install -y --no-install-recommends chromium || true
if [[ "$VM_PROFILE" == "debug-ssh" ]]; then
  apt-get install -y --no-install-recommends openssh-server
fi

NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
curl -fsSL "$NODE_URL" -o "/tmp/${NODE_TARBALL}"
rm -rf /usr/local/lib/nodejs
mkdir -p /usr/local/lib/nodejs
tar -xJf "/tmp/${NODE_TARBALL}" -C /usr/local/lib/nodejs
ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node" /usr/local/bin/node
ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/npm" /usr/local/bin/npm
ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/npx" /usr/local/bin/npx
if [[ -x "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/corepack" ]]; then
  ln -sf "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/corepack" /usr/local/bin/corepack
  corepack enable
fi

id -u node >/dev/null 2>&1 || useradd -m -s /bin/bash node
echo "$GUEST_HOSTNAME" > /etc/hostname
cat > /etc/hosts <<EOF
127.0.0.1 localhost
127.0.1.1 ${GUEST_HOSTNAME}
EOF
cat > /etc/fstab <<EOF
${ROOT_DEVICE} / ext4 defaults 0 1
EOF
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id

install -d -o node -g node /home/node/workdir
install -d -o node -g node /home/node/.codex
install -d -o node -g node /home/node/node_modules/@openai/codex-sdk
install -d -o node -g node /usr/local/share/npm-global
install -d /etc/systemd/network
install -d /etc/ssh/sshd_config.d

cat > /etc/profile.d/codex-npm-global.sh <<'EOF'
export NPM_CONFIG_PREFIX=/usr/local/share/npm-global
export PATH="${PATH}:/usr/local/share/npm-global/bin"
EOF
chmod 644 /etc/profile.d/codex-npm-global.sh
export NPM_CONFIG_PREFIX=/usr/local/share/npm-global
export PATH="${PATH}:/usr/local/share/npm-global/bin"

runuser -u node -- env NPM_CONFIG_PREFIX="$NPM_CONFIG_PREFIX" PATH="$PATH" npm install -g "${PAYLOAD_DIR}/codex.tgz"
runuser -u node -- env NPM_CONFIG_PREFIX="$NPM_CONFIG_PREFIX" PATH="$PATH" npm install -g \
  "${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}" \
  "${CHROME_MCP_PACKAGE}@${CHROME_MCP_VERSION}"

INSTALL_ROOT="/usr/local/share/npm-global/lib/node_modules/@openai/codex"
CODEX_BIN=""
APP_SERVER_BIN=""
LINUX_SANDBOX_BIN=""
if [[ -d "${INSTALL_ROOT}/vendor" ]]; then
  CODEX_BIN=$(find "${INSTALL_ROOT}/vendor" -maxdepth 3 -type f -name codex | head -n 1 || true)
  if [[ -n "$CODEX_BIN" ]]; then
    chmod 755 "$CODEX_BIN" || true
    ln -sf "$CODEX_BIN" /usr/local/bin/codex
  fi

  APP_SERVER_BIN=$(find "${INSTALL_ROOT}/vendor" -maxdepth 3 -type f -name codex-app-server | head -n 1 || true)
  if [[ -n "$APP_SERVER_BIN" ]]; then
    chmod 755 "$APP_SERVER_BIN" || true
    ln -sf "$APP_SERVER_BIN" /usr/local/bin/codex-app-server
  fi

  LINUX_SANDBOX_BIN=$(find "${INSTALL_ROOT}/vendor" -maxdepth 3 -type f -name codex-linux-sandbox | head -n 1 || true)
  if [[ -n "$LINUX_SANDBOX_BIN" ]]; then
    chmod 755 "$LINUX_SANDBOX_BIN" || true
    ln -sf "$LINUX_SANDBOX_BIN" /usr/local/bin/codex-linux-sandbox
  fi
fi

install -m 755 "${PAYLOAD_DIR}/app-server-proxy.js" /usr/local/bin/codex-app-server-proxy
install -m 755 "${PAYLOAD_DIR}/sdk-proxy.js" /usr/local/bin/codex-sdk-proxy

install -d -o node -g node /home/node/node_modules/@openai/codex-sdk/dist
install -d -o node -g node /home/node/node_modules/@openai/codex-sdk/vendor
cp -f "${PAYLOAD_DIR}/sdk/package.json" /home/node/node_modules/@openai/codex-sdk/package.json
cp -a "${PAYLOAD_DIR}/sdk/dist/." /home/node/node_modules/@openai/codex-sdk/dist/
cp -a "${PAYLOAD_DIR}/sdk/vendor/." /home/node/node_modules/@openai/codex-sdk/vendor/
chown -R node:node /home/node/node_modules/@openai/codex-sdk

cat > /home/node/.codex/config.toml <<EOF
sandbox_mode = "danger-full-access"

[mcp_servers.openai_docs]
url = "${OPENAI_DOCS_MCP_URL}"

[mcp_servers.playwright]
command = "npx"
args = ["-y", "${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}", "--browser", "chromium"]
startup_timeout_sec = ${PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC}

[mcp_servers.chrome_devtools]
command = "npx"
args = ["-y", "${CHROME_MCP_PACKAGE}@${CHROME_MCP_VERSION}"]
startup_timeout_sec = ${CHROME_MCP_STARTUP_TIMEOUT_SEC}

[mcp_servers.github]
url = "${GITHUB_MCP_URL}"
EOF
chown node:node /home/node/.codex/config.toml
chmod 600 /home/node/.codex/config.toml

cat > /etc/codex-proxy.env <<EOF
APP_SERVER_HOST=0.0.0.0
APP_SERVER_PORT=9395
PATH=/usr/local/bin:/usr/local/share/npm-global/bin:/usr/bin:/bin
APP_SERVER_CMD=${APP_SERVER_BIN:-/usr/local/bin/codex-app-server}
APP_SERVER_CODEX_LINUX_SANDBOX_EXE=${LINUX_SANDBOX_BIN:-/usr/local/bin/codex-linux-sandbox}
CODEX_UNSAFE_ALLOW_NO_SANDBOX=1
EOF
chmod 644 /etc/codex-proxy.env

install -m 644 "${PAYLOAD_DIR}/codex-proxy.service" /etc/systemd/system/codex-proxy.service
if [[ "$VM_PROFILE" == "debug-ssh" ]]; then
  cat > /etc/systemd/network/20-eth0.network <<EOF
[Match]
Name=eth0

[Network]
Address=${DEBUG_SSH_GUEST_IP_CIDR}
LinkLocalAddressing=no
IPv6AcceptRA=no
EOF

  install -d -m 700 -o "${DEBUG_SSH_USER}" -g "${DEBUG_SSH_USER}" "/home/${DEBUG_SSH_USER}/.ssh"
  install -m 600 -o "${DEBUG_SSH_USER}" -g "${DEBUG_SSH_USER}" \
    "${PAYLOAD_DIR}/debug_authorized_keys" \
    "/home/${DEBUG_SSH_USER}/.ssh/authorized_keys"

  cat > /etc/ssh/sshd_config.d/50-codex-debug.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers ${DEBUG_SSH_USER}
EOF
else
  install -m 644 "${PAYLOAD_DIR}/20-eth0.network" /etc/systemd/network/20-eth0.network
fi

systemctl enable systemd-networkd.service
systemctl enable systemd-resolved.service || true
systemctl enable serial-getty@ttyS0.service
systemctl enable codex-proxy.service
if [[ "$VM_PROFILE" == "debug-ssh" ]]; then
  systemctl enable ssh.service
fi

apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf /tmp/*
