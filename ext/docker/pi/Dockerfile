FROM node:24-bullseye

ARG TZ
ENV TZ="$TZ"

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
  jq \
  less \
  libssl1.1 \
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
       chmod 755 "${INSTALL_ROOT}"/vendor/*/codex/codex "${INSTALL_ROOT}"/vendor/*/codex-app-server/codex-app-server "${INSTALL_ROOT}"/vendor/*/path/rg; \
       chown -R node:node "${INSTALL_ROOT}/vendor"; \
       APP_SERVER_BIN=$(find "${INSTALL_ROOT}/vendor" -maxdepth 3 -type f -name codex-app-server -perm -111 | head -n 1); \
       if [ -n "$APP_SERVER_BIN" ]; then \
         ln -sf "$APP_SERVER_BIN" /usr/local/share/npm-global/bin/codex-app-server; \
       fi; \
     fi \
  && npm cache clean --force \
  && rm -rf /usr/local/share/npm-global/lib/node_modules/codex-cli/node_modules/.cache \
  && rm -rf /usr/local/share/npm-global/lib/node_modules/codex-cli/tests \
  && rm -rf /usr/local/share/npm-global/lib/node_modules/codex-cli/docs

# Make the TCP proxy example available inside the image (mirror host path).
COPY --chown=node:node ext/examples/app-server-proxy.js /ext/examples/app-server-proxy.js
RUN ln -sf /ext/examples/app-server-proxy.js /usr/local/share/npm-global/bin/codex-app-server-proxy

# Inside the container we consider the environment already sufficiently locked
# down, therefore instruct Codex CLI to allow running without sandboxing.
ENV CODEX_UNSAFE_ALLOW_NO_SANDBOX=1

# Copy and set up firewall script as root.
USER root
COPY codex-cli/scripts/init_firewall.sh /usr/local/bin/
RUN chmod 500 /usr/local/bin/init_firewall.sh

# Drop back to non-root.
USER node
