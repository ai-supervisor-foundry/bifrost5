#!/usr/bin/env bash
set -euo pipefail

# Create temp state and dynamic dirs with mktemp -d
TMP_STATE="$(mktemp -d)"
TMP_DYN="$(mktemp -d)"
CONTAINER_NAME="edgekit-it-$$"

# Trap on EXIT to ensure throwaway container and temp dirs are always cleaned up
cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  rm -rf "${TMP_STATE}" "${TMP_DYN}"
}
trap cleanup EXIT

# Copy dynamic/security.yml into the temp dynamic dir
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cp "${REPO_ROOT}/dynamic/security.yml" "${TMP_DYN}/"

# Write a temp policy JSON allowing host sites.example.com and owner alice CIDR 10.20.0.0/24
TMP_POLICY="${TMP_STATE}/policy.json"
cat <<'EOF' > "${TMP_POLICY}"
{
  "reservedOwners": ["foundry*", "apps", "admin", "api", "control", "connect"],
  "allowedHosts": ["sites.example.com"],
  "ownerCidrs": {
    "alice": ["10.20.0.0/24"]
  }
}
EOF

# Run EDGEKIT_ENABLED=1 bin/edgectl register --owner alice --name blog --host sites.example.com --target http://10.20.0.5:3000
EDGEKIT_STATE_DIR="${TMP_STATE}" \
EDGEKIT_DYNAMIC_DIR="${TMP_DYN}" \
EDGEKIT_POLICY="${TMP_POLICY}" \
EDGEKIT_ENABLED=1 \
"${REPO_ROOT}/bin/edgectl" register \
  --owner alice \
  --name blog \
  --host sites.example.com \
  --target http://10.20.0.5:3000 >/dev/null

# Start a THROWAWAY container
docker run -d \
  --name "${CONTAINER_NAME}" \
  -v "${TMP_DYN}:/dynamic:ro" \
  -p 127.0.0.1::8080 \
  traefik:v3.7.13 \
  --providers.file.directory=/dynamic \
  --providers.file.watch=true \
  --api.insecure=true \
  --entrypoints.web.address=:80 \
  --entrypoints.traefik.address=:8080 >/dev/null

# Resolve the mapped port with docker port
HOST_PORT="$(docker port "${CONTAINER_NAME}" 8080 | head -n1 | sed -E 's/.*:([0-9]+)$/\1/')"

if [ -z "${HOST_PORT}" ]; then
  echo "Failed to resolve mapped port for container ${CONTAINER_NAME}" >&2
  exit 1
fi

# Poll http://127.0.0.1:<port>/api/http/routers up to 30 s until a router named alice--blog@file appears
# and check its rule contains PathPrefix and /p/alice--blog
FOUND=false
DEADLINE=$((SECONDS + 30))

while [ "${SECONDS}" -lt "${DEADLINE}" ]; do
  ROUTERS_JSON="$(curl -s --max-time 2 "http://127.0.0.1:${HOST_PORT}/api/http/routers" 2>/dev/null || true)"
  if [ -n "${ROUTERS_JSON}" ] && echo "${ROUTERS_JSON}" | jq -e '. | type == "array"' >/dev/null 2>&1; then
    ROUTER="$(echo "${ROUTERS_JSON}" | jq -c '.[] | select(.name == "alice--blog@file")' 2>/dev/null || true)"
    if [ -n "${ROUTER}" ]; then
      RULE="$(echo "${ROUTER}" | jq -r '.rule // empty')"
      STATUS_FIELD="$(echo "${ROUTER}" | jq -r '.status // empty')"
      if [[ "${RULE}" == *"PathPrefix"* ]] && [[ "${RULE}" == *"/p/alice--blog"* ]] && [ "${STATUS_FIELD}" = "enabled" ]; then
        FOUND=true
        break
      fi
    fi
  fi
  sleep 1
done

if [ "${FOUND}" != "true" ]; then
  echo "Router alice--blog@file was not found enabled with required rule within 30s" >&2
  exit 1
fi

# Then ALSO drop a malformed file broken.yml into the dynamic dir, wait 5 s,
# and print whether router alice--blog@file is still listed - print a line BAD_FILE_BEHAVIOUR: router_still_listed=<true|false>
echo "invalid: yaml: [unbalanced: {{{" > "${TMP_DYN}/broken.yml"
sleep 5

STILL_LISTED=false
ROUTERS_AFTER="$(curl -s --max-time 2 "http://127.0.0.1:${HOST_PORT}/api/http/routers" 2>/dev/null || true)"
if [ -n "${ROUTERS_AFTER}" ] && echo "${ROUTERS_AFTER}" | jq -e '. | type == "array"' >/dev/null 2>&1; then
  CHECK_ROUTER="$(echo "${ROUTERS_AFTER}" | jq -c '.[] | select(.name == "alice--blog@file")' 2>/dev/null || true)"
  if [ -n "${CHECK_ROUTER}" ]; then
    STILL_LISTED=true
  fi
fi

echo "BAD_FILE_BEHAVIOUR: router_still_listed=${STILL_LISTED}"
# Traefik keeps the last good configuration when a file fails to parse, so the router must remain.
if [ "${STILL_LISTED}" != "true" ]; then
  echo "FAIL: router alice--blog@file disappeared after a malformed file was added" >&2
  exit 1
fi
exit 0
