#!/usr/bin/env bash
set -euo pipefail

# scripts/port-check.sh
# Lists listening TCP sockets (ss -ltnH) and published container ports
# (docker ps --format), and exits 1 if any kit port is bound to 0.0.0.0,
# [::] or * (all interfaces). Prints at most 10 lines.
# EDGEKIT_PORTS (default 18080,18081) names the kit ports to check.
# Also prints one advisory line on whether `ufw status` shows a DENY rule
# for those ports. ufw is advisory only: if it needs root and is
# unreadable, prints "ufw: unknown" and never fails. Never calls sudo.

IFS=',' read -r -a KIT_PORTS <<< "${EDGEKIT_PORTS:-18080,18081}"

MAX_LINES=10
LINES_PRINTED=0
EXIT_CODE=0

print_line() {
  if [ "$LINES_PRINTED" -lt "$MAX_LINES" ]; then
    echo "$1"
    LINES_PRINTED=$((LINES_PRINTED + 1))
  fi
}

is_kit_port() {
  local port="$1" p
  for p in "${KIT_PORTS[@]}"; do
    if [ "$p" = "$port" ]; then
      return 0
    fi
  done
  return 1
}

is_any_interface() {
  case "$1" in
    "0.0.0.0" | "::" | "*") return 0 ;;
    *) return 1 ;;
  esac
}

# Splits "addr:port" (IPv6 bracketed as "[addr]:port") into PARSED_ADDR/PARSED_PORT.
parse_addr_port() {
  local field="$1"
  if [[ "$field" =~ ^\[(.*)\]:([0-9]+)$ ]]; then
    PARSED_ADDR="${BASH_REMATCH[1]}"
    PARSED_PORT="${BASH_REMATCH[2]}"
  elif [[ "$field" =~ ^(.*):([0-9]+)$ ]]; then
    PARSED_ADDR="${BASH_REMATCH[1]}"
    PARSED_PORT="${BASH_REMATCH[2]}"
  else
    PARSED_ADDR=""
    PARSED_PORT=""
  fi
}

# 1. Listening TCP sockets
if command -v ss >/dev/null 2>&1; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    local_field="$(awk '{print $4}' <<< "$line")"
    parse_addr_port "$local_field"
    [ -n "$PARSED_PORT" ] || continue
    if is_kit_port "$PARSED_PORT"; then
      if is_any_interface "$PARSED_ADDR"; then
        print_line "FAIL ss: port ${PARSED_PORT} bound to ${PARSED_ADDR} (all interfaces)"
        EXIT_CODE=1
      else
        print_line "ok ss: port ${PARSED_PORT} bound to ${PARSED_ADDR}"
      fi
    fi
  done < <(ss -ltnH 2>/dev/null || true)
else
  print_line "ss: not found"
fi

# 2. Published container ports
if command -v docker >/dev/null 2>&1; then
  while IFS= read -r ports_field; do
    [ -n "$ports_field" ] || continue
    IFS=',' read -r -a mappings <<< "$ports_field"
    for mapping in "${mappings[@]}"; do
      mapping="${mapping#"${mapping%%[![:space:]]*}"}"
      [[ "$mapping" == *"->"* ]] || continue
      host_field="${mapping%%->*}"
      parse_addr_port "$host_field"
      [ -n "$PARSED_PORT" ] || continue
      if is_kit_port "$PARSED_PORT"; then
        if is_any_interface "$PARSED_ADDR"; then
          print_line "FAIL docker: port ${PARSED_PORT} bound to ${PARSED_ADDR} (all interfaces)"
          EXIT_CODE=1
        else
          print_line "ok docker: port ${PARSED_PORT} bound to ${PARSED_ADDR}"
        fi
      fi
    done
  done < <(docker ps --format '{{.Ports}}' 2>/dev/null || true)
else
  print_line "docker: not found"
fi

# 3. ufw (advisory only; never sudo, never fails the gate)
if command -v ufw >/dev/null 2>&1; then
  if ufw_output="$(ufw status 2>&1)"; then
    deny_found=0
    for p in "${KIT_PORTS[@]}"; do
      if grep -E -q "^${p}(/tcp)?[[:space:]]+DENY" <<< "$ufw_output"; then
        deny_found=1
      fi
    done
    if [ "$deny_found" -eq 1 ]; then
      print_line "ufw: DENY rule present for kit ports"
    else
      print_line "ufw: no DENY rule for kit ports"
    fi
  else
    print_line "ufw: unknown"
  fi
else
  print_line "ufw: unknown"
fi

exit "$EXIT_CODE"
