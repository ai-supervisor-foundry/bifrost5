#!/usr/bin/env bash
set -euo pipefail

# tests/scripts/rotate-traefik-logs.test.sh
# Acceptance Criteria:
# - due rotation moves access.log into archive/<today>/ and compresses it; archive decompresses to the original
# - the move happens BEFORE the USR1 signal (shim asserts access.log is absent at kill time)
#   and the shim recreating access.log models Traefik reopening it
# - state file works: an immediate re-run without --force reports "not due" and moves nothing
# - EDGEKIT_ROTATE_DAYS=0 rotates; EDGEKIT_ROTATE_DAYS=010 means ten days, not octal eight
# - missing and empty logs exit 0 and move nothing
# - container not running: rotates without a signal and says so
# - fail closed: docker missing or `docker ps` failing -> exit 1, log not moved
# - running container + failed signal, or access.log never reappearing -> exit 1,
#   archive left uncompressed, no state file
# - docker is stubbed via a PATH shim; no real container is touched

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/rotate_traefik_logs.sh"

if [ ! -x "$SCRIPT" ]; then
  echo "Error: $SCRIPT is not executable or not found." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'chmod -R u+rwx "$TMP_DIR" 2>/dev/null || true; rm -rf "$TMP_DIR"' EXIT

PASSED=0
fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { PASSED=$((PASSED + 1)); echo "PASS"; }

# docker shim.
#   ps   -> prints $FAKE_RUNNING (exit 1 when FAKE_PS_FAIL=1)
#   kill -> fails when FAKE_KILL_FAIL=1; asserts $ACCESS_LOG is ABSENT (mv happened first),
#           records the call, then recreates $ACCESS_LOG unless FAKE_NO_REOPEN=1
SHIM="$TMP_DIR/shim"
mkdir -p "$SHIM"
cat > "$SHIM/docker" <<'SH'
#!/usr/bin/env bash
case "$1" in
  ps)
    [ "${FAKE_PS_FAIL:-}" = "1" ] && exit 1
    [ -n "${FAKE_RUNNING:-}" ] && echo "$FAKE_RUNNING"
    exit 0 ;;
  kill)
    if [ -e "$ACCESS_LOG" ]; then echo "access.log present at kill time" >> "$DOCKER_VIOLATIONS"; fi
    echo "$*" >> "$DOCKER_CALLS"
    [ "${FAKE_KILL_FAIL:-}" = "1" ] && exit 1
    [ "${FAKE_NO_REOPEN:-}" = "1" ] || echo '{"msg":"reopened"}' > "$ACCESS_LOG"
    exit 0 ;;
esac
exit 0
SH
chmod +x "$SHIM/docker"
export PATH="$SHIM:$PATH"
export DOCKER_CALLS="$TMP_DIR/docker_calls"
export DOCKER_VIOLATIONS="$TMP_DIR/docker_violations"

new_env() { # $1 = name; sets LOGROOT, ACCESS_LOG and resets shim records
  LOGROOT="$TMP_DIR/$1"
  mkdir -p "$LOGROOT/traefik"
  export ACCESS_LOG="$LOGROOT/traefik/access.log"
  : > "$DOCKER_CALLS"
  : > "$DOCKER_VIOLATIONS"
}
run() { EDGEKIT_LOG_DIR="$LOGROOT" "$SCRIPT" "$@" 2>&1; }
first_archive() { ls "$LOGROOT"/traefik/archive/*/access-*.log* 2>/dev/null | head -n1; }
read_archive() { # prints decompressed content of $1
  case "$1" in
    *.xz) xz -dc "$1" ;;
    *.gz) gzip -dc "$1" ;;
    *) cat "$1" ;;
  esac
}

echo "=== Testing rotate_traefik_logs.sh ==="

echo "Test 1: running container: mv before USR1, reopen, compress, state, content preserved..."
new_env t1
echo '{"msg":"original-content"}' > "$ACCESS_LOG"
FAKE_RUNNING=edgekit-traefik-1 run --force >/dev/null || fail "T1 exit non-zero"
[ ! -s "$DOCKER_VIOLATIONS" ] || fail "T1 USR1 sent before the log was moved"
grep -q "kill -s USR1 edgekit-traefik-1" "$DOCKER_CALLS" || fail "T1 USR1 not sent"
grep -q "reopened" "$ACCESS_LOG" || fail "T1 access.log not recreated by reopen"
archived="$(first_archive)"
[ -n "$archived" ] || fail "T1 no archive found"
[ "$(dirname "$archived")" = "$LOGROOT/traefik/archive/$(date +%F)" ] || fail "T1 archive not under archive/\$(date +%F): $archived"
case "$archived" in *.xz|*.gz) ;; *) fail "T1 archive not compressed: $archived" ;; esac
read_archive "$archived" | grep -q "original-content" || fail "T1 archive lacks original content"
[ -s "$LOGROOT/traefik/.last_rotation" ] || fail "T1 state file missing"
pass

echo "Test 2: immediate re-run without --force is not due and moves nothing..."
before="$(ls "$LOGROOT"/traefik/archive/*/ | wc -l)"
out="$(FAKE_RUNNING=edgekit-traefik-1 run)" || fail "T2 exit non-zero"
echo "$out" | grep -q "not due" || fail "T2 missing not-due message"
grep -q "reopened" "$ACCESS_LOG" || fail "T2 access.log was moved"
[ "$(ls "$LOGROOT"/traefik/archive/*/ | wc -l)" = "$before" ] || fail "T2 new archive created"
pass

echo "Test 3: EDGEKIT_ROTATE_DAYS=0 rotates even with a fresh state file..."
new_env t3
echo x > "$ACCESS_LOG"
date +%s > "$LOGROOT/traefik/.last_rotation"
EDGEKIT_ROTATE_DAYS=0 FAKE_RUNNING=edgekit-traefik-1 run >/dev/null || fail "T3 exit non-zero"
[ -n "$(first_archive)" ] || fail "T3 not archived"
pass

echo "Test 4: EDGEKIT_ROTATE_DAYS=010 means ten days (not octal eight)..."
new_env t4
echo x > "$ACCESS_LOG"
echo $(( $(date +%s) - 9 * 86400 )) > "$LOGROOT/traefik/.last_rotation"
out="$(EDGEKIT_ROTATE_DAYS=010 FAKE_RUNNING=edgekit-traefik-1 run)" || fail "T4 exit non-zero (010 rejected?)"
echo "$out" | grep -q "not due" || fail "T4 9 days elapsed should not be due for 10 days"
[ -z "$(first_archive)" ] || fail "T4 rotated early (octal parse?)"
pass

echo "Test 5: missing log exits 0..."
new_env t5
out="$(FAKE_RUNNING=edgekit-traefik-1 run --force)" || fail "T5 exit non-zero"
echo "$out" | grep -q "Nothing to rotate" || fail "T5 missing message"
pass

echo "Test 6: empty log exits 0 and is not moved..."
new_env t6
: > "$ACCESS_LOG"
out="$(FAKE_RUNNING=edgekit-traefik-1 run --force)" || fail "T6 exit non-zero"
echo "$out" | grep -q "Nothing to rotate" || fail "T6 missing message"
[ -e "$ACCESS_LOG" ] || fail "T6 empty log removed"
[ ! -d "$LOGROOT/traefik/archive" ] || fail "T6 archive dir created"
pass

echo "Test 7: container not running: rotates, no signal, says so..."
new_env t7
echo '{"msg":"idle-content"}' > "$ACCESS_LOG"
out="$(FAKE_RUNNING=some-other-container run --force)" || fail "T7 exit non-zero"
echo "$out" | grep -q "skipped USR1" || fail "T7 missing skipped message"
[ ! -s "$DOCKER_CALLS" ] || fail "T7 kill was called"
archived="$(first_archive)"
read_archive "$archived" | grep -q "idle-content" || fail "T7 archive lacks content"
[ -s "$LOGROOT/traefik/.last_rotation" ] || fail "T7 state file missing"
pass

echo "Test 8: name match is exact (prefix of a longer name does not count as running)..."
new_env t8
echo x > "$ACCESS_LOG"
out="$(FAKE_RUNNING=edgekit-traefik-10 run --force)" || fail "T8 exit non-zero"
[ ! -s "$DOCKER_CALLS" ] || fail "T8 signaled a different container"
pass

echo "Test 9: EDGEKIT_TRAEFIK_CONTAINER override is signaled..."
new_env t9
echo x > "$ACCESS_LOG"
EDGEKIT_TRAEFIK_CONTAINER=custom-edge FAKE_RUNNING=custom-edge run --force >/dev/null || fail "T9 exit non-zero"
grep -q "kill -s USR1 custom-edge" "$DOCKER_CALLS" || fail "T9 override not signaled"
pass

echo "Test 10: invalid EDGEKIT_ROTATE_DAYS is rejected..."
new_env t10
echo x > "$ACCESS_LOG"
if FAKE_RUNNING=edgekit-traefik-1 EDGEKIT_ROTATE_DAYS=abc run >/dev/null; then fail "T10 accepted invalid days"; fi
[ -s "$ACCESS_LOG" ] || fail "T10 log moved"
pass

echo "Test 11: docker ps fails -> exit 1, log not moved..."
new_env t11
echo keep-me > "$ACCESS_LOG"
if FAKE_PS_FAIL=1 run --force >/dev/null; then fail "T11 exit 0 with failing docker"; fi
grep -q keep-me "$ACCESS_LOG" || fail "T11 log was moved"
[ ! -d "$LOGROOT/traefik/archive" ] || fail "T11 archive dir created"
pass

echo "Test 12: docker missing -> exit 1, log not moved..."
new_env t12
echo keep-me > "$ACCESS_LOG"
NODOCKER="$TMP_DIR/nodocker"
mkdir -p "$NODOCKER"
for c in bash env dirname date mkdir mv cat grep sleep xz gzip; do
  p="$(command -v "$c" || true)"
  [ -n "$p" ] && ln -sf "$p" "$NODOCKER/$c"
done
if PATH="$NODOCKER" EDGEKIT_LOG_DIR="$LOGROOT" "$SCRIPT" --force >/dev/null 2>&1; then fail "T12 exit 0 without docker"; fi
grep -q keep-me "$ACCESS_LOG" || fail "T12 log was moved"
pass

echo "Test 13: running container + USR1 fails -> exit 1, archive uncompressed, no state..."
new_env t13
echo '{"msg":"signal-fail"}' > "$ACCESS_LOG"
if FAKE_RUNNING=edgekit-traefik-1 FAKE_KILL_FAIL=1 run --force >/dev/null; then fail "T13 exit 0 on failed signal"; fi
archived="$(first_archive)"
case "$archived" in *.log) ;; *) fail "T13 archive should be uncompressed: $archived" ;; esac
grep -q "signal-fail" "$archived" || fail "T13 archive lacks content"
[ ! -e "$LOGROOT/traefik/.last_rotation" ] || fail "T13 state file written"
pass

echo "Test 14: access.log never reappears -> exit 1, archive uncompressed, no state..."
new_env t14
echo '{"msg":"no-reopen"}' > "$ACCESS_LOG"
if FAKE_RUNNING=edgekit-traefik-1 FAKE_NO_REOPEN=1 EDGEKIT_REOPEN_TIMEOUT=1 run --force >/dev/null; then fail "T14 exit 0 without reopen"; fi
archived="$(first_archive)"
case "$archived" in *.log) ;; *) fail "T14 archive should be uncompressed: $archived" ;; esac
[ ! -e "$LOGROOT/traefik/.last_rotation" ] || fail "T14 state file written"
pass

echo "Test 15: unwritable log dir -> exit 1 with a clear message..."
new_env t15
echo keep-me > "$ACCESS_LOG"
if [ "$(id -u)" -eq 0 ]; then
  echo "SKIP (running as root)"
else
  chmod 555 "$LOGROOT/traefik"
  if out="$(FAKE_RUNNING=edgekit-traefik-1 run --force)"; then fail "T15 exit 0 on unwritable dir"; fi
  echo "$out" | grep -q "not writable" || fail "T15 missing message"
  chmod 755 "$LOGROOT/traefik"
  grep -q keep-me "$ACCESS_LOG" || fail "T15 log was moved"
  pass
fi

echo "All rotate_traefik_logs tests passed (${PASSED} passed)."
