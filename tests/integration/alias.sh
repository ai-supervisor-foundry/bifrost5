#!/usr/bin/env bash
# Stable-name targets: a route registered against a Docker network alias keeps
# working when the backend is recreated with a different IP, and returns 502
# when the backend is gone. Everything runs on a scratch network.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="$$-$(date +%s)-${RANDOM}"
NET="edgekit-it-net-$$"
BACKEND="itx-al-be-${RUN_ID}"
BACKEND2="itx-al-be2-${RUN_ID}"
DECOY="itx-al-decoy-${RUN_ID}"
TRAEFIK="itx-al-tk-${RUN_ID}"
ALIAS="app--x"
IMAGE="nginx:1.29.4-alpine"
TMP_STATE="$(mktemp -d)"
TMP_DYN="$(mktemp -d)"

cleanup() {
  docker rm -f "${BACKEND}" "${BACKEND2}" "${DECOY}" "${TRAEFIK}" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  rm -rf "${TMP_STATE}" "${TMP_DYN}"
  return 0
}
trap cleanup EXIT

# Scratch network with an explicit subnet so a decoy can take a fixed IP.
SUBNET_PREFIX=""
for _ in $(seq 1 20); do
  P="10.$((100 + RANDOM % 100)).$((RANDOM % 256))"
  if docker network create --subnet "${P}.0/24" "${NET}" >/dev/null 2>&1; then
    SUBNET_PREFIX="${P}"
    break
  fi
done
if [ -z "${SUBNET_PREFIX}" ]; then
  echo "FAIL: could not create scratch network ${NET}" >&2
  exit 1
fi

POLICY="${TMP_STATE}/policy.json"
printf '{\n  "reservedOwners": ["apps", "admin", "api", "control", "connect"],\n  "allowedHosts": ["sites.example.com"],\n  "ownerCidrs": {"alice": ["%s.0/24"]},\n  "ownerTargets": {"alice": ["%s"]},\n  "publicOwners": ["alice"]\n}\n' \
  "${SUBNET_PREFIX}" "${ALIAS}" > "${POLICY}"

edgectl() {
  EDGEKIT_STATE_DIR="${TMP_STATE}" \
  EDGEKIT_DYNAMIC_DIR="${TMP_DYN}" \
  EDGEKIT_POLICY="${POLICY}" \
  EDGEKIT_ENABLED=1 \
  EDGEKIT_ALIAS_TARGETS=1 \
  EDGEKIT_NETWORK="${NET}" \
  "${REPO_ROOT}/bin/edgectl" "$@"
}

start_backend() { # name marker [ip]
  local name="$1" marker="$2" ip_args=()
  [ -n "${3:-}" ] && ip_args=(--ip "$3")
  docker run -d --name "${name}" --network "${NET}" --network-alias "${ALIAS}" "${ip_args[@]}" "${IMAGE}" >/dev/null
  docker exec "${name}" sh -c "echo ${marker} > /usr/share/nginx/html/index.html"
}

ip_of() {
  docker inspect -f "{{(index .NetworkSettings.Networks \"${NET}\").IPAddress}}" "$1"
}

FAILED=0
check() { # name, rc (0 = pass)
  if [ "$2" -eq 0 ]; then echo "PASS: $1"; else echo "FAIL: $1"; FAILED=1; fi
}

MARK1="alias-backend-one"
MARK2="alias-backend-two"

start_backend "${BACKEND}" "${MARK1}"
OLD_IP="$(ip_of "${BACKEND}")"

# Refused: alias not in ownerTargets
if edgectl register --owner alice --name nope --host sites.example.com \
  --target "http://not--listed:80" --access public >/dev/null 2>"${TMP_STATE}/refuse.err"; then R=1; else R=0; fi
if [ "${R}" -eq 0 ] && ! grep -q "not in ownerTargets" "${TMP_STATE}/refuse.err"; then R=1; fi
check "register of alias outside ownerTargets is refused" "${R}"

edgectl register --owner alice --name blog --host sites.example.com \
  --target "http://${ALIAS}:80" --access public >/dev/null
cp "${REPO_ROOT}/dynamic/security.yml" "${TMP_DYN}/"

docker run -d --name "${TRAEFIK}" --network "${NET}" \
  -v "${TMP_DYN}:/etc/traefik/dynamic:ro" \
  -p 127.0.0.1::80 \
  traefik:v3.7.13 \
  --providers.file.directory=/etc/traefik/dynamic \
  --providers.file.watch=true \
  --entrypoints.web.address=:80 >/dev/null

PORT="$(docker port "${TRAEFIK}" 80 | head -n1 | sed -E 's/.*:([0-9]+)$/\1/')"
if [[ ! "${PORT}" =~ ^[0-9]+$ ]]; then
  echo "FAIL: could not resolve mapped port for ${TRAEFIK}" >&2
  exit 1
fi

BODY="${TMP_STATE}/body"
STATUS=""
req() {
  STATUS="$(curl -s --max-time 3 -o "${BODY}" -w '%{http_code}' \
    -H 'Host: sites.example.com' "http://127.0.0.1:${PORT}/p/alice--blog/" 2>/dev/null || true)"
}

wait_for() { # description, status, marker ('' = any body)
  local deadline=$((SECONDS + 30))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    req
    if [ "${STATUS}" = "$2" ] && { [ -z "$3" ] || grep -q "$3" "${BODY}" 2>/dev/null; }; then
      return 0
    fi
    sleep 1
  done
  echo "last status=${STATUS} body=$(head -c 120 "${BODY}" 2>/dev/null)" >&2
  return 1
}

if wait_for "initial" 200 "${MARK1}"; then A=0; else A=1; fi
check "alias route serves backend one (200 + body)" "${A}"
[ "${A}" -eq 0 ] || { docker logs --tail 20 "${TRAEFIK}" >&2 || true; exit 1; }

# Recreate the backend with a different IP, no re-register.
docker rm -f "${BACKEND}" >/dev/null
docker run -d --name "${DECOY}" --network "${NET}" --ip "${OLD_IP}" "${IMAGE}" >/dev/null
start_backend "${BACKEND2}" "${MARK2}"
NEW_IP="$(ip_of "${BACKEND2}")"
if [ -n "${NEW_IP}" ] && [ "${NEW_IP}" != "${OLD_IP}" ]; then D=0; else D=1; fi
check "recreated backend has a different IP (${OLD_IP} -> ${NEW_IP})" "${D}"

if wait_for "recreated" 200 "${MARK2}"; then E=0; else E=1; fi
check "same route reaches recreated backend without re-register" "${E}"

# Backend gone -> 502
docker rm -f "${BACKEND2}" >/dev/null
if wait_for "gone" 502 ""; then G=0; else G=1; fi
check "route returns 502 when backend is stopped" "${G}"

if [ "${FAILED}" -ne 0 ]; then exit 1; fi
echo "alias integration: all assertions passed"
