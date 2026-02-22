FROM node:24-bookworm

ARG TZ
ENV TZ="$TZ"
ARG PLAYWRIGHT_MCP_PACKAGE="@playwright/mcp"
ARG PLAYWRIGHT_MCP_VERSION="latest"
ARG CHROME_MCP_PACKAGE="chrome-devtools-mcp"
ARG CHROME_MCP_VERSION="latest"
ARG GITHUB_MCP_PACKAGE="@modelcontextprotocol/server-github"
ARG GITHUB_MCP_VERSION="latest"
ARG OPENAI_DOCS_MCP_URL="https://developers.openai.com/mcp"

# Install basic development tools, ca-certificates, and iptables/ipset, then clean up apt cache to reduce image size
RUN apt-get update && apt-get install -y --no-install-recommends \
  aggregate \
  ca-certificates \
  curl \
  dnsutils \
  fzf \
  git \
  gnupg2 \
  iproute2 \
  ipset \
  iptables \
  iputils-ping \
  jq \
  less \
  libssl3 \
  man-db \
  procps \
  unzip \
  ripgrep \
  zsh \
  && rm -rf /var/lib/apt/lists/*

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
       chmod 755 "${INSTALL_ROOT}"/vendor/*/codex/codex "${INSTALL_ROOT}"/vendor/*/codex-app-server/codex-app-server "${INSTALL_ROOT}"/vendor/*/codex-linux-sandbox/codex-linux-sandbox "${INSTALL_ROOT}"/vendor/*/path/rg; \
       chown -R node:node "${INSTALL_ROOT}/vendor"; \
       APP_SERVER_BIN=$(find "${INSTALL_ROOT}/vendor" -maxdepth 3 -type f -name codex-app-server -perm -111 | head -n 1); \
       if [ -n "$APP_SERVER_BIN" ]; then \
         ln -sf "$APP_SERVER_BIN" /usr/local/share/npm-global/bin/codex-app-server; \
       fi; \
       LINUX_SANDBOX_BIN=$(find "${INSTALL_ROOT}/vendor" -maxdepth 3 -type f -name codex-linux-sandbox -perm -111 | head -n 1); \
       if [ -n "$LINUX_SANDBOX_BIN" ]; then \
         ln -sf "$LINUX_SANDBOX_BIN" /usr/local/share/npm-global/bin/codex-linux-sandbox; \
       fi; \
     fi \
  && npm cache clean --force \
  && rm -rf /usr/local/share/npm-global/lib/node_modules/codex-cli/node_modules/.cache \
  && rm -rf /usr/local/share/npm-global/lib/node_modules/codex-cli/tests \
  && rm -rf /usr/local/share/npm-global/lib/node_modules/codex-cli/docs

RUN set -eux; \
    for spec in \
      "Playwright|${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}|${PLAYWRIGHT_MCP_PACKAGE}" \
      "Chrome DevTools|${CHROME_MCP_PACKAGE}@${CHROME_MCP_VERSION}|${CHROME_MCP_PACKAGE}" \
      "GitHub|${GITHUB_MCP_PACKAGE}@${GITHUB_MCP_VERSION}|${GITHUB_MCP_PACKAGE}"; do \
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
    done

# Make the TCP proxy available inside the image and accessible from the default home directory.
COPY --chown=node:node ext/docker/pi/app-server-proxy.js /home/node/app-server-proxy.js
COPY --chown=node:node ext/docker/pi/sdk-proxy.js /home/node/sdk-proxy.js
RUN ln -sf /home/node/app-server-proxy.js /usr/local/share/npm-global/bin/codex-app-server-proxy && \
  ln -sf /home/node/sdk-proxy.js /usr/local/share/npm-global/bin/codex-sdk-proxy && \
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
RUN mkdir -p /home/node/workdir && \
  cat <<EOF > /home/node/.codex/config.toml
sandbox_mode = "danger-full-access"

[mcp_servers.openai_docs]
url = "${OPENAI_DOCS_MCP_URL}"

[mcp_servers.playwright]
command = "npx"
args = ["-y", "${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}"]

[mcp_servers.chrome_devtools]
command = "npx"
args = ["-y", "${CHROME_MCP_PACKAGE}@${CHROME_MCP_VERSION}"]

[mcp_servers.github]
command = "npx"
args = ["-y", "${GITHUB_MCP_PACKAGE}@${GITHUB_MCP_VERSION}"]
bearer_token_env_var = "CODEX_GITHUB_PERSONAL_ACCESS_TOKEN"
EOF
