#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
WEBDEV="$SCRIPT_DIR/bin/webdev"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-web-webdev-test.XXXXXX")
cleanup() {
  if [[ -s "$TEST_ROOT/nginx.pid" ]]; then
    kill "$(cat "$TEST_ROOT/nginx.pid")" >/dev/null 2>&1 || true
  fi
  if [[ -s "$TEST_ROOT/php-fpm.pid" ]]; then
    kill "$(cat "$TEST_ROOT/php-fpm.pid")" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

WORKSPACE="$TEST_ROOT/workspace"
STATE="$TEST_ROOT/state"
BIN="$TEST_ROOT/bin"
LOG="$TEST_ROOT/commands.log"
mkdir -p "$WORKSPACE/src" "$WORKSPACE/backend" "$STATE" "$BIN"
printf '%s\n' '{"scripts":{"dev":"vite","build":"vite build"}}' >"$WORKSPACE/package.json"
printf '%s\n' '<!doctype html><main>source</main>' >"$WORKSPACE/index.html"
printf '%s\n' '<?php' >"$WORKSPACE/backend/api.php"
printf '%s\n' '{
  "defaults": {"cert": {"fullchain": "/workspace/certs/missing.pem", "key": "/workspace/certs/missing.key"}},
  "sites": [{
    "name": "app.local.test",
    "host": "app.local.test",
    "root": "/workspace",
    "vitePort": 5173,
    "mode": "vite-php",
    "releaseDir": "/workspace/release/app",
    "releaseInclude": ["backend/"]
  }]
}' >"$WORKSPACE/sites.json"

cat >"$BIN/npm" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'npm cwd=%s args=%s\n' "$PWD" "$*" >>"$WEBDEV_TEST_LOG"
out_dir=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--outDir" ]]; then
    out_dir=$2
    break
  fi
  shift
done
if [[ -n "$out_dir" ]]; then
  mkdir -p "$out_dir/assets"
  printf '%s\n' '<!doctype html><main>built</main>' >"$out_dir/index.html"
  printf '%s\n' 'built' >"$out_dir/assets/app.js"
fi
SH

cat >"$BIN/rsync" <<'SH'
#!/usr/bin/env bash
set -eu
arguments=("$@")
argument_count=${#arguments[@]}
source_path=${arguments[$((argument_count - 2))]}
destination=${arguments[$((argument_count - 1))]}
cp -a "$source_path" "$destination"
SH

cat >"$BIN/nginx" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'nginx %s\n' "$*" >>"$WEBDEV_TEST_LOG"
exit 0
SH

chmod 755 "$BIN/npm" "$BIN/rsync" "$BIN/nginx"

export PATH="$BIN:$PATH"
export WEBDEV_TEST_LOG="$LOG"
export WEBDEV_WORKSPACE="$WORKSPACE"
export WEBDEV_CONFIG="$WORKSPACE/sites.json"
export WEBDEV_DECLARED_WORKSPACE=/workspace
export WEBDEV_STATE_DIR="$STATE"
export WEBDEV_HTTP_PORT=8080
export WEBDEV_HTTPS_PORT=8443
export WEBDEV_ALLOW_SELF_SIGNED=1

"$WEBDEV" nginx-config
grep -Fq "root $WORKSPACE;" "$STATE/nginx/sites.conf"
grep -Fq "proxy_pass http://127.0.0.1:5173;" "$STATE/nginx/sites.conf"
grep -Fq "listen 8080;" "$STATE/nginx/sites.conf"
grep -Fq "listen 8443 ssl http2;" "$STATE/nginx/sites.conf"
grep -Fq "fastcgi_pass unix:$STATE/php-fpm.sock;" "$STATE/nginx/sites.conf"

"$WEBDEV" init-site second.local.test
[[ "$(jq -r 'first(.sites[] | select(.host == "second.local.test")).root' "$WORKSPACE/sites.json")" == "/workspace/sites/second.local.test" ]]
[[ -s "$WORKSPACE/sites/second.local.test/index.html" ]]

"$WEBDEV" dev app.local.test
grep -Fq "npm cwd=$WORKSPACE args=run dev -- --host 0.0.0.0 --port 5173" "$LOG"

"$WEBDEV" package-release app.local.test
[[ -s "$WORKSPACE/release/app/index.php" ]]
[[ -s "$WORKSPACE/release/app/assets/app.js" ]]
[[ -s "$WORKSPACE/release/app/backend/api.php" ]]

sleep 60 &
nginx_pid=$!
printf '%s\n' "$nginx_pid" >"$STATE/nginx.pid"
sleep 60 &
php_pid=$!
printf '%s\n' "$php_pid" >"$STATE/php-fpm.pid"
"$WEBDEV" reload
"$WEBDEV" status | grep -Fq 'Nginx: running (HTTP 8080, HTTPS 8443)'
grep -Fq 'nginx -p /etc/nginx' "$LOG"
"$WEBDEV" stop

echo "Pi Web webdev path and service checks passed"
