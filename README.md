# edge-kit

## Purpose

edge-kit publishes HTTP routes through Traefik's file provider, optionally behind a Cloudflare tunnel. The CLI `bin/edgectl` registers, unregisters, lists and reconciles routes. Each route is rendered as a Traefik YAML file in `EDGEKIT_DYNAMIC_DIR`. Traefik serves them on `127.0.0.1:18080` by default. With the `tunnel` profile, the `cloudflared` service in `compose.yml` forwards public traffic to Traefik.

## Requirements

- Node.js 24 or newer, and npm
- Docker with Compose v2 (`docker compose`), for the stack and the integration tests
- `flock` (util-linux)
- `jq` and `curl`, for the `npm run ci` gate

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `EDGEKIT_STATE_DIR` | none (required) | Route specs, `edgectl.lock`, quota state |
| `EDGEKIT_DYNAMIC_DIR` | none (required) | Rendered Traefik YAML files |
| `EDGEKIT_POLICY` | none (required) | Path to the policy JSON file |
| `EDGEKIT_ENABLED` | `0` | Must be `1` for `register`, `unregister` and `reconcile`. Otherwise they exit 3. `list` always works |
| `EDGEKIT_HTTP_PORT` | `18080` | Host port for Traefik's HTTP entrypoint, bound to `127.0.0.1` in `compose.yml` |
| `EDGEKIT_LOG_DIR` | `<repo>/logs` | Root for Traefik access logs (`traefik/access.log`) used by log rotation |
| `EDGEKIT_ROTATE_DAYS` | `5` | Minimum days between Traefik log rotations |
| `EDGEKIT_TRAEFIK_CONTAINER` | `edgekit-traefik-1` | Container signalled with USR1 after rotation |
| `EDGEKIT_REOPEN_TIMEOUT` | `10` | Seconds to wait for `access.log` to reappear after rotation |
| `TUNNEL_TOKEN` | none | Cloudflare tunnel token for the `tunnel` profile. Never printed or logged. Keep files that hold it at mode 600 |
| `CF_ACCESS_TEAM_DOMAIN` | none (required for `access-verifier`) | Cloudflare Access team domain the verifier fetches its JWKS from (`https://<domain>/cdn-cgi/access/certs`) |
| `CF_ACCESS_AUD` | none (required for `access-verifier`) | Expected `aud` claim on the Cloudflare Access JWT |
| `CF_API_TOKEN` | none (required for `edge ingress`\|`dns`\|`access`) | Cloudflare API token used to read and, with `--apply`, write tunnel ingress, DNS and Access config. Read from the environment only: never printed, logged or accepted as a flag |
| `CF_ACCOUNT_ID` | none (required for `edge ingress` and `edge access`) | Cloudflare account ID |
| `CF_TUNNEL_ID` | none (required for `edge ingress`) | Cloudflare tunnel ID whose ingress config is read/updated |
| `CF_ZONE_ID` | none (required for `edge dns`) | Cloudflare zone ID the DNS record lives in |

The CLI exits 1 unless all of `EDGEKIT_STATE_DIR`, `EDGEKIT_DYNAMIC_DIR` and `EDGEKIT_POLICY` are set, except for the `edge` commands below, which only touch Cloudflare account resources and need none of those three (the `bin/edgectl` wrapper still requires `EDGEKIT_STATE_DIR` to build its lock file path).

## Run the stack

```bash
export EDGEKIT_STATE_DIR=/var/lib/edgekit/state
export EDGEKIT_DYNAMIC_DIR="$PWD/dynamic"
export EDGEKIT_POLICY=/var/lib/edgekit/policy.json
export EDGEKIT_ENABLED=1
mkdir -p logs/traefik "$EDGEKIT_STATE_DIR"
docker compose up -d
docker compose --profile tunnel up -d    # also starts cloudflared; needs TUNNEL_TOKEN
```

`compose.yml` mounts `./dynamic` into Traefik, so `EDGEKIT_DYNAMIC_DIR` must point at that directory for Traefik to load the routes. `dynamic/security.yml` and `dynamic/notfound.yml` are tracked; other `dynamic/*.yml` files are generated and gitignored.

Any request that does not match a registered route, or any other router, is answered by the `edgekit-notfound` catch-all: `dynamic/notfound.yml` registers a `PathPrefix(\`/\`)` router at priority 1 (so it never outranks the priority-1000 probe-block router or any registered route — Traefik gives longer rules higher priority by default) pointed at the `edgekit-notfound` service (`nginx:alpine`, no published ports, `notfound/default.conf` mounted read-only) in `compose.yml`. It returns HTTP 404 with `Content-Type: application/json` and body `{"statusCode":404,"message":"Howdy, you seem lost. Resources not found"}`.

## Commands

All commands go through `bin/edgectl`, which runs the CLI under `flock`.

| Command | Does | Needs `EDGEKIT_ENABLED=1` |
|---------|------|---------------------------|
| `register --owner <o> --name <n> --host <h> --target <http://ip:port> [--access private\|public] [--no-strip]` | Creates a route, or updates it if the spec differs. Prints the spec as JSON | yes |
| `unregister <id>` | Removes the route and its rendered file. Idempotent, exits 0 when already removed | yes |
| `list` | Prints all routes as JSON | no |
| `reconcile` | Removes rendered files that have no matching route, and re-creates missing ones | yes |

```bash
bin/edgectl register --owner alice --name blog \
  --host sites.example.com --target http://10.20.0.5:3000
bin/edgectl list
bin/edgectl unregister alice--blog
```

Exit codes: `0` success, `2` validation or usage error (including the per-owner cap and the registration rate limit), `3` mutation while disabled, `1` other failure.

The route ID is `<owner>--<name>`, and the public path is `/p/<id>/`; a request to the bare `/p/<id>` (no trailing slash) redirects to `/p/<id>/` so relative asset URLs resolve.

## Cloudflare edge commands

`bin/edgectl edge <ingress|dns|access> <hostname> ...` talk directly to the Cloudflare API (tunnel ingress, DNS and Access apps). They are dry-run by default: they always print the diff they would apply and exit 0, and never call a mutating Cloudflare API method unless `--apply` is given. `CF_API_TOKEN` is read from the environment only — it is never accepted as a flag, never printed and never written to disk; adapter errors redact it too. These commands do not touch `EDGEKIT_STATE_DIR`, `EDGEKIT_DYNAMIC_DIR`, `EDGEKIT_POLICY` or `EDGEKIT_ENABLED`.

| Command | Does | Required env |
|---------|------|---------------|
| `edge ingress <hostname> --service <svc> [--apply]` | Ensures `<hostname>` routes to `<svc>` in the tunnel's ingress config | `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_TUNNEL_ID` |
| `edge dns <hostname> --target <target> [--proxied true\|false] [--ttl <n>] [--apply]` | Ensures a CNAME record for `<hostname>` pointing at `<target>` | `CF_API_TOKEN`, `CF_ZONE_ID` |
| `edge access <hostname> --name <name> --policy <json> [--apply]` | Ensures a Cloudflare Access app for `<hostname>` with the given policy | `CF_API_TOKEN`, `CF_ACCOUNT_ID` |

```bash
export CF_API_TOKEN=***            # never printed; required for all edge commands
export CF_ACCOUNT_ID=acc_123
export CF_TUNNEL_ID=tun_456
export CF_ZONE_ID=zone_789

bin/edgectl edge ingress app.example.com --service http://10.20.0.5:3000   # prints the diff, exits 0, no mutation
bin/edgectl edge ingress app.example.com --service http://10.20.0.5:3000 --apply   # applies it

bin/edgectl edge dns app.example.com --target tunnel-id.cfargotunnel.com
bin/edgectl edge access app.example.com --name app-access --policy '{"decision":"allow","include":[{"email_domain":{"domain":"example.com"}}]}'
```

Missing `CF_API_TOKEN` (or the other required `CF_*` variable for that subcommand) prints a clear error naming the missing variable and exits 1; it never prints the variable's value. A missing hostname or required flag (`--service`, `--target`, `--name`/`--policy`) exits 2.

## Policy JSON example

`EDGEKIT_POLICY` points to a JSON file like this:

```json
{
  "reservedOwners": ["ops", "system", "internal"],
  "allowedHosts": ["sites.example.com", "test.example.com"],
  "ownerCidrs": {
    "alice": ["10.20.0.0/16"],
    "bob": ["10.30.0.0/16"]
  },
  "denyIps": ["127.0.0.0/8", "169.254.0.0/16", "0.0.0.0/8"],
  "publicOwners": ["bob"]
}
```

- `allowedHosts`: the only hosts a route may use.
- `ownerCidrs`: the IPv4 ranges each owner's targets must fall in.
- `reservedOwners`: merged with the built-in list `DEFAULT_RESERVED_OWNERS` in `src/domain/routeSpec.ts`. A trailing `*` matches a prefix.
- `denyIps`: when set, replaces the default deny list (`127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0/8`).
- `publicOwners`: owners allowed to register `--access public`. Routes are `private` by default.

## Safety rules

1. Owner matches `^[a-z0-9]+$`, so no hyphens. Name matches `^[a-z0-9][a-z0-9-]{0,38}$`. This stops `alice` and `alice-bob` from colliding.
2. Reserved owners are refused.
3. Host must be in `allowedHosts` and match `^[a-z0-9.-]+$`.
4. Target must be `http://<IPv4 literal>:<port>`. DNS names and IPv6 are refused. The IP must be inside the owner's CIDRs and outside the deny list.
5. `pathPrefix` is always `/p/<id>/`. A caller-supplied value that differs is an error.
6. `--access public` requires the owner to be in `publicOwners`.
7. Per-owner route cap (20) and registration rate limit (10 per 60-second window) apply.
8. Writes are atomic: a `.tmp` file, then rename.
9. Existing files without the `# managed-by: edgekit` marker are never overwritten. `unregister` and `reconcile` only remove marked files.
10. All state changes run under `flock`.
11. `edgekit-security@file` is always the first middleware on every router.
12. Private routes use `edgekit-access-jwt@file`, which forwards to `http://access-verifier:9000/verify`. The `access-verifier` service (`src/verifier/server.ts`) checks the `Cf-Access-Jwt-Assertion` header's signature (RS256, JWKS from `CF_ACCESS_TEAM_DOMAIN`, cached), `exp` and `aud`; a missing header, bad signature, expired token or wrong `aud` all return 401, so private routes fail closed.

`dynamic/security.yml` applies `edgekit-security-ratelimit` to every route: average 20 requests per second, burst 60, keyed on the `Cf-Connecting-Ip` header. Requests without that header share one bucket.

## Running tests

- Unit tests (no Docker):
  ```bash
  npm test
  ```
- Standalone check, security audit and shell tests (no Docker):
  ```bash
  ./scripts/check-standalone.sh
  ./scripts/security-audit.sh
  bash tests/scripts/check-standalone.test.sh
  bash tests/scripts/ops.test.sh
  bash tests/scripts/rotate-traefik-logs.test.sh
  ```
- Port and firewall check (no Docker required to run it, though it reports on published container ports when Docker is present):
  ```bash
  ./scripts/port-check.sh
  ```
  Lists listening TCP sockets (`ss -ltnH`) and published container ports (`docker ps --format`), and exits 1 if any kit port is bound to `0.0.0.0`, `[::]` or `*` (all interfaces). The kit ports default to `18080,18081` and can be overridden with `EDGEKIT_PORTS` (comma-separated). It also prints one advisory line on whether `ufw status` shows a `DENY` rule for those ports; `ufw` is advisory only, prints `ufw: unknown` when it needs root and is unreadable, and is never run with `sudo`. Output is capped at 10 lines. Tested by `tests/scripts/portCheck.test.ts` (run as part of `npm test`), which stubs `ss` on `PATH`.
- End-to-end definition-of-done scenario (Docker daemon required). It runs in temp dirs with `EDGEKIT_ENABLED=1` and prints PASS or FAIL per step. It covers a successful register, refused owners and targets, the disabled exit code, unregister (including a second run), reconcile removing an orphan file, and then a single throwaway-hostname flow: register a public route, confirm it is served through Traefik on `127.0.0.1:18080`, confirm a private route is refused without a token (the `edgekit-access-jwt@file` middleware fails closed with no Access verifier reachable), and unregister both routes. Everything runs against local temp dirs and throwaway Docker containers; by default it never contacts Cloudflare:
  ```bash
  ./scripts/e2e-local.sh
  ```
  Pass `--live` to additionally start the real `cloudflared` tunnel profile (`docker compose --profile tunnel up -d cloudflared`) against Cloudflare, proving the same throwaway route is reachable through your tunnel. This step is skipped (printed as a dry run) unless `--live` is given, and it requires `TUNNEL_TOKEN` to be set and a throwaway hostname already wired to that tunnel in your Cloudflare account — never point `--live` at a real/production hostname, and never run it in CI:
  ```bash
  TUNNEL_TOKEN=*** ./scripts/e2e-local.sh --live
  ```
- Integration tests (Docker daemon required):
  ```bash
  ./tests/integration/traefik.sh          # Traefik loads the generated config
  ./tests/integration/traefik-request.sh  # real requests: public reaches backend, private refused
  ```
- Full gate, the same one GitHub CI runs (needs `jq`, `curl` and Docker). It runs every layer above in order and stops at the first failure:
  ```bash
  npm run ci
  ```
- Manual check for the `edgekit-notfound` catch-all (not covered by `./scripts/e2e-local.sh`; see "Not done yet"): with the stack up (`docker compose up -d`), hit any unmatched host or path and confirm a branded 404, not Traefik's bare one:
  ```bash
  curl -i http://127.0.0.1:18080/this-does-not-exist
  # HTTP/1.1 404 Not Found
  # Content-Type: application/json
  # {"statusCode":404,"message":"Howdy, you seem lost. Resources not found"}
  ```

## Not done yet

- No read-only GET against the real Cloudflare API has been run
- `./scripts/e2e-local.sh` refuses a private route with HTTP 500, not 401 or 403, because the throwaway Traefik container it starts cannot reach the Access verifier
- Not proven end to end: a logged-in request through Cloudflare Access reaching a registered origin, and a valid Access token passing through the verifier
- The `edgekit-notfound` catch-all (`dynamic/notfound.yml` + the `edgekit-notfound` service) is covered by `tests/compose/notfound.test.ts` and the manual check above, but not by `./scripts/e2e-local.sh`: its throwaway Traefik container runs with plain `docker run` on the default bridge network, which does not resolve service names by DNS, so `http://edgekit-notfound:80` would not resolve there without reworking that step onto a user-defined network alongside every other throwaway container it starts
