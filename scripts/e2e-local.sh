#!/usr/bin/env bash
set -uo pipefail

# scripts/e2e-local.sh
# End-to-end definition of done proof script using temp dirs and EDGEKIT_ENABLED=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EDGECTL="${REPO_ROOT}/bin/edgectl"

FAILED=0

pass_step() {
  local msg="$1"
  echo "PASS: ${msg}"
}

fail_step() {
  local msg="$1"
  echo "FAIL: ${msg}"
  FAILED=1
}

# Create temp directories
TMP_BASE="$(mktemp -d -t edgekit-e2e-XXXXXX)"
TMP_STATE="${TMP_BASE}/state"
TMP_DYNAMIC="${TMP_BASE}/dynamic"
TMP_POLICY="${TMP_BASE}/policy.json"

mkdir -p "${TMP_STATE}" "${TMP_DYNAMIC}"

cleanup() {
  rm -rf "${TMP_BASE}"
}
trap cleanup EXIT

# Setup sample policy
cat <<'EOF' > "${TMP_POLICY}"
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

# Common env vars
export EDGEKIT_STATE_DIR="${TMP_STATE}"
export EDGEKIT_DYNAMIC_DIR="${TMP_DYNAMIC}"
export EDGEKIT_POLICY="${TMP_POLICY}"
export EDGEKIT_ENABLED=1

# Step 1: register alice--blog succeeds and <dynamic>/alice--blog.yml exists with edgekit-security@file first
if "${EDGECTL}" register --owner alice --name blog --host sites.example.com --target http://10.20.0.5:3000 >/dev/null 2>&1; then
  YML_FILE="${TMP_DYNAMIC}/alice--blog.yml"
  if [ -f "${YML_FILE}" ]; then
    # Verify edgekit-security@file is the first middleware
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

# Step 2: registering owner 'foundry' refused (non-zero, no file)
OUT_2="$("${EDGECTL}" register --owner foundry --name app --host sites.example.com --target http://10.20.0.5:3000 2>&1 || true)"
EXIT_2=$?
if "${EDGECTL}" register --owner foundry --name app --host sites.example.com --target http://10.20.0.5:3000 >/dev/null 2>&1; then
  fail_step "registering owner 'foundry' succeeded but expected refusal"
else
  if [ -f "${TMP_DYNAMIC}/foundry--app.yml" ]; then
    fail_step "registering owner 'foundry' created file ${TMP_DYNAMIC}/foundry--app.yml"
  else
    pass_step "registering owner 'foundry' refused (non-zero, no file)"
  fi
fi

# Step 3: registering a hyphenated owner 'alice-bob' refused
if "${EDGECTL}" register --owner alice-bob --name blog --host sites.example.com --target http://10.20.0.5:3000 >/dev/null 2>&1; then
  fail_step "registering hyphenated owner 'alice-bob' succeeded but expected refusal"
else
  if [ -f "${TMP_DYNAMIC}/alice-bob--blog.yml" ]; then
    fail_step "registering hyphenated owner 'alice-bob' created file"
  else
    pass_step "registering hyphenated owner 'alice-bob' refused"
  fi
fi

# Step 4: registering a DNS-name target refused
if "${EDGECTL}" register --owner alice --name dnstest --host sites.example.com --target http://backend.internal:3000 >/dev/null 2>&1; then
  fail_step "registering DNS-name target succeeded but expected refusal"
else
  if [ -f "${TMP_DYNAMIC}/alice--dnstest.yml" ]; then
    fail_step "registering DNS-name target created file"
  else
    pass_step "registering a DNS-name target refused"
  fi
fi

# Step 5: registering a target outside the owner CIDR refused
if "${EDGECTL}" register --owner alice --name cidrtest --host sites.example.com --target http://10.99.0.5:3000 >/dev/null 2>&1; then
  fail_step "registering target outside owner CIDR succeeded but expected refusal"
else
  if [ -f "${TMP_DYNAMIC}/alice--cidrtest.yml" ]; then
    fail_step "registering target outside owner CIDR created file"
  else
    pass_step "registering a target outside the owner CIDR refused"
  fi
fi

# Step 6: with EDGEKIT_ENABLED unset a register is refused with exit 3
CODE_6=0
(unset EDGEKIT_ENABLED && "${EDGECTL}" register --owner alice --name unsettest --host sites.example.com --target http://10.20.0.5:3000 >/dev/null 2>&1) || CODE_6=$?
if [ "${CODE_6}" -eq 3 ]; then
  pass_step "with EDGEKIT_ENABLED unset a register is refused with exit 3"
else
  fail_step "with EDGEKIT_ENABLED unset expected exit 3, got ${CODE_6}"
fi

# Step 7: unregister removes the file
if "${EDGECTL}" unregister alice--blog >/dev/null 2>&1; then
  if [ ! -f "${TMP_DYNAMIC}/alice--blog.yml" ]; then
    pass_step "unregister removes the file"
  else
    fail_step "unregister exited 0 but file still exists"
  fi
else
  fail_step "unregister alice--blog failed"
fi

# Step 8: a second unregister still exits 0
CODE_8=0
"${EDGECTL}" unregister alice--blog >/dev/null 2>&1 || CODE_8=$?
if [ "${CODE_8}" -eq 0 ]; then
  pass_step "a second unregister still exits 0"
else
  fail_step "second unregister exited with ${CODE_8}, expected 0"
fi

# Step 9: reconcile removes a planted orphan yml
echo "planted orphan" > "${TMP_DYNAMIC}/orphan--stale.yml"
if [ -f "${TMP_DYNAMIC}/orphan--stale.yml" ]; then
  "${EDGECTL}" reconcile >/dev/null 2>&1 || true
  if [ ! -f "${TMP_DYNAMIC}/orphan--stale.yml" ]; then
    pass_step "reconcile removes a planted orphan yml"
  else
    fail_step "reconcile did not remove planted orphan yml"
  fi
else
  fail_step "failed to plant orphan yml"
fi

# Exit non-zero on any FAIL
if [ "${FAILED}" -ne 0 ]; then
  echo "E2E local tests FAILED."
  exit 1
fi

echo "All E2E local tests PASSED."
exit 0
