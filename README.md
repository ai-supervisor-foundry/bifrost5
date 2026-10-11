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

The CLI exits 1 unless all of `EDGEKIT_STATE_DIR`, `EDGEKIT_DYNAMIC_DIR` and `EDGEKIT_POLICY` are set.

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

`compose.yml` mounts `./dynamic` into Traefik, so `EDGEKIT_DYNAMIC_DIR` must point at that directory for Traefik to load the routes. `dynamic/security.yml` is tracked; other `dynamic/*.yml` files are generated and gitignored.

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

The route ID is `<owner>--<name>`, and the public path is `/p/<id>`.

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
12. Private routes use `edgekit-access-jwt@file`, which forwards to `http://access-verifier:9000/verify`. This kit does not provide that verifier yet, so private routes fail closed until it exists.

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

## Not done yet

- Access JWT verifier service
- Tunnel and DNS wiring in the CLI (`src/adapters/cloudflareDns.ts` and `src/adapters/cloudflareIngress.ts` exist but are not wired to `bin/edgectl`)
- Cloudflare Access app automation
