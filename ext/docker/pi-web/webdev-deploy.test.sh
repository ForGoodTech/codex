#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(realpath "$(dirname "$0")")
DEPLOY="$SCRIPT_DIR/bin/webdev-deploy"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-web-deploy-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT

RELEASE="$TEST_ROOT/release"
BIN="$TEST_ROOT/bin"
LOG="$TEST_ROOT/commands.log"
mkdir -p "$RELEASE/assets" "$BIN"
printf '%s\n' '<?php echo "ok";' >"$RELEASE/index.php"
printf '%s\n' 'asset' >"$RELEASE/assets/app.js"
printf '%s\n' 'private-key-fixture' >"$TEST_ROOT/id"
printf '%s\n' 'production.example.com ssh-ed25519 fixture' >"$TEST_ROOT/known_hosts"
chmod 600 "$TEST_ROOT/id" "$TEST_ROOT/known_hosts"

cat >"$BIN/ssh" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'ssh %s\n' "$*" >>"$WEBDEV_DEPLOY_TEST_LOG"
if [[ "$*" == *"previous=''"* ]]; then
  printf '%s' 'releases/previous'
fi
SH
cat >"$BIN/rsync" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'rsync %s\n' "$*" >>"$WEBDEV_DEPLOY_TEST_LOG"
SH
cat >"$BIN/curl" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'curl %s\n' "$*" >>"$WEBDEV_DEPLOY_TEST_LOG"
[[ "${WEBDEV_DEPLOY_TEST_HEALTH_FAIL:-0}" != "1" ]]
SH
chmod 755 "$BIN/ssh" "$BIN/rsync" "$BIN/curl"

export PATH="$BIN:$PATH"
export WEBDEV_DEPLOY_TEST_LOG="$LOG"
export SURESTINFO_DEPLOY_HOST=production.example.com
export SURESTINFO_DEPLOY_USER=deploy
export SURESTINFO_DEPLOY_PORT=22
export SURESTINFO_DEPLOY_ROOT=/srv/www/application
export SURESTINFO_DEPLOY_IDENTITY_FILE="$TEST_ROOT/id"
export SURESTINFO_DEPLOY_KNOWN_HOSTS_FILE="$TEST_ROOT/known_hosts"
export SURESTINFO_DEPLOY_HEALTH_URL=https://production.example.com/health

SURESTINFO_DEPLOY_DRY_RUN=1 "$DEPLOY" "$RELEASE" | grep -Fq 'dry run target deploy@production.example.com:/srv/www/application'
[[ ! -e "$LOG" ]]

"$DEPLOY" "$RELEASE" | grep -Fq 'deployed release'
grep -Fq 'StrictHostKeyChecking=yes' "$LOG"
grep -Fq 'rsync -az --delete --protect-args' "$LOG"
grep -Fq 'curl --fail --silent --show-error --location' "$LOG"

: >"$LOG"
if WEBDEV_DEPLOY_TEST_HEALTH_FAIL=1 "$DEPLOY" "$RELEASE" >"$TEST_ROOT/failure.out" 2>"$TEST_ROOT/failure.err"; then
  echo "A failed production health check was accepted" >&2
  exit 1
fi
grep -Fq 'health check failed; rolling back' "$TEST_ROOT/failure.err"
grep -Fq '.rollback-' "$LOG"
grep -Fq "releases/previous" "$LOG"

if SURESTINFO_DEPLOY_ROOT=/srv/www/../escape "$DEPLOY" "$RELEASE" >/dev/null 2>"$TEST_ROOT/path.err"; then
  echo "A traversal production root was accepted" >&2
  exit 1
fi
grep -Fq 'normalized absolute path' "$TEST_ROOT/path.err"

if SURESTINFO_DEPLOY_HEALTH_TIMEOUT_SEC=unbounded "$DEPLOY" "$RELEASE" >/dev/null 2>"$TEST_ROOT/timeout.err"; then
  echo "An invalid production health-check timeout was accepted" >&2
  exit 1
fi
grep -Fq 'must be between 1 and 600' "$TEST_ROOT/timeout.err"

ln -s /etc/passwd "$RELEASE/unsafe-link"
if "$DEPLOY" "$RELEASE" >/dev/null 2>"$TEST_ROOT/symlink.err"; then
  echo "A release containing a symbolic link was accepted" >&2
  exit 1
fi
grep -Fq 'symbolic link or special file' "$TEST_ROOT/symlink.err"

echo "Pi Web deployment safety checks passed"
