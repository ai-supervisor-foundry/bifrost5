# AGENTS.md - edge-kit

## What this is
edge-kit is a standalone Cloudflare Tunnel + Traefik kit. The CLI `edgectl` registers, unregisters, lists and reconciles HTTP routes. Each route is a generated Traefik file-provider YAML in a dynamic directory. Traefik serves them on `127.0.0.1:18080`. An optional `cloudflared` container forwards public traffic to Traefik.

Full usage, env vars and policy details: [`README.md`](README.md). This file covers what you need to work in the repo.

## Requirements
- Node.js 24+ and npm
- Docker with Compose v2 (`docker compose`), needed for the stack and the integration tests
- `flock` (util-linux)
- `jq` and `curl` (the CI gate checks for both)

## Quick start
```bash
npm ci
npm test                                   # fast loop: unit tests

# Run the stack
mkdir -p logs/traefik
export EDGEKIT_STATE_DIR=/var/lib/edgekit/state
export EDGEKIT_DYNAMIC_DIR=/var/lib/edgekit/dynamic
export EDGEKIT_POLICY=/var/lib/edgekit/policy.json
export EDGEKIT_ENABLED=1
mkdir -p "$EDGEKIT_STATE_DIR" "$EDGEKIT_DYNAMIC_DIR"
cp dynamic/security.yml "$EDGEKIT_DYNAMIC_DIR/security.yml"
docker compose up -d                       # add --profile tunnel + TUNNEL_TOKEN for Cloudflare

# Register and check a route
bin/edgectl register --owner alice --name blog --host sites.example.com --target http://10.20.0.5:3000
bin/edgectl list
```

Minimal policy file (`EDGEKIT_POLICY`):
```json
{
  "reservedOwners": ["ops", "system"],
  "allowedHosts": ["sites.example.com"],
  "ownerCidrs": { "alice": ["10.20.0.0/16"] }
}
```
Optional keys: `denyIps`, `publicOwners`. Built-in reserved owners (`apps`, `admin`, `api`, `control`, `connect`) are always added.

## Layout
| Need | Go to |
|------|-------|
| Domain rules: route spec, safety, ports | `src/domain/` |
| Use cases: register, unregister, reconcile | `src/application/` |
| Cloudflare, Traefik renderer, file store | `src/adapters/` |
| CLI entry (`bin/edgectl` runs `src/cli/main.ts` under `flock`) | `src/cli/` |
| Traefik file-provider config, security middleware | `dynamic/` (`security.yml` and `probe-block.yml` are tracked; other `*.yml` are generated and gitignored) |
| Tunnel + router stack | `compose.yml` |
| Ops scripts (log rotation, audits, standalone check) | `scripts/` ([`scripts/AGENTS.md`](scripts/AGENTS.md)) |
| Tests, layers, how to add one | `tests/` ([`tests/AGENTS.md`](tests/AGENTS.md)) |
| CI workflow | `.github/workflows/ci.yml` (runs `./scripts/ci.sh`) |

## Commands (`bin/edgectl`)
| Command | Does | Needs `EDGEKIT_ENABLED=1` |
|---------|------|---------------------------|
| `register --owner <o> --name <n> --host <h> --target <http://ip:port> [--access private\|public] [--no-strip]` | Creates or updates a route with the same spec | yes |
| `unregister <id>` | Removes a route and its rendered file. Idempotent | yes |
| `list` | Prints routes as JSON | no |
| `reconcile` | Removes orphan YAML files, re-creates missing ones | yes |

Mutations with the switch off exit with code 3. `edgectl` refuses to run without `EDGEKIT_STATE_DIR`.

## Environment variables
| Variable | Default | Purpose |
|----------|---------|---------|
| `EDGEKIT_STATE_DIR` | none (required) | Route specs, lock file, quota state |
| `EDGEKIT_DYNAMIC_DIR` | none | Rendered Traefik YAML |
| `EDGEKIT_POLICY` | none | Policy JSON path |
| `EDGEKIT_ENABLED` | `0` | Master switch for register, unregister, reconcile |
| `EDGEKIT_HTTP_PORT` | `18080` | Host port for Traefik's HTTP entrypoint (bound to 127.0.0.1) |
| `EDGEKIT_LOG_DIR` | `<repo>/logs` | Root for Traefik access logs (`traefik/access.log`) |
| `EDGEKIT_ROTATE_DAYS` | `5` | Minimum days between Traefik log rotations |
| `EDGEKIT_TRAEFIK_CONTAINER` | `edgekit-traefik-1` | Container signalled with USR1 after rotation |
| `EDGEKIT_REOPEN_TIMEOUT` | `10` | Seconds to wait for `access.log` to reappear after rotation |
| `TUNNEL_TOKEN` | none | Cloudflare tunnel token for the `tunnel` profile. Never print or log it. Keep secret files at mode 600 |

## Rules
1. Never push to `main`. Ship by branch + PR. Why: main stays green and reviewable.
2. `npm run ci` must pass before any push. Why: it is the same gate GitHub CI runs.
3. Standalone: no imports from host projects and no names of host projects. `scripts/check-standalone.sh` enforces this; its allow-list is inside that script. Why: the kit must work when copied anywhere.
4. Never print `TUNNEL_TOKEN`, `.env*` or any secret. Check length only (`wc -c`). Why: logs leak.
5. Back up to `BACKUPS/<name>.<YYYY-MM-DD>` before `rm` or replacing a file. Ask before deleting. Why: recoverable history.
6. Propose, do not edit, changes to `src/domain` safety rules, the route contract or the policy format. Why: they are the security boundary.
7. Questions get answers only. On a mistake, alert and halt. Why: no surprise mutations.
8. Scripts first: check `scripts/AGENTS.md` before writing a command. Why: one tested way per task.
9. Keep output small: send long test or build output to a file and show `tail -n 5`. Use `jq` for JSON, `yq` for YAML, `mdq` for Markdown, `ast-grep` for code. Do not cat files over 100 lines. Why: token cost.

## Safety model
Enforced in `src/domain/routeSpec.ts` and `src/application/`. Keep these intact.
- Owner matches `^[a-z0-9]+$` (no hyphens). Route ID is `<owner>--<name>`, name matches `^[a-z0-9][a-z0-9-]{0,38}$`. This stops `alice` and `alice-bob` from colliding.
- `pathPrefix` is always `/p/<id>`. Callers cannot set it.
- Reserved owners are refused. Hosts must match `allowedHosts`. Backticks and invalid characters are rejected.
- Targets are IPv4 literals inside the owner's CIDR. DNS names, IPv6, loopback, link-local and `0.0.0.0/8` are refused.
- Per-owner route caps and registration rate limits apply.
- Writes are atomic: temp file with a non-YAML extension, then rename.
- All state changes run under `flock`.
- `edgekit-security@file` middleware is always first on every router.

## Behaviour to know
- Private routes fail closed. They need an Access JWT verifier at `http://access-verifier:9000/verify`, which this kit does not provide yet.
- Rate limit (`dynamic/security.yml`): average 20 req/s, burst 60, keyed on the `Cf-Connecting-Ip` header. Requests without that header share one bucket.
- Traefik log rotation is not scheduled by compose. Example cron (not installed): `17 3 * * * cd /path/to/edge-kit && ./scripts/rotate_traefik_logs.sh >> logs/rotate.log 2>&1`.
- The tunnel container only starts with `--profile tunnel`.

## Tests and gate
Gate: `npm run ci` (`./scripts/ci.sh`). It stops at the first failing step, prints the last 5 lines, and keeps the full log. The Docker steps need a running daemon.

| Layer | Command | Docker |
|-------|---------|--------|
| Unit (domain, application, adapters, cli, compose, golden) | `npm test` | no |
| Standalone check and its tests | `./scripts/check-standalone.sh`, `bash tests/scripts/check-standalone.test.sh` | no |
| Security audit of this tree | `./scripts/security-audit.sh` | no |
| Ops script tests | `bash tests/scripts/ops.test.sh` | no |
| Traefik log rotation tests (docker stubbed) | `bash tests/scripts/rotate-traefik-logs.test.sh` | no |
| e2e in temp dirs | `./scripts/e2e-local.sh` | no |
| Integration: Traefik loads generated config | `./tests/integration/traefik.sh` | yes |
| Integration: real request path through Traefik | `./tests/integration/traefik-request.sh` | yes |

Fast loop: `npm test`. Full proof: `npm run ci`.

## Not done yet
- Access JWT verifier service
- Tunnel and DNS wiring in the CLI (`src/adapters/cloudflareDns.ts` and `cloudflareIngress.ts` exist, not yet wired to `edgectl`)
- Cloudflare Access app automation
