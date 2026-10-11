#!/usr/bin/env bash
set -euo pipefail

TMP_STATE="$(mktemp -d)"
TMP_DYN="$(mktemp -d)"
RUN_ID="$$-$(date +%s)-${RANDOM}"
BACKEND="edgekit-req-be-${RUN_ID}"
TRAEFIK="edgekit-req-tk-${RUN_ID}"
MARKER="edgekit-backend-ok"

cleanup() {
  docker rm -f "${BACKEND}" "${TRAEFIK}" >/dev/null 2>&1 || true
  rm -rf "${TMP_STATE}" "${TMP_DYN}"
}
trap cleanup EXIT

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Backend
docker run -d --name "${BACKEND}" nginx:alpine >/dev/null
docker exec "${BACKEND}" sh -c "echo ${MARKER} > /usr/share/nginx/html/index.html"
BACKEND_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${BACKEND}")"
if [ -z "${BACKEND_IP}" ]; then
  echo "Failed to resolve bridge IP for ${BACKEND}" >&2
  exit 1
fi
PREFIX="${BACKEND_IP%.*}"
CIDR="${PREFIX}.0/24"

# Policy
TMP_POLICY="${TMP_STATE}/policy.json"
printf '{\n  "reservedOwners": ["apps", "admin", "api", "control", "connect"],\n  "allowedHosts": ["sites.example.com"],\n  "ownerCidrs": {"alice": ["%s"]},\n  "publicOwners": ["alice"]\n}\n' \
  "${CIDR}" > "${TMP_POLICY}"

edgectl() {
  EDGEKIT_STATE_DIR="${TMP_STATE}" \
  EDGEKIT_DYNAMIC_DIR="${TMP_DYN}" \
  EDGEKIT_POLICY="${TMP_POLICY}" \
  EDGEKIT_ENABLED=1 \
  "${REPO_ROOT}/bin/edgectl" "$@" >/dev/null
}

edgectl register --owner alice --name blog --host sites.example.com \
  --target "http://${BACKEND_IP}:80" --access public
edgectl register --owner alice --name private --host sites.example.com \
  --target "http://${BACKEND_IP}:80"

cp "${REPO_ROOT}/dynamic/security.yml" "${TMP_DYN}/"

# Traefik
docker run -d --name "${TRAEFIK}" \
  -v "${TMP_DYN}:/etc/traefik/dynamic:ro" \
  -p 127.0.0.1::80 \
  traefik:v3 \
  --providers.file.directory=/etc/traefik/dynamic \
  --providers.file.watch=true \
  --entrypoints.web.address=:80 >/dev/null

PORT="$(docker port "${TRAEFIK}" 80 | head -n1 | sed -E 's/.*:([0-9]+)$/\1/')"
if [ -z "${PORT}" ]; then
  echo "Failed to resolve mapped port for ${TRAEFIK}" >&2
  exit 1
fi

BODY="${TMP_STATE}/body"
HEADERS="${TMP_STATE}/headers"

# Poll for the public route
READY=false
DEADLINE=$((SECONDS + 30))
while [ "${SECONDS}" -lt "${DEADLINE}" ]; do
  STATUS="$(curl -s --max-time 3 -o "${BODY}" -w '%{http_code}' \
    -H 'Host: sites.example.com' "http://127.0.0.1:${PORT}/p/alice--blog/" 2>/dev/null || true)"
  if [ "${STATUS}" = "200" ] && grep -q "${MARKER}" "${BODY}" 2>/dev/null; then
    READY=true
    break
  fi
  sleep 1
done

if [ "${READY}" != "true" ]; then
  echo "FAIL: public route did not become ready within 30s"
  exit 1
fi

FAILED=0
check() { # name, condition result (0 = pass)
  if [ "$2" -eq 0 ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1"
    FAILED=1
  fi
}

req() { # path -> sets STATUS, writes BODY and HEADERS
  STATUS="$(curl -s --max-time 5 -D "${HEADERS}" -o "${BODY}" -w '%{http_code}' \
    -H 'Host: sites.example.com' "http://127.0.0.1:${PORT}$1" 2>/dev/null || true)"
}

# a + b: public route
req /p/alice--blog/
if [ "${STATUS}" = "200" ] && grep -q "${MARKER}" "${BODY}"; then A=0; else A=1; fi
check "public route returns 200 with backend body" "${A}"

if grep -qi '^x-robots-tag: *noindex, nofollow' "${HEADERS}"; then B=0; else B=1; fi
check "public response has X-Robots-Tag noindex, nofollow" "${B}"

# c: private route fails closed
req /p/alice--private/
# Not 200 and not 404: a 404 would be an unrelated "no route" answer, not the middleware chain.
if [ "${STATUS}" != "200" ] && [ "${STATUS}" != "404" ] && ! grep -q "${MARKER}" "${BODY}" \
  && grep -qi '^x-robots-tag: *noindex' "${HEADERS}"; then C=0; else C=1; echo "  private route status=${STATUS}"; fi
check "private route is refused by the chain (not 200/404, X-Robots-Tag noindex)" "${C}"

# d: unregistered id
req /p/alice--nope/
if [ "${STATUS}" = "404" ]; then D=0; else D=1; fi
check "unregistered id returns 404" "${D}"

# e-g: rate limit is keyed per client by the Cf-Connecting-Ip header (average 20/s, burst 60).
# 40 quick requests cannot exceed a burst of 60, so the flood is 200 requests, 20 in parallel.
ip_req() { # header value, path -> prints status
  curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
    -H 'Host: sites.example.com' -H "Cf-Connecting-Ip: $1" "http://127.0.0.1:${PORT}$2" 2>/dev/null || true
}

if [ "$(ip_req 203.0.113.10 /p/alice--blog/)" = "200" ]; then E=0; else E=1; fi
check "single request with Cf-Connecting-Ip is not rejected" "${E}"

FLOOD_CODES="$(seq 200 | xargs -P 20 -I{} curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' \
  -H 'Host: sites.example.com' -H 'Cf-Connecting-Ip: 203.0.113.20' \
  "http://127.0.0.1:${PORT}/p/alice--blog/" 2>/dev/null || true)"
if echo "${FLOOD_CODES}" | grep -qx 429; then F=0; else F=1; fi
check "flood from one Cf-Connecting-Ip value gets 429" "${F}"

if [ "$(ip_req 203.0.113.30 /p/alice--blog/)" = "200" ]; then G=0; else G=1; fi
check "a different Cf-Connecting-Ip value is still served (200) during the flood" "${G}"

# h: observed behaviour with the header missing (a local request not via cloudflared):
# Traefik does not refuse it; all header-less requests share ONE bucket (empty key).
sleep 4
if [ "$(ip_req '' /p/alice--blog/)" = "200" ]; then H=0; else H=1; fi
check "request without Cf-Connecting-Ip is not refused (shares one header-less bucket)" "${H}"

if [ "${FAILED}" -ne 0 ]; then
  exit 1
fi

echo "Request-path integration passed."
