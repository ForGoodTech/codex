FROM node:24-bookworm

ARG TZ
ENV TZ="$TZ"
ARG PLAYWRIGHT_MCP_PACKAGE="@playwright/mcp"
ARG PLAYWRIGHT_MCP_VERSION="latest"
ARG CHROME_MCP_PACKAGE="chrome-devtools-mcp"
ARG CHROME_MCP_VERSION="latest"
ARG PLAYWRIGHT_BROWSER_SOURCE="auto"
ARG PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC="1800"
ARG PLAYWRIGHT_MCP_EXECUTABLE_PATH="/opt/google/chrome/chrome"
ARG GITHUB_MCP_URL="https://api.githubcopilot.com/mcp/"
ARG OPENAI_DOCS_MCP_URL="https://developers.openai.com/mcp"
ARG PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC="30"
ARG CHROME_MCP_STARTUP_TIMEOUT_SEC="30"
ARG INSTALL_RPICAM_PACKAGES="auto"
ARG RASPBERRY_PI_APT_SUITE="bookworm"
ENV PLAYWRIGHT_MCP_PACKAGE="${PLAYWRIGHT_MCP_PACKAGE}"
ENV PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION}"
ENV CHROME_MCP_PACKAGE="${CHROME_MCP_PACKAGE}"
ENV CHROME_MCP_VERSION="${CHROME_MCP_VERSION}"
ENV PLAYWRIGHT_BROWSER_SOURCE="${PLAYWRIGHT_BROWSER_SOURCE}"
ENV PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC="${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}"
ENV PLAYWRIGHT_MCP_EXECUTABLE_PATH="${PLAYWRIGHT_MCP_EXECUTABLE_PATH}"
ENV GITHUB_MCP_URL="${GITHUB_MCP_URL}"
ENV OPENAI_DOCS_MCP_URL="${OPENAI_DOCS_MCP_URL}"
ENV PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC="${PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC}"
ENV CHROME_MCP_STARTUP_TIMEOUT_SEC="${CHROME_MCP_STARTUP_TIMEOUT_SEC}"
ENV PLAYWRIGHT_BROWSERS_PATH="/home/node/.cache/ms-playwright"

# Install basic development tools, ca-certificates, and iptables/ipset, then clean up apt cache to reduce image size
RUN apt-get update && apt-get install -y --no-install-recommends \
  aggregate \
  ca-certificates \
  curl \
  dbus-x11 \
  fonts-liberation \
  chromium \
  dnsutils \
  ffmpeg \
  fzf \
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
  libgtk-3-0 \
  libgbm1 \
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
  unzip \
  util-linux \
  v4l-utils \
  ripgrep \
  xvfb \
  xauth \
  zsh \
  && if [ -x /usr/bin/chromium ]; then \
       mkdir -p /opt/google/chrome; \
       printf '%s\n' '#!/bin/sh' 'if command -v xvfb-run >/dev/null 2>&1; then' '  exec xvfb-run -a --server-args="-screen 0 1280x720x24 -nolisten tcp" /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@" --headless=new' 'fi' 'exec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@" --headless=new' > /opt/google/chrome/chrome; \
       chmod 755 /opt/google/chrome/chrome; \
     fi \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    install_rpicam="0"; \
    case "${INSTALL_RPICAM_PACKAGES}" in \
      auto) \
        case "$arch" in \
          arm64|armhf) install_rpicam="1" ;; \
        esac; \
        ;; \
      1|true|yes) install_rpicam="1" ;; \
      0|false|no) install_rpicam="0" ;; \
      *) echo "Unsupported INSTALL_RPICAM_PACKAGES=${INSTALL_RPICAM_PACKAGES}" >&2; exit 1 ;; \
    esac; \
    if [ "$install_rpicam" = "1" ]; then \
      mkdir -p /usr/share/keyrings; \
      curl -fsSL https://archive.raspberrypi.com/debian/raspberrypi.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/raspberrypi-archive-keyring.gpg; \
      echo "deb [arch=${arch} signed-by=/usr/share/keyrings/raspberrypi-archive-keyring.gpg] http://archive.raspberrypi.com/debian ${RASPBERRY_PI_APT_SUITE} main" \
        > /etc/apt/sources.list.d/raspberrypi.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends rpicam-apps-core rpicam-apps-encoder; \
      rm -rf /var/lib/apt/lists/*; \
    else \
      echo "Skipping Raspberry Pi camera packages for architecture ${arch}."; \
    fi

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Install codex
COPY codex-cli/dist/codex.tgz codex.tgz
RUN npm install -g codex.tgz \
  && INSTALL_ROOT="/usr/local/share/npm-global/lib/node_modules/@openai/codex" \
  && if [ -d "${INSTALL_ROOT}/vendor" ]; then \
       find "${INSTALL_ROOT}/vendor" -maxdepth 3 -type f \( -path '*/codex/codex' -o -path '*/codex-app-server/codex-app-server' -o -path '*/codex-linux-sandbox/codex-linux-sandbox' -o -path '*/path/rg' \) -exec chmod 755 {} +; \
       chown -R node:node "${INSTALL_ROOT}/vendor"; \
       APP_SERVER_BIN=$(find "${INSTALL_ROOT}/vendor" -maxdepth 3 -type f -name codex-app-server | head -n 1); \
       if [ -n "$APP_SERVER_BIN" ]; then \
         ln -sf "$APP_SERVER_BIN" /usr/local/share/npm-global/bin/codex-app-server; \
       fi; \
       LINUX_SANDBOX_BIN=$(find "${INSTALL_ROOT}/vendor" -maxdepth 3 -type f -name codex-linux-sandbox | head -n 1); \
       if [ -n "$LINUX_SANDBOX_BIN" ]; then \
         ln -sf "$LINUX_SANDBOX_BIN" /usr/local/share/npm-global/bin/codex-linux-sandbox; \
       fi; \
     fi \
  && npm cache clean --force \
  && rm -rf /usr/local/share/npm-global/lib/node_modules/codex-cli/node_modules/.cache \
  && rm -rf /usr/local/share/npm-global/lib/node_modules/codex-cli/tests \
  && rm -rf /usr/local/share/npm-global/lib/node_modules/codex-cli/docs

RUN set -eux; \
    case "${PLAYWRIGHT_BROWSER_SOURCE}" in \
      auto|playwright|system) ;; \
      *) echo "Unsupported PLAYWRIGHT_BROWSER_SOURCE=${PLAYWRIGHT_BROWSER_SOURCE}; expected auto, playwright, or system" >&2; exit 1 ;; \
    esac; \
    case "${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}" in \
      ''|*[!0-9]*) echo "PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC must be a positive integer number of seconds" >&2; exit 1 ;; \
      0) echo "PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC must be greater than zero" >&2; exit 1 ;; \
    esac; \
    for spec in \
      "Playwright|${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}|${PLAYWRIGHT_MCP_PACKAGE}" \
      "Chrome DevTools|${CHROME_MCP_PACKAGE}@${CHROME_MCP_VERSION}|${CHROME_MCP_PACKAGE}"; do \
      label=${spec%%|*}; \
      rest=${spec#*|}; \
      package_spec=${rest%%|*}; \
      package_name=${rest#*|}; \
      echo "Installing ${label} MCP package (${package_spec})"; \
      npm install -g "$package_spec"; \
      if [ ! -d "$(npm root -g)/${package_name}" ]; then \
        echo "Expected MCP package ${package_name} not found after install" >&2; \
        exit 1; \
      fi; \
      echo "Installed ${label} MCP package (${package_spec})"; \
    done; \
    mkdir -p /home/node/.codex "${PLAYWRIGHT_BROWSERS_PATH}"; \
    printf '%s\n' "${PLAYWRIGHT_BROWSER_SOURCE}" > /home/node/.codex/playwright-browser-source-requested; \
    selected_browser_source="system"; \
    if [ "${PLAYWRIGHT_BROWSER_SOURCE}" = "system" ]; then \
      echo "Using system Chromium for Playwright MCP at ${PLAYWRIGHT_MCP_EXECUTABLE_PATH}"; \
      test -x "${PLAYWRIGHT_MCP_EXECUTABLE_PATH}"; \
    else \
      rm -rf "${PLAYWRIGHT_BROWSERS_PATH}/__dirlock"; \
      echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Trying Playwright-managed Chromium install with ${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}s timeout"; \
      echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Running: timeout --kill-after=30s ${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}s npx -y ${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION} install-browser chromium chromium-headless-shell"; \
      if timeout --kill-after=30s "${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}s" npx -y "${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}" install-browser chromium chromium-headless-shell; then \
        selected_browser_source="playwright"; \
        printf '%s\n' "0" > /home/node/.codex/playwright-browser-install-status; \
        echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Using Playwright-managed Chromium for Playwright MCP"; \
      else \
        install_status=$?; \
        printf '%s\n' "${install_status}" > /home/node/.codex/playwright-browser-install-status; \
        if [ "${PLAYWRIGHT_BROWSER_SOURCE}" = "playwright" ]; then \
          echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Playwright-managed Chromium install exited with status ${install_status} after at most ${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}s, and PLAYWRIGHT_BROWSER_SOURCE=playwright requires it." >&2; \
          exit "${install_status}"; \
        fi; \
        rm -rf "${PLAYWRIGHT_BROWSERS_PATH}"; \
        mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}"; \
        echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] WARNING: Playwright-managed Chromium install exited with status ${install_status} after at most ${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}s; falling back to system Chromium at ${PLAYWRIGHT_MCP_EXECUTABLE_PATH}." >&2; \
        echo "After the image builds, check browser downloads with:" >&2; \
        echo "  docker run --rm <image-tag> bash -lc 'timeout --kill-after=30s ${PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_SEC}s npx -y ${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION} install-browser chromium chromium-headless-shell'" >&2; \
        test -x "${PLAYWRIGHT_MCP_EXECUTABLE_PATH}"; \
      fi; \
    fi; \
    printf '%s\n' "${selected_browser_source}" > /home/node/.codex/playwright-browser-source

# Make the TCP proxy available inside the image and accessible from the default home directory.
COPY --chown=node:node ext/docker/pi-camera/app-server-proxy.js /home/node/app-server-proxy.js
COPY --chown=node:node ext/docker/pi-camera/sdk-proxy.js /home/node/sdk-proxy.js
COPY --chown=node:node ext/docker/pi-camera/camera-smoke-test.sh /home/node/camera-smoke-test.sh
COPY --chown=node:node ext/docker/pi-camera/camera-rtp-stream.sh /home/node/camera-rtp-stream.sh
RUN chmod 755 /home/node/app-server-proxy.js /home/node/sdk-proxy.js /home/node/camera-smoke-test.sh /home/node/camera-rtp-stream.sh && \
  ln -sf /home/node/app-server-proxy.js /usr/local/share/npm-global/bin/codex-app-server-proxy && \
  ln -sf /home/node/sdk-proxy.js /usr/local/share/npm-global/bin/codex-sdk-proxy && \
  ln -sf /home/node/camera-smoke-test.sh /usr/local/share/npm-global/bin/codex-camera-smoke-test && \
  ln -sf /home/node/camera-rtp-stream.sh /usr/local/share/npm-global/bin/codex-camera-rtp-stream && \
  mkdir -p /home/node/.codex && \
  mkdir -p /home/node/node_modules/@openai/codex-sdk

# Stage the Codex TypeScript SDK output alongside the proxies so sdk-proxy can import it.
COPY --chown=node:node sdk/typescript/package.json /home/node/node_modules/@openai/codex-sdk/package.json
COPY --chown=node:node sdk/typescript/dist /home/node/node_modules/@openai/codex-sdk/dist
COPY --chown=node:node codex-cli/vendor /home/node/node_modules/@openai/codex-sdk/vendor

# Inside the container we consider the environment already sufficiently locked
# down, therefore instruct Codex CLI to allow running without sandboxing.
ENV CODEX_UNSAFE_ALLOW_NO_SANDBOX=1

# Copy and set up firewall script as root.
USER root
COPY codex-cli/scripts/init_firewall.sh /usr/local/bin/
RUN chmod 500 /usr/local/bin/init_firewall.sh

# Drop back to non-root.
USER node

# Default workspace under the user's home directory so it can be bind-mounted easily.
WORKDIR /home/node/workdir
RUN mkdir -p /home/node/workdir /home/node/.codex && \
  selected_browser_source=$(cat /home/node/.codex/playwright-browser-source) && \
  case "$selected_browser_source" in \
    playwright) playwright_args="args = [\"-y\", \"${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}\", \"--browser\", \"chromium\"]" ;; \
    system) playwright_args="args = [\"-y\", \"${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}\", \"--browser\", \"chromium\", \"--executable-path\", \"${PLAYWRIGHT_MCP_EXECUTABLE_PATH}\"]" ;; \
    *) echo "Unsupported Playwright browser source: $selected_browser_source" >&2; exit 1 ;; \
  esac && \
  cat <<EOF > /home/node/.codex/config.toml
sandbox_mode = "danger-full-access"

[mcp_servers.openai_docs]
url = "${OPENAI_DOCS_MCP_URL}"

[mcp_servers.playwright]
command = "npx"
${playwright_args}
startup_timeout_sec = ${PLAYWRIGHT_MCP_STARTUP_TIMEOUT_SEC}

[mcp_servers.chrome_devtools]
command = "npx"
args = ["-y", "${CHROME_MCP_PACKAGE}@${CHROME_MCP_VERSION}"]
startup_timeout_sec = ${CHROME_MCP_STARTUP_TIMEOUT_SEC}

[mcp_servers.github]
url = "${GITHUB_MCP_URL}"

EOF

# Start as root only long enough to create container-local device nodes for
# host devices that are root-only, then drop back to node before running Codex.
USER root
COPY ext/docker/pi-camera/camera-device-setup.sh /usr/local/bin/codex-camera-device-setup
COPY ext/docker/pi-camera/camera-entrypoint.sh /usr/local/bin/codex-camera-entrypoint
RUN chmod 755 /usr/local/bin/codex-camera-device-setup /usr/local/bin/codex-camera-entrypoint
ENV HOME=/home/node
ENV USER=node
ENV LOGNAME=node
ENTRYPOINT ["codex-camera-entrypoint"]
