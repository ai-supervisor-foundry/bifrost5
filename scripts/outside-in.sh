#!/usr/bin/env bash
set -euo pipefail

# scripts/outside-in.sh <host-or-ip> [allowed-ports]
# Full TCP port scan (nmap -Pn -p- --min-rate 1000) against a target and
# exits 1 if any open port is outside the allowed list (comma-separated,
# default "443"). Exits 2 if nmap is not on PATH. Prints at most 10 lines.
#
# This only means something when run from a network outside the host's
# LAN (a cloud VM, a different ISP connection, a phone on mobile data,
# etc.). Run from inside the same LAN, and router/firewall NAT makes
# everything look closed or everything look open depending on the box,
# which proves nothing about what the public internet can reach.

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <host-or-ip> [allowed-ports]" >&2
  exit 2
fi

TARGET="$1"
ALLOWED_PORTS_RAW="${2:-443}"
IFS=',' read -r -a ALLOWED_PORTS <<< "$ALLOWED_PORTS_RAW"

MAX_LINES=10
LINES_PRINTED=0
EXIT_CODE=0

print_line() {
  if [ "$LINES_PRINTED" -lt "$MAX_LINES" ]; then
    echo "$1"
    LINES_PRINTED=$((LINES_PRINTED + 1))
  fi
}

is_allowed_port() {
  local port="$1" p
  for p in "${ALLOWED_PORTS[@]}"; do
    if [ "$p" = "$port" ]; then
      return 0
    fi
  done
  return 1
}

if ! command -v nmap >/dev/null 2>&1; then
  echo "nmap not found on PATH; install nmap to run this check." >&2
  exit 2
fi

SCAN_OUTPUT="$(nmap -Pn -p- --min-rate 1000 "$TARGET" 2>&1)" || true

while IFS= read -r line; do
  if [[ "$line" =~ ^([0-9]+)/tcp[[:space:]]+open ]]; then
    port="${BASH_REMATCH[1]}"
    if is_allowed_port "$port"; then
      print_line "ok: port ${port} open (allowed)"
    else
      print_line "FAIL: port ${port} open (not in allowed list: ${ALLOWED_PORTS_RAW})"
      EXIT_CODE=1
    fi
  fi
done <<< "$SCAN_OUTPUT"

if [ "$EXIT_CODE" -eq 0 ]; then
  print_line "ok: no open ports outside allowed list (${ALLOWED_PORTS_RAW}) on ${TARGET}"
fi

exit "$EXIT_CODE"
