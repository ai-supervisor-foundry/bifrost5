#!/usr/bin/env bash
set -uo pipefail

# scripts/e2e-local.sh
# End-to-end definition-of-done proof for bin/edgectl, run in temp dirs with EDGEKIT_ENABLED=1.
# Prints PASS or FAIL per step and exits 1 if any step fails.
#
# Local flow (default, no flag): register -> served through Traefik on
# 127.0.0.1:18080 -> a private route is refused without a token -> unregister.
# Everything here runs against local temp dirs and throwaway Docker
# containers; nothing talks to Cloudflare.
#
# --live: additionally starts the real `cloudflared` tunnel profile
# (compose.yml) against Cloudflare, for a throwaway public hostname you have
# already wired up in your own Cloudflare account. Requires TUNNEL_TOKEN.
# Never run with --live in CI or without a disposable tunnel/hostname.

LIVE=0
for arg in "$@"; do
  case "${arg}" in
    --live)
      LIVE=1
      ;;
    -h|--help)
      echo "Usage: $0 [--live]"
      echo "  (no flag)  local-only dry run: register, serve check, private refusal, unregister"
      echo "  --live     also start the cloudflared tunnel profile against Cloudflare (needs TUNNEL_TOKEN)"
      exit 0
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      echo "Usage: $0 [--live]" >&2
      exit 2
      ;;
  esac
done

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

BACKEND_NAME=""
TRAEFIK_NAME=""
cleanup() {
  [ -n "${TRAEFIK_NAME}" ] && docker rm -f "${TRAEFIK_NAME}" >/dev/null 2>&1
  [ -n "${BACKEND_NAME}" ] && docker rm -f "${BACKEND_NAME}" >/dev/null 2>&1
  rm -rf "${TMP_BASE}"
}
trap cleanup EXIT

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

# Steps 10-12: register -> served through Traefik on 127.0.0.1:18080 -> a
# private route is refused without a token -> unregister. Uses throwaway
# Docker containers on the default bridge network; no Cloudflare involved.
if ! command -v docker >/dev/null 2>&1; then
  fail_step "docker is required for the Traefik-serving check but is not on PATH"
elif ! docker info >/dev/null 2>&1; then
  fail_step "docker daemon is not reachable (docker info failed)"
else
  RUN_ID="$$-$(date +%s)-${RANDOM}"
  BACKEND_NAME="edgekit-e2e-be-${RUN_ID}"
  TRAEFIK_NAME="edgekit-e2e-tk-${RUN_ID}"
  MARKER="edgekit-e2e-backend-ok"

  TMP_STATE2="${TMP_BASE}/state2"
  TMP_DYNAMIC2="${TMP_BASE}/dynamic2"
  TMP_POLICY2="${TMP_BASE}/policy2.json"
  mkdir -p "${TMP_STATE2}" "${TMP_DYNAMIC2}"
  cp "${REPO_ROOT}/dynamic/security.yml" "${TMP_DYNAMIC2}/security.yml"

  edgectl2() {
    EDGEKIT_STATE_DIR="${TMP_STATE2}" \
    EDGEKIT_DYNAMIC_DIR="${TMP_DYNAMIC2}" \
    EDGEKIT_POLICY="${TMP_POLICY2}" \
    EDGEKIT_ENABLED=1 \
      "${EDGECTL}" "$@"
  }

  if ! docker run -d --name "${BACKEND_NAME}" nginx:1.29.4-alpine >/dev/null 2>&1; then
    fail_step "could not start throwaway backend container"
  else
    docker exec "${BACKEND_NAME}" sh -c "echo ${MARKER} > /usr/share/nginx/html/index.html" >/dev/null 2>&1
    BACKEND_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${BACKEND_NAME}" 2>/dev/null)"

    if [ -z "${BACKEND_IP}" ]; then
      fail_step "could not resolve bridge IP for throwaway backend container"
    else
      PREFIX="${BACKEND_IP%.*}"
      CIDR="${PREFIX}.0/24"
      cat > "${TMP_POLICY2}" <<EOF
{
  "reservedOwners": ["apps", "admin", "api", "control", "connect"],
  "allowedHosts": ["sites.example.com"],
  "ownerCidrs": { "alice": ["${CIDR}"] },
  "publicOwners": ["alice"]
}
EOF

      # Step 10: register a public throwaway route and confirm Traefik serves it on 127.0.0.1:18080
      if ! edgectl2 register --owner alice --name e2epub --host sites.example.com \
        --target "http://${BACKEND_IP}:80" --access public >/dev/null 2>&1; then
        fail_step "register alice--e2epub failed"
      elif ! edgectl2 register --owner alice --name e2epriv --host sites.example.com \
        --target "http://${BACKEND_IP}:80" >/dev/null 2>&1; then
        fail_step "register alice--e2epriv failed"
      elif ! docker run -d --name "${TRAEFIK_NAME}" \
        -v "${TMP_DYNAMIC2}:/etc/traefik/dynamic:ro" \
        -p 127.0.0.1:18080:80 \
        traefik:v3.7.13 \
        --providers.file.directory=/etc/traefik/dynamic \
        --providers.file.watch=true \
        --entrypoints.web.address=:80 >/dev/null 2>&1; then
        fail_step "could not start throwaway Traefik container bound to 127.0.0.1:18080"
      else
        BODY="${TMP_BASE}/body"
        HEADERS="${TMP_BASE}/headers"

        READY=false
        DEADLINE=$((SECONDS + 30))
        while [ "${SECONDS}" -lt "${DEADLINE}" ]; do
          STATUS="$(curl -s --max-time 3 -o "${BODY}" -w '%{http_code}' \
            -H 'Host: sites.example.com' "http://127.0.0.1:18080/p/alice--e2epub/" 2>/dev/null || true)"
          if [ "${STATUS}" = "200" ] && grep -q "${MARKER}" "${BODY}" 2>/dev/null; then
            READY=true
            break
          fi
          sleep 1
        done

        if [ "${READY}" = "true" ]; then
          pass_step "public route alice--e2epub is served through Traefik on 127.0.0.1:18080"
        else
          fail_step "public route alice--e2epub did not become reachable on 127.0.0.1:18080 within 30s (status=${STATUS:-none})"
        fi

        # Step 11: a private route is refused without a token (edgekit-access-jwt@file
        # forwards to the Access verifier; without a reachable verifier the chain fails closed).
        PRIV_STATUS="$(curl -s --max-time 5 -D "${HEADERS}" -o "${BODY}" -w '%{http_code}' \
          -H 'Host: sites.example.com' "http://127.0.0.1:18080/p/alice--e2epriv/" 2>/dev/null || true)"
        if [ "${PRIV_STATUS}" != "200" ] && [ "${PRIV_STATUS}" != "404" ] && ! grep -q "${MARKER}" "${BODY}" 2>/dev/null; then
          pass_step "private route alice--e2epriv is refused without a token (status=${PRIV_STATUS})"
        else
          fail_step "private route alice--e2epriv was not refused (status=${PRIV_STATUS})"
        fi

        docker rm -f "${TRAEFIK_NAME}" >/dev/null 2>&1
        TRAEFIK_NAME=""
      fi

      # Step 12: unregister both throwaway routes
      if edgectl2 unregister alice--e2epub >/dev/null 2>&1 && edgectl2 unregister alice--e2epriv >/dev/null 2>&1 \
        && [ ! -f "${TMP_DYNAMIC2}/alice--e2epub.yml" ] && [ ! -f "${TMP_DYNAMIC2}/alice--e2epriv.yml" ]; then
        pass_step "unregister removes both throwaway routes"
      else
        fail_step "unregister did not remove both throwaway routes"
      fi
    fi

    docker rm -f "${BACKEND_NAME}" >/dev/null 2>&1
    BACKEND_NAME=""
  fi
fi

# Live Cloudflare step: off by default. Only runs the real cloudflared tunnel
# profile (and therefore talks to Cloudflare) when --live is passed.
if [ "${LIVE}" -eq 1 ]; then
  if [ -z "${TUNNEL_TOKEN:-}" ]; then
    fail_step "live: TUNNEL_TOKEN must be set to start the cloudflared tunnel profile"
  elif (cd "${REPO_ROOT}" && docker compose --profile tunnel up -d cloudflared >/dev/null 2>&1); then
    pass_step "live: cloudflared tunnel profile started against Cloudflare for your throwaway hostname"
    (cd "${REPO_ROOT}" && docker compose stop cloudflared >/dev/null 2>&1)
  else
    fail_step "live: docker compose --profile tunnel up -d cloudflared failed"
  fi
else
  echo "DRY-RUN: skipping cloudflared tunnel profile (pass --live with TUNNEL_TOKEN set to run it for real)"
fi

if [ "${FAILED}" -ne 0 ]; then
  echo "E2E local tests FAILED."
  exit 1
fi

echo "All E2E local tests PASSED."
exit 0
