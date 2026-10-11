#!/usr/bin/env bash
set -euo pipefail

# scripts/rotate_traefik_logs.sh [--force]
# Age-based rotation of the Traefik access log.
# - log:       ${EDGEKIT_LOG_DIR:-<repo>/logs}/traefik/access.log (compose mounts ./logs/traefik)
# - interval:  EDGEKIT_ROTATE_DAYS (default 5); state file <log dir>/traefik/.last_rotation
# - archive:   <log dir>/traefik/archive/<YYYY-MM-DD>/access-<timestamp>.log, then xz -9e or gzip -9
# - retention: after a successful rotation, keeps only the newest 5 archived files
#              across all archive/<date>/ dirs; older ones (and any date dir left
#              empty by that pruning) are deleted
# - signal:    docker kill -s USR1 on EDGEKIT_TRAEFIK_CONTAINER (default edgekit-traefik-1)
# Exits 0 with a message when the log is missing, empty, or rotation is not due.
# Fails closed (exit 1, nothing moved) if docker is missing or errors, or the log dir is not writable.
# If the container is running: mv, USR1, then wait up to EDGEKIT_REOPEN_TIMEOUT (default 10) seconds
# for Traefik to recreate access.log; on failure exit 1, leave the archive uncompressed, no state write.
# If the container is not running there is no writer, so it rotates without a signal.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

LOG_ROOT="${EDGEKIT_LOG_DIR:-${REPO_ROOT}/logs}"
LOG_DIR="${LOG_ROOT}/traefik"
LOG_FILE="${LOG_DIR}/access.log"
STATE_FILE="${LOG_DIR}/.last_rotation"
ARCHIVE_BASE="${LOG_DIR}/archive"
CONTAINER_NAME="${EDGEKIT_TRAEFIK_CONTAINER:-edgekit-traefik-1}"
ROTATION_DAYS="${EDGEKIT_ROTATE_DAYS:-5}"
REOPEN_TIMEOUT="${EDGEKIT_REOPEN_TIMEOUT:-10}"
FORCE=false

if [[ ! "${ROTATION_DAYS}" =~ ^[0-9]+$ ]]; then
  echo "EDGEKIT_ROTATE_DAYS must be a non-negative integer, got: ${ROTATION_DAYS}" >&2
  exit 1
fi
if [[ ! "${REOPEN_TIMEOUT}" =~ ^[0-9]+$ ]]; then
  echo "EDGEKIT_REOPEN_TIMEOUT must be a non-negative integer, got: ${REOPEN_TIMEOUT}" >&2
  exit 1
fi
# Force base 10 so values like 010 are ten, not an octal literal.
ROTATION_INTERVAL_SECS=$((10#${ROTATION_DAYS} * 86400))

[[ "${1:-}" == "--force" ]] && FORCE=true

if [[ -d "${LOG_DIR}" && ! -w "${LOG_DIR}" ]]; then
  echo "Log directory ${LOG_DIR} is not writable; cannot rotate. Fix permissions or set EDGEKIT_LOG_DIR." >&2
  exit 1
fi

if [[ ! -f "${LOG_FILE}" || ! -s "${LOG_FILE}" ]]; then
  echo "Traefik access log empty or not found at ${LOG_FILE}. Nothing to rotate."
  exit 0
fi

NOW=$(date +%s)
if [[ "${FORCE}" != "true" && -f "${STATE_FILE}" ]]; then
  LAST_ROTATION=$(cat "${STATE_FILE}" 2>/dev/null || echo 0)
  [[ "${LAST_ROTATION}" =~ ^[0-9]+$ ]] || LAST_ROTATION=0
  DIFF=$((NOW - 10#${LAST_ROTATION}))
  if (( DIFF < ROTATION_INTERVAL_SECS )); then
    DAYS_LEFT=$(( (ROTATION_INTERVAL_SECS - DIFF) / 86400 ))
    echo "Rotation not due yet. Next rotation in ~${DAYS_LEFT} days. Use --force to override."
    exit 0
  fi
fi

# Fail closed before moving anything: we must know whether a writer is running.
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH; cannot tell whether ${CONTAINER_NAME} is running. Log not rotated." >&2
  exit 1
fi
if ! RUNNING_NAMES="$(docker ps --format '{{.Names}}' 2>/dev/null)"; then
  echo "docker ps failed; cannot tell whether ${CONTAINER_NAME} is running. Log not rotated." >&2
  exit 1
fi
RUNNING=false
if grep -qxF -- "${CONTAINER_NAME}" <<<"${RUNNING_NAMES}"; then
  RUNNING=true
fi

TARGET_DIR="${ARCHIVE_BASE}/$(date +%Y-%m-%d)"
mkdir -p "${TARGET_DIR}"
ARCHIVE_FILE="${TARGET_DIR}/access-$(date +%Y%m%d_%H%M%S).log"

echo "Rotating ${LOG_FILE} -> ${ARCHIVE_FILE}..."
mv "${LOG_FILE}" "${ARCHIVE_FILE}"

if [[ "${RUNNING}" == "true" ]]; then
  echo "Signaling ${CONTAINER_NAME} (USR1) to reopen log files..."
  if ! docker kill -s USR1 "${CONTAINER_NAME}" >/dev/null 2>&1; then
    echo "USR1 to ${CONTAINER_NAME} failed. Archive left uncompressed at ${ARCHIVE_FILE}; state not updated." >&2
    exit 1
  fi
  WAITED=0
  while [[ ! -f "${LOG_FILE}" ]]; do
    if (( WAITED >= REOPEN_TIMEOUT * 2 )); then
      echo "Traefik did not recreate ${LOG_FILE} within ${REOPEN_TIMEOUT}s. Archive left uncompressed at ${ARCHIVE_FILE}; state not updated." >&2
      exit 1
    fi
    sleep 0.5
    WAITED=$((WAITED + 1))
  done
else
  echo "Container ${CONTAINER_NAME} not running; no writer, skipped USR1 signal."
fi

if command -v xz >/dev/null 2>&1; then
  echo "Compressing with xz -9e..."
  xz -9e -f "${ARCHIVE_FILE}"
  ARCHIVE_FILE="${ARCHIVE_FILE}.xz"
elif command -v gzip >/dev/null 2>&1; then
  echo "Compressing with gzip -9..."
  gzip -9 -f "${ARCHIVE_FILE}"
  ARCHIVE_FILE="${ARCHIVE_FILE}.gz"
fi

echo "${NOW}" > "${STATE_FILE}"

# Retention: keep only the newest MAX_ARCHIVES files across all archive/<date>/ dirs.
MAX_ARCHIVES=5
mapfile -t ARCHIVED_FILES < <(find "${ARCHIVE_BASE}" -type f -name 'access-*.log*' 2>/dev/null | LC_ALL=C sort)
ARCHIVE_COUNT=${#ARCHIVED_FILES[@]}
if (( ARCHIVE_COUNT > MAX_ARCHIVES )); then
  PRUNE_COUNT=$((ARCHIVE_COUNT - MAX_ARCHIVES))
  for ((i = 0; i < PRUNE_COUNT; i++)); do
    rm -f "${ARCHIVED_FILES[$i]}"
  done
  find "${ARCHIVE_BASE}" -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true
fi

echo "Rotation complete. Archived log: ${ARCHIVE_FILE}"
