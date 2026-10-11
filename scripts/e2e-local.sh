#!/usr/bin/env bash
set -uo pipefail

# scripts/e2e-local.sh
# End-to-end definition-of-done proof for bin/edgectl, run in temp dirs with EDGEKIT_ENABLED=1.
# Prints PASS or FAIL per step and exits 1 if any step fails.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EDGECTL="${REPO_ROOT}/bin/edgectl"

FAILED=0

pass_step() {
  echo "PASS: $1"
}

fail_step() {
  echo "FAIL: $1"
  FAILED=1
}

TMP_BASE="$(mktemp -d -t edgekit-e2e-XXXXXX)"
TMP_STATE="${TMP_BASE}/state"
TMP_DYNAMIC="${TMP_BASE}/dynamic"
TMP_POLICY="${TMP_BASE}/policy.json"
mkdir -p "${TMP_STATE}" "${TMP_DYNAMIC}"
trap 'rm -rf "${TMP_BASE}"' EXIT

cat > "${TMP_POLICY}" <<'EOF'
{
  "reservedOwners": ["foundry*", "apps", "admin", "api", "control", "connect"],
  "allowedHosts": ["sites.example.com"],
  "ownerCidrs": {
    "alice": ["10.20.0.0/16"],
    "bob": ["10.30.0.0/16"]
  },
  "publicOwners": ["bob"]
}
EOF

export EDGEKIT_STATE_DIR="${TMP_STATE}"
export EDGEKIT_DYNAMIC_DIR="${TMP_DYNAMIC}"
export EDGEKIT_POLICY="${TMP_POLICY}"
export EDGEKIT_ENABLED=1

# A refused register exits non-zero with a validation message and writes no file.
expect_refused() {
  local label="$1"
  local file_id="$2"
  shift 2
  local err=""
  local code=0
  err="$("${EDGECTL}" register "$@" 2>&1 >/dev/null)" || code=$?
  if [ "${code}" -eq 0 ]; then
    fail_step "${label}: register succeeded but expected refusal"
  elif [ -f "${TMP_DYNAMIC}/${file_id}.yml" ]; then
    fail_step "${label}: refused but created ${file_id}.yml"
  elif [[ "${err}" != *"Validation failed"* ]]; then
    fail_step "${label}: exit ${code} without a validation message: ${err}"
  else
    pass_step "${label} refused (non-zero, validation message, no file)"
  fi
}

# Step 1
if "${EDGECTL}" register --owner alice --name blog --host sites.example.com --target http://10.20.0.5:3000 >/dev/null 2>&1; then
  YML_FILE="${TMP_DYNAMIC}/alice--blog.yml"
  if [ -f "${YML_FILE}" ]; then
    FIRST_MW="$(grep -m 1 '^[[:space:]]*-[[:space:]]*' "${YML_FILE}" | sed -E 's/^[[:space:]]*-[[:space:]]*//' | tr -d '\r')"
    if [ "${FIRST_MW}" = "edgekit-security@file" ]; then
      pass_step "register alice--blog succeeds and dynamic/alice--blog.yml exists with edgekit-security@file first"
    else
      fail_step "dynamic/alice--blog.yml does not have edgekit-security@file as first middleware (got: ${FIRST_MW})"
    fi
  else
    fail_step "dynamic/alice--blog.yml was not created"
  fi
else
  fail_step "register alice--blog failed"
fi

# Step 2
expect_refused "owner 'foundry'" "foundry--app" \
  --owner foundry --name app --host sites.example.com --target http://10.20.0.5:3000

# Step 3
expect_refused "hyphenated owner 'alice-bob'" "alice-bob--blog" \
  --owner alice-bob --name blog --host sites.example.com --target http://10.20.0.5:3000

# Step 4
expect_refused "DNS-name target" "alice--dnstest" \
  --owner alice --name dnstest --host sites.example.com --target http://backend.internal:3000

# Step 5
expect_refused "target outside owner CIDR" "alice--cidrtest" \
  --owner alice --name cidrtest --host sites.example.com --target http://10.99.0.5:3000

# Step 6
CODE_6=0
env -u EDGEKIT_ENABLED "${EDGECTL}" register --owner alice --name unsettest --host sites.example.com --target http://10.20.0.5:3000 >/dev/null 2>&1 || CODE_6=$?
if [ "${CODE_6}" -ne 3 ]; then
  fail_step "with EDGEKIT_ENABLED unset expected exit 3, got ${CODE_6}"
elif [ -f "${TMP_DYNAMIC}/alice--unsettest.yml" ]; then
  fail_step "with EDGEKIT_ENABLED unset a register still created a file"
else
  pass_step "with EDGEKIT_ENABLED unset a register is refused with exit 3"
fi

# Step 7
if "${EDGECTL}" unregister alice--blog >/dev/null 2>&1; then
  if [ ! -f "${TMP_DYNAMIC}/alice--blog.yml" ]; then
    pass_step "unregister removes the file"
  else
    fail_step "unregister exited 0 but file still exists"
  fi
else
  fail_step "unregister alice--blog failed"
fi

# Step 8
CODE_8=0
"${EDGECTL}" unregister alice--blog >/dev/null 2>&1 || CODE_8=$?
if [ "${CODE_8}" -eq 0 ]; then
  pass_step "a second unregister still exits 0"
else
  fail_step "second unregister exited with ${CODE_8}, expected 0"
fi

# Step 9
printf '# managed-by: edgekit\nplanted orphan\n' > "${TMP_DYNAMIC}/orphan--stale.yml"
CODE_9=0
"${EDGECTL}" reconcile >/dev/null 2>&1 || CODE_9=$?
if [ "${CODE_9}" -ne 0 ]; then
  fail_step "reconcile exited with ${CODE_9}, expected 0"
elif [ -f "${TMP_DYNAMIC}/orphan--stale.yml" ]; then
  fail_step "reconcile did not remove planted orphan yml"
else
  pass_step "reconcile removes a planted orphan yml"
fi

if [ "${FAILED}" -ne 0 ]; then
  echo "E2E local tests FAILED."
  exit 1
fi

echo "All E2E local tests PASSED."
exit 0
