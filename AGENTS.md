# AGENTS.md - Bifrost5 Edge-kit

## Purpose
Standalone Cloudflare tunnel + Traefik route-registration kit (`edgectl`). Stays standalone: no imports from host projects and no names of host projects, allowed only in files on the `scripts/check-standalone.sh` allow-list.
Routing doc: open only the context you need. Read frontmatter or `head -5` of a file first; skip if irrelevant.

## Routing
| Need | Go to |
|------|-------|
| Domain rules (route spec, safety, ports) | `src/domain/` |
| Use cases (register/unregister/reconcile) | `src/application/` |
| Cloudflare, Traefik renderer, file store | `src/adapters/` |
| CLI entry (`bin/edgectl` -> `src/cli/main.ts`) | `src/cli/` |
| Tests (layers, commands, how to add) | [`tests/AGENTS.md`](tests/AGENTS.md) |
| Scripts (what each does) | [`scripts/AGENTS.md`](scripts/AGENTS.md) |
| Usage, env vars, policy file, setup | `README.md` |
| Traefik file-provider config, security middleware | `dynamic/` (`security.yml` is tracked; other `*.yml` are generated, gitignored) |
| Tunnel + router stack | `compose.yml` |
| CI workflow | `.github/workflows/ci.yml` (runs `./scripts/ci.sh`) |

## Rules
1. Never push to `main`; ship by branch + PR. Why: main stays green and reviewable.
2. `npm run ci` must pass before any push. Why: it is the same gate GitHub CI runs.
3. Back up to `BACKUPS/` (date suffix) before `rm` or replacing a file; ask before deleting. Why: recoverable history.
4. Never print `TUNNEL_TOKEN`, `.env*` or any secret; check by length only (`wc -c`). Why: logs leak.
5. Propose, do not edit, when touching `src/domain` safety rules, the route contract, or the policy format. Why: they are the security boundary.
6. Questions get answers only; on a mistake, alert and halt. Why: no surprise mutations.
7. Scripts first: check `scripts/AGENTS.md` before inventing a command. Why: one tested way per task.
8. Summarise test output: log to a file, show at most 5 lines (`tail -n 5`). Why: keeps context small.
9. Targeted reads: `jq` for json, `yq` for yaml, `mdq` for markdown, `ast-grep` for code; never cat files over 100 lines. Why: token cost.

## Test Suite
Gate: `npm run ci` (= `./scripts/ci.sh`, stops at first failure, shows last 5 lines). Needs docker for the last two steps.

| Layer | Command | Docker | In `npm run ci` |
|-------|---------|--------|-----------------|
| Unit (domain, application, adapters, cli, compose, golden) | `npm test` | no | yes |
| Standalone check | `./scripts/check-standalone.sh` | no | yes |
| Standalone check tests | `bash tests/scripts/check-standalone.test.sh` | no | yes |
| Security audit of this tree | `./scripts/security-audit.sh` | no | yes |
| Ops script tests (rotate_logs, security-audit) | `bash tests/scripts/ops.test.sh` | no | yes |
| Traefik log rotation tests (docker stubbed) | `bash tests/scripts/rotate-traefik-logs.test.sh` | no | yes |
| e2e (temp dirs, `EDGEKIT_ENABLED=1`) | `./scripts/e2e-local.sh` | no | yes |
| Integration: Traefik loads generated config | `./tests/integration/traefik.sh` | yes | yes |
| Integration: real request path through Traefik | `./tests/integration/traefik-request.sh` | yes | yes |

Fast loop: `npm test`. Full proof: `npm run ci`.
