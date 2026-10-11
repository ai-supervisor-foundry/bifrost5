#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER_NAME="edgekit-it-$$"
TMP_STATE=""
TMP_DYN=""

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  [[ -n "${TMP_STATE}" ]] && rm -rf "${TMP_STATE}"
  [[ -n "${TMP_DYN}" ]] && rm -rf "${TMP_DYN}"
  return 0
}
trap cleanup EXIT

TMP_STATE="$(mktemp -d)"
TMP_DYN="$(mktemp -d)"

cp "${REPO_ROOT}/dynamic/security.yml" "${TMP_DYN}/security.yml"

POLICY="${TMP_STATE}/policy.json"
cat > "${POLICY}" <<'EOF'
{
  "reservedOwners": ["ops", "system"],
  "allowedHosts": ["sites.example.com"],
  "ownerCidrs": { "alice": ["10.20.0.0/24"] }
}
EOF

EDGEKIT_STATE_DIR="${TMP_STATE}" \
EDGEKIT_DYNAMIC_DIR="${TMP_DYN}" \
EDGEKIT_POLICY="${POLICY}" \
EDGEKIT_ENABLED=1 \
  "${REPO_ROOT}/bin/edgectl" register \
  --owner alice \
  --name blog \
  --host sites.example.com \
  --target http://10.20.0.5:3000 >/dev/null

docker run -d \
  --name "${CONTAINER_NAME}" \
  -v "${TMP_DYN}:/dynamic:ro" \
  -p 127.0.0.1::8080 \
  traefik:v3 \
  --providers.file.directory=/dynamic \
  --providers.file.watch=true \
  --api.insecure=true \
  --entrypoints.web.address=:80 \
  --entrypoints.traefik.address=:8080 >/dev/null

HOST_PORT="$(docker port "${CONTAINER_NAME}" 8080 | awk -F: 'NR==1 {print $NF}')"
if [[ ! "${HOST_PORT}" =~ ^[0-9]+$ ]]; then
  echo "FAIL: could not resolve mapped port for ${CONTAINER_NAME}" >&2
  exit 1
fi

router_json() {
  curl -fsS --max-time 2 "http://127.0.0.1:${HOST_PORT}/api/http/routers" 2>/dev/null \
    | jq -c '.[]? | select(.name == "alice--blog@file")' 2>/dev/null || true
}

LOADED_RULE=""
DEADLINE=$((SECONDS + 30))
while (( SECONDS < DEADLINE )); do
  ROUTER="$(router_json)"
  if [[ -n "${ROUTER}" ]]; then
    RULE="$(jq -r '.rule // ""' <<<"${ROUTER}")"
    if [[ "${RULE}" == *PathPrefix* && "${RULE}" == *"/p/alice--blog"* ]]; then
      LOADED_RULE="${RULE}"
      break
    fi
  fi
  sleep 1
done

if [[ -z "${LOADED_RULE}" ]]; then
  echo "FAIL: router alice--blog@file not loaded with PathPrefix /p/alice--blog within 30s" >&2
  docker logs --tail 20 "${CONTAINER_NAME}" >&2 || true
  exit 1
fi
echo "PASS: router alice--blog@file loaded"

printf 'invalid: yaml: [unbalanced: {{{\n' > "${TMP_DYN}/broken.yml"
sleep 5

STILL_LISTED=false
if [[ -n "$(router_json)" ]]; then
  STILL_LISTED=true
fi
echo "BAD_FILE_BEHAVIOUR: router_still_listed=${STILL_LISTED}"
