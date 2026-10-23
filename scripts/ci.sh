#!/usr/bin/env bash
set -euo pipefail

# scripts/ci.sh
# Local CI gate: runs unit, standalone, security audit, shell, e2e and docker integration checks in order.
# Stops on the first failure and prints the last lines of that step's output.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

LOG_FILE="$(mktemp -t edgekit-ci-XXXXXX.log)"
# The log is removed on success and kept on failure so it can be inspected.
CI_OK=0
cleanup() {
  if [ "${CI_OK}" -eq 1 ]; then
    rm -f "${LOG_FILE}"
  fi
}
trap cleanup EXIT

run_step() {
  local name="$1"
  shift
  echo "== ${name}"
  if ! "$@" >"${LOG_FILE}" 2>&1; then
    echo "FAIL: step \"${name}\" failed. Last 5 lines of output:"
    tail -n 5 "${LOG_FILE}"
    echo "Full log kept at: ${LOG_FILE}"
    exit 1
  fi
}

for tool in jq curl; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "ERROR: ${tool} is required by the integration tests but is not on PATH." >&2
    CI_OK=1
    exit 1
  fi
done

run_step "npm test" npm test
run_step "check-standalone" ./scripts/check-standalone.sh
run_step "check-standalone tests" bash tests/scripts/check-standalone.test.sh
run_step "security-audit" ./scripts/security-audit.sh
run_step "ops tests" bash tests/scripts/ops.test.sh
run_step "rotate-traefik-logs tests" bash tests/scripts/rotate-traefik-logs.test.sh
run_step "e2e-local" ./scripts/e2e-local.sh

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not on PATH; the traefik integration steps require docker." >&2
  CI_OK=1
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker is installed but the daemon is not reachable (docker info failed). Start docker or fix permissions." >&2
  CI_OK=1
  exit 1
fi
run_step "traefik integration" ./tests/integration/traefik.sh
run_step "traefik request-path" ./tests/integration/traefik-request.sh
run_step "alias integration" ./tests/integration/alias.sh

CI_OK=1
echo "CI gate passed."
