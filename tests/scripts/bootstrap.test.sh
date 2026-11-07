#!/usr/bin/env bash
set -euo pipefail

# tests/scripts/bootstrap.test.sh
# Acceptance Criteria (docker, systemctl, loginctl, sudo, curl are PATH stubs; HOME is a temp dir):
# - traefik-guard: crash restarts and alerts; exit 0/137/143, running, paused, missing: untouched, exit 0
# - start failure exits 1 and alerts; alert failure never changes the exit code
# - alert command gets the message as ONE argument, no shell evaluation, path with spaces works
# - bootstrap: decline, --yes, no terminal = no, no systemd exits 0, linger yes = no sudo,
#   linger no + yes = sudo, second run changes nothing, units hold the real path, no token in output

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/traefik-guard.sh"
BOOT="$REPO_ROOT/scripts/bootstrap.sh"

PASSED=0
fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { PASSED=$((PASSED + 1)); echo "PASS: $1"; }

[ -x "$GUARD" ] || fail "$GUARD missing or not executable"
[ -x "$BOOT" ] || fail "$BOOT missing or not executable"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SHIM="$TMP/shim"; mkdir -p "$SHIM"
export HOME="$TMP/home"; mkdir -p "$HOME"
export CALLS="$TMP/calls"; : > "$CALLS"
export FAKE_ENABLED_DIR="$TMP/enabled"; mkdir -p "$FAKE_ENABLED_DIR"
export EDGEKIT_LOG_DIR="$TMP/logs"
unset EDGEKIT_ALERT_CMD TUNNEL_TOKEN EDGEKIT_STATE_DIR EDGEKIT_DYNAMIC_DIR || true

cat > "$SHIM/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >> "$CALLS"
case "$1" in
  compose) [ "${2:-}" = "version" ] && echo "Docker Compose version v2.20.0"; exit 0 ;;
  inspect|container)
    if [ "${FAKE_MISSING:-}" = "1" ]; then echo "Error: No such object: x" >&2; exit 1; fi
    echo "${FAKE_STATUS:-running} ${FAKE_EXIT:-0}"; exit 0 ;;
  start) [ "${FAKE_START_FAIL:-}" = "1" ] && exit 1; exit 0 ;;
esac
exit 0
SH
cat > "$SHIM/systemctl" <<'SH'
#!/usr/bin/env bash
echo "systemctl $*" >> "$CALLS"
[ "${FAKE_NO_SYSTEMD:-}" = "1" ] && exit 1
case "$2" in
  is-enabled) [ -e "$FAKE_ENABLED_DIR/$3" ]; exit $? ;;
  enable) for u in "${@:3}"; do case "$u" in --now) ;; *) touch "$FAKE_ENABLED_DIR/$u" ;; esac; done ;;
esac
exit 0
SH
cat > "$SHIM/loginctl" <<'SH'
#!/usr/bin/env bash
echo "loginctl $*" >> "$CALLS"
echo "Linger=${FAKE_LINGER:-no}"
SH
cat > "$SHIM/sudo" <<'SH'
#!/usr/bin/env bash
echo "sudo $*" >> "$CALLS"
exit 0
SH
cat > "$SHIM/curl" <<'SH'
#!/usr/bin/env bash
echo "curl $*" >> "$CALLS"
SH
chmod +x "$SHIM"/*
export PATH="$SHIM:$PATH"

# alert command that records argc and each arg
ALERT_DIR="$TMP/alert dir"; mkdir -p "$ALERT_DIR"
ALERT="$ALERT_DIR/my alert.sh"
cat > "$ALERT" <<'SH'
#!/usr/bin/env bash
{ echo "argc=$#"; echo "arg1=$1"; } >> "$ALERT_LOG"
[ "${ALERT_FAIL:-}" = "1" ] && exit 7
exit 0
SH
chmod +x "$ALERT"
export ALERT_LOG="$TMP/alert.log"

guard() { : > "$CALLS"; : > "$ALERT_LOG"; set +e; "$GUARD" >"$TMP/out" 2>&1; RC=$?; set -e; }
calls_have() { grep -q "$1" "$CALLS"; }

# --- guard ---
export EDGEKIT_ALERT_CMD="$ALERT"
FAKE_STATUS=exited FAKE_EXIT=255 guard
[ "$RC" = 0 ] && calls_have "docker start edgekit-traefik-1" || fail "crash should start container"
grep -q "argc=1" "$ALERT_LOG" || fail "crash should alert with one arg"
pass "crash restarts and alerts"

for code in 0 137 143; do
  FAKE_STATUS=exited FAKE_EXIT=$code guard
  [ "$RC" = 0 ] && ! calls_have "docker start" && [ ! -s "$ALERT_LOG" ] || fail "exit $code should be left alone"
done
pass "deliberate stops untouched"

for st in running restarting paused created removing; do
  FAKE_STATUS=$st FAKE_EXIT=255 guard
  [ "$RC" = 0 ] && ! calls_have "docker start" && [ ! -s "$ALERT_LOG" ] || fail "$st should be left alone"
done
pass "live states untouched"

FAKE_MISSING=1 guard
[ "$RC" = 0 ] && ! calls_have "docker start" && grep -qi "not found\|missing\|does not exist" "$TMP/out" || fail "missing container"
pass "missing container exits 0 and says so"

FAKE_STATUS=exited FAKE_EXIT=1 FAKE_START_FAIL=1 guard
[ "$RC" = 1 ] && grep -q "argc=1" "$ALERT_LOG" || fail "start failure should exit 1 and alert"
pass "start failure exits 1 and alerts"

FAKE_STATUS=exited FAKE_EXIT=1 ALERT_FAIL=1 guard
[ "$RC" = 0 ] || fail "alert failure changed success exit"
FAKE_STATUS=exited FAKE_EXIT=1 FAKE_START_FAIL=1 ALERT_FAIL=1 guard
[ "$RC" = 1 ] || fail "alert failure changed failure exit"
pass "alert failure does not change exit"

# message with spaces and shell metacharacters, command path with spaces: one arg, no eval
FAKE_STATUS=exited FAKE_EXIT=1 guard
[ "$(grep -c '^arg1=' "$ALERT_LOG")" = 1 ] && grep -q "argc=1" "$ALERT_LOG" || fail "single arg"
grep -q '^arg1=.* .*' "$ALERT_LOG" || fail "message should contain spaces"
export EDGEKIT_TRAEFIK_CONTAINER='x;touch pwned'
FAKE_STATUS=exited FAKE_EXIT=1 guard
[ ! -e pwned ] && [ ! -e "$TMP/pwned" ] && grep -q "argc=1" "$ALERT_LOG" || fail "shell evaluation"
unset EDGEKIT_TRAEFIK_CONTAINER
pass "alert message is one argument, no eval"

unset EDGEKIT_ALERT_CMD
FAKE_STATUS=exited FAKE_EXIT=1 guard
[ "$RC" = 0 ] && [ ! -s "$ALERT_LOG" ] && grep -qi "alert" "$TMP/out" || true
[ "$RC" = 0 ] || fail "no alert cmd: log only"
pass "no alert cmd logs only"

# --- bootstrap ---
boot() { : > "$CALLS"; set +e; "$BOOT" "$@" >"$TMP/out" 2>&1 </dev/null; RC=$?; set -e; }
bootin() { local input="$1"; shift; : > "$CALLS"; set +e; printf '%b' "$input" | EDGEKIT_ASSUME_TTY=1 "$BOOT" "$@" >"$TMP/out" 2>&1; RC=$?; set -e; }
UDIR="$HOME/.config/systemd/user"
reset() { rm -rf "$HOME/.config" "$FAKE_ENABLED_DIR"/* "$EDGEKIT_LOG_DIR"; }

reset; FAKE_STATUS=exited bootin 'n\nn\nn\nn\nn\n'
[ "$RC" = 0 ] && [ ! -e "$UDIR/edgekit-traefik-guard.timer" ] && ! calls_have "enable --now" && ! calls_have "compose up" && ! calls_have "sudo" || fail "decline"
grep -qi "nothing restarts traefik" "$TMP/out" || fail "decline should explain loss"
pass "decline changes nothing and explains"

reset; boot
[ "$RC" = 0 ] && ! calls_have "enable --now" && ! calls_have "sudo" && grep -qi "no terminal" "$TMP/out" || fail "no terminal"
pass "no terminal means no"

reset; FAKE_STATUS=exited FAKE_LINGER=no TUNNEL_TOKEN=sekrit-token-value boot --yes
[ "$RC" = 0 ] || { cat "$TMP/out" >&2; fail "--yes rc=$RC"; }
calls_have "compose --profile tunnel up -d\|compose up -d --profile tunnel" || calls_have "profile tunnel" || fail "tunnel profile"
calls_have "enable --now edgekit-check.timer" && calls_have "enable --now edgekit-traefik-guard.timer" || fail "enable"
calls_have "sudo loginctl enable-linger" || fail "linger yes should call sudo"
[ -d "$EDGEKIT_LOG_DIR/traefik" ] || fail "log dir"
grep -q "sekrit-token-value" "$TMP/out" && fail "token printed"
grep -q "disable --now" "$TMP/out" || fail "undo hint"
pass "--yes does everything; token never printed"

for u in edgekit-check.service edgekit-check.timer edgekit-traefik-guard.service edgekit-traefik-guard.timer; do
  [ -f "$UDIR/$u" ] || fail "missing $u"
  grep -q "__" "$UDIR/$u" && fail "placeholder left in $u"
done
grep -q "ExecStart=$REPO_ROOT/scripts/traefik-guard.sh" "$UDIR/edgekit-traefik-guard.service" || fail "guard path"
grep -q "ExecStart=$REPO_ROOT/bin/edgectl check" "$UDIR/edgekit-check.service" || fail "check path"
pass "units hold real path, no placeholder"

# second run: nothing changes
cp -r "$UDIR" "$TMP/units1"
FAKE_STATUS=running FAKE_LINGER=yes boot --yes
[ "$RC" = 0 ] && diff -r "$UDIR" "$TMP/units1" >/dev/null || fail "units changed on rerun"
! calls_have "enable --now" && ! calls_have "compose up" && ! calls_have "sudo" || fail "rerun did duplicate work"
pass "idempotent second run"

# a unit the operator customised is never overwritten
reset; mkdir -p "$UDIR"; printf '[Service]\nEnvironment=CUSTOM=1\n' > "$UDIR/edgekit-check.service"
FAKE_STATUS=running FAKE_LINGER=yes boot --yes
grep -q "CUSTOM=1" "$UDIR/edgekit-check.service" || fail "customised unit was overwritten"
grep -q "kept your edgekit-check.service" "$TMP/out" || fail "should say the customised unit was kept"
[ -f "$UDIR/edgekit-traefik-guard.service" ] && calls_have "enable --now" || fail "guard should still install"
pass "customised unit kept, guard still installed"

reset; FAKE_STATUS=running FAKE_LINGER=yes boot --yes
! calls_have "sudo" && calls_have "enable --now" || fail "linger yes should skip sudo"
pass "linger already yes: no sudo"

reset; FAKE_STATUS=running FAKE_LINGER=no boot --yes --no-linger
! calls_have "sudo" || fail "--no-linger"
reset; FAKE_STATUS=running FAKE_LINGER=no boot --yes --no-timers
! calls_have "enable --now" && [ ! -e "$UDIR" ] && grep -qi "nothing restarts traefik" "$TMP/out" || fail "--no-timers"
pass "--no-linger and --no-timers"

reset; FAKE_STATUS=running FAKE_NO_SYSTEMD=1 boot --yes
[ "$RC" = 0 ] && grep -q "traefik-guard.sh" "$TMP/out" && grep -qi "cron" "$TMP/out" && ! calls_have "sudo" || fail "no systemd"
pass "no systemd exits 0 with alternative"

# missing requirement
set +e; PATH="$SHIM:/nonexistent" /bin/bash "$BOOT" --yes >"$TMP/out" 2>&1 </dev/null; RC=$?; set -e
[ "$RC" != 0 ] || fail "missing requirements should fail"
pass "missing requirements exit non-zero"

echo "All $PASSED groups passed"
