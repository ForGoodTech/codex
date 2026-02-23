#!/bin/bash
set -euo pipefail

CONFIG_DIR=/home/node/.codex
CONFIG_FILE="$CONFIG_DIR/config.toml"

mkdir -p "$CONFIG_DIR"
touch "$CONFIG_FILE"

if ! rg -q '^\[mcp_servers\.openai_docs\]' "$CONFIG_FILE"; then
  cat >> "$CONFIG_FILE" <<CONFIG_EOF

[mcp_servers.openai_docs]
url = "${OPENAI_DOCS_MCP_URL}"
CONFIG_EOF
fi

if ! rg -q '^\[mcp_servers\.playwright\]' "$CONFIG_FILE"; then
  cat >> "$CONFIG_FILE" <<CONFIG_EOF

[mcp_servers.playwright]
command = "npx"
args = ["-y", "${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}"]
CONFIG_EOF
fi

if ! rg -q '^\[mcp_servers\.chrome_devtools\]' "$CONFIG_FILE"; then
  cat >> "$CONFIG_FILE" <<CONFIG_EOF

[mcp_servers.chrome_devtools]
command = "npx"
args = ["-y", "${CHROME_MCP_PACKAGE}@${CHROME_MCP_VERSION}"]
CONFIG_EOF
fi

if ! rg -q '^\[mcp_servers\.github\]' "$CONFIG_FILE"; then
  cat >> "$CONFIG_FILE" <<CONFIG_EOF

[mcp_servers.github]
command = "npx"
args = ["-y", "${GITHUB_MCP_PACKAGE}@${GITHUB_MCP_VERSION}"]
bearer_token_env_var = "CODEX_GITHUB_PERSONAL_ACCESS_TOKEN"
CONFIG_EOF
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
