#!/usr/bin/env bash
set -uo pipefail

# scripts/traefik-guard.sh
# Restarts the Traefik container only after an unexpected exit, and alerts.
# - container: EDGEKIT_TRAEFIK_CONTAINER (default edgekit-traefik-1); docker binary: EDGEKIT_DOCKER
# - running/restarting/paused/created/removing, missing, or exit code 0/137/143 (deliberate stop): no action, exit 0
# - any other exit: docker start; exit 0 on success, 1 on failure; both are logged and alerted
# - EDGEKIT_ALERT_CMD: path to one executable, run with the message as its only argument (no eval).
#   A failing alert is logged and never changes the exit code. Unset: log only.

CONTAINER="${EDGEKIT_TRAEFIK_CONTAINER:-edgekit-traefik-1}"
DOCKER="${EDGEKIT_DOCKER:-docker}"

log() { echo "$(date -u +%FT%TZ) traefik-guard: $*"; }

alert() {
  local msg="$1"
  log "$msg"
  if [ -n "${EDGEKIT_ALERT_CMD:-}" ]; then
    "$EDGEKIT_ALERT_CMD" "$msg" >/dev/null 2>&1 || log "alert command failed (ignored)"
  fi
}

err="$(mktemp)"
trap 'rm -f "$err"' EXIT
if ! info="$("$DOCKER" inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$CONTAINER" 2>"$err")"; then
  if grep -qi "no such" "$err"; then
    log "container $CONTAINER not found; nothing to do"
    exit 0
  fi
  log "cannot inspect $CONTAINER (docker unavailable?)"
  exit 1
fi

status="${info%% *}"
code="${info##* }"

case "$status" in
  running|restarting|paused|created|removing) exit 0 ;;
esac

case "$code" in
  0|137|143) exit 0 ;;
esac

if "$DOCKER" start "$CONTAINER" >/dev/null 2>&1; then
  alert "edge-kit: $CONTAINER exited unexpectedly (status $status, code $code) and was restarted"
  exit 0
fi
alert "edge-kit: $CONTAINER exited unexpectedly (status $status, code $code) and restart FAILED"
exit 1
