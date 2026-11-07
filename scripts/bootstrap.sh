#!/usr/bin/env bash
set -uo pipefail

# scripts/bootstrap.sh [--yes] [--no-timers] [--no-linger]
# Guided, re-runnable setup: requirements, dirs, stack, user timers, linger.
# Prints why before each step and asks y/N (default no). --yes accepts all.
# No terminal and no --yes counts as no. EDGEKIT_ASSUME_TTY=1 forces prompting from stdin (tests).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YES=0; NO_TIMERS=0; NO_LINGER=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;; --no-timers) NO_TIMERS=1 ;; --no-linger) NO_LINGER=1 ;;
    *) echo "usage: bootstrap.sh [--yes] [--no-timers] [--no-linger]" >&2; exit 2 ;;
  esac
done

SUMMARY=()
say() { echo "$*"; }
ask() {
  local ans
  if [ "$YES" = 1 ]; then echo "$1 [y/N] y (--yes)"; return 0; fi
  if [ ! -t 0 ] && [ "${EDGEKIT_ASSUME_TTY:-}" != 1 ]; then
    echo "$1 [y/N] no terminal and no --yes: treating as no"; return 1
  fi
  read -r -p "$1 [y/N] " ans || ans=""
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# a. requirements
say "== Requirements: the stack and scripts need docker compose v2, flock, jq, curl and node 24+."
missing=()
docker compose version >/dev/null 2>&1 || missing+=("docker compose v2")
for t in flock jq curl; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
nodev="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "${nodev:-0}" -ge 24 ] 2>/dev/null || missing+=("node 24+")
if [ "${#missing[@]}" -gt 0 ]; then
  say "Missing: ${missing[*]}"; exit 1
fi
say "ok"

# b. dirs and stack
LOGROOT="${EDGEKIT_LOG_DIR:-$ROOT/logs}"
say "== Directories: Traefik writes access logs under $LOGROOT/traefik and edgectl keeps state in EDGEKIT_STATE_DIR / EDGEKIT_DYNAMIC_DIR when set."
if ask "Create them?"; then
  mkdir -p "$LOGROOT/traefik"
  [ -n "${EDGEKIT_STATE_DIR:-}" ] && mkdir -p "$EDGEKIT_STATE_DIR"
  if [ -n "${EDGEKIT_DYNAMIC_DIR:-}" ]; then
    mkdir -p "$EDGEKIT_DYNAMIC_DIR"
    [ -e "$EDGEKIT_DYNAMIC_DIR/security.yml" ] || cp "$ROOT/dynamic/security.yml" "$EDGEKIT_DYNAMIC_DIR/security.yml" 2>/dev/null || true
  fi
  SUMMARY+=("directories ready")
else SUMMARY+=("directories skipped"); fi

CONTAINER="${EDGEKIT_TRAEFIK_CONTAINER:-edgekit-traefik-1}"
state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)"
state="${state%% *}"
say "== Stack: starts Traefik (and cloudflared when TUNNEL_TOKEN is set) with docker compose."
if [ "$state" = running ]; then
  say "already running; skipping"; SUMMARY+=("stack already running")
elif ask "Run docker compose up -d?"; then
  args=(compose)
  [ -n "${TUNNEL_TOKEN:-}" ] && args+=(--profile tunnel)
  args+=(up -d)
  if (cd "$ROOT" && docker "${args[@]}" >/dev/null 2>&1); then SUMMARY+=("stack started")
  else say "docker compose up failed"; SUMMARY+=("stack start FAILED"); fi
else SUMMARY+=("stack not started"); fi

# c-f. timers
UNITS=(edgekit-check edgekit-traefik-guard)
UDIR="$HOME/.config/systemd/user"
shopt -u patsub_replacement 2>/dev/null || true

render() { local c; c="$(<"$1")"; printf '%s\n' "${c//__EDGEKIT_ROOT__/$ROOT}"; }

no_timers_note() {
  say "Without the timers nothing restarts traefik or warns you if it dies; sites stay down until you notice."
}

say "== Timers: edgekit-check reports route targets that drift (report only). edgekit-traefik-guard runs every 2 minutes and restarts traefik only after an unexpected exit (a deliberate stop is left alone), and can alert via EDGEKIT_ALERT_CMD."
have_systemd=1
{ [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; } || have_systemd=0

if [ "$NO_TIMERS" = 1 ]; then
  say "skipped (--no-timers)"; no_timers_note; SUMMARY+=("timers skipped")
elif [ "$have_systemd" = 0 ]; then
  say "No systemd user session here (macOS or a container). Not a failure. Alternatives:"
  say "  cron:   */2 * * * * $ROOT/scripts/traefik-guard.sh >> $LOGROOT/guard.log 2>&1"
  say "  manual: run $ROOT/scripts/traefik-guard.sh whenever you want a check"
  SUMMARY+=("no systemd: use cron or manual guard")
elif ask "Install and enable the two user timers?"; then
  mkdir -p "$UDIR"
  changed=0
  for u in "${UNITS[@]}"; do
    for ext in service timer; do
      tmp="$(mktemp)"; render "$ROOT/scripts/$u.$ext" > "$tmp"
      # Never overwrite a unit the operator customised (their env and paths would be lost).
      if [ ! -e "$UDIR/$u.$ext" ]; then cp "$tmp" "$UDIR/$u.$ext"; changed=1
      elif ! cmp -s "$tmp" "$UDIR/$u.$ext"; then
        say "kept your $u.$ext: it differs from the kit's version ($ROOT/scripts/$u.$ext). Compare them if you want the kit's changes."
      fi
      rm -f "$tmp"
    done
  done
  [ "$changed" = 1 ] && systemctl --user daemon-reload
  for u in "${UNITS[@]}"; do
    if [ "$changed" = 1 ] || ! systemctl --user is-enabled "$u.timer" >/dev/null 2>&1; then
      systemctl --user enable --now "$u.timer" >/dev/null 2>&1 || say "could not enable $u.timer"
      say "enabled $u.timer"
    else say "$u.timer already enabled"; fi
  done
  SUMMARY+=("timers installed")

  # d. linger
  if [ "$NO_LINGER" = 1 ]; then SUMMARY+=("linger skipped (--no-linger)")
  else
    user="${USER:-$(id -un)}"
    linger="$(loginctl show-user "$user" -p Linger 2>/dev/null || true)"
    if [ "$linger" = "Linger=yes" ]; then say "linger already enabled"; SUMMARY+=("linger already on")
    else
      say "== Linger: needs sudo, this is the one password prompt. Without it the timers only run while $user is logged in, so after a reboot sites could stay down until you log in."
      if ask "Run sudo loginctl enable-linger $user?"; then
        if sudo loginctl enable-linger "$user"; then SUMMARY+=("linger enabled"); else SUMMARY+=("linger FAILED"); fi
      else SUMMARY+=("linger not enabled: timers need a login after reboot"); fi
    fi
  fi
else
  say "Timers declined."; no_timers_note; SUMMARY+=("timers declined")
fi

say "== Summary"
for s in "${SUMMARY[@]}"; do say "  - $s"; done
say "Undo: systemctl --user disable --now edgekit-check.timer edgekit-traefik-guard.timer"
exit 0
