# tests/ - Agent Instructions
Routing for the edge-kit test suite. Gate: `npm run ci` from the repo root. Summarise output (rule 8 in `../AGENTS.md`).

| Layer | Where | Command | Docker |
|-------|-------|---------|--------|
| Unit (node:test, TS) | `domain/`, `application/`, `adapters/`, `cli/`, `compose/` | `npm test` | no |
| Golden files | `golden/` (expected rendered Traefik YAML, compared by `adapters/traefikRenderer.test.ts`) | `npm test` | no |
| Shell | `scripts/*.test.sh` | `bash tests/scripts/<name>.test.sh` | no |
| Shell (docker stubbed by PATH shim) | `scripts/rotate-traefik-logs.test.sh` | `bash tests/scripts/rotate-traefik-logs.test.sh` | no |
| Integration | `integration/*.sh` (throwaway Traefik container, cleaned on EXIT) | `./tests/integration/<name>.sh` | yes |
| e2e | `../scripts/e2e-local.sh` | `./scripts/e2e-local.sh` | no |

## Adding a test
1. Mirror the source layer: `src/<layer>/x.ts` -> `tests/<layer>/x.test.ts`. No network, use temp dirs.
2. A new shell or integration script: use `mktemp -d`, clean up in a `trap ... EXIT`, exit non-zero on failure, then add a `run_step` line in `../scripts/ci.sh` and a row in `../AGENTS.md` Test Suite.
3. Never weaken an assertion to pass; fix the code or the test.
4. Never print secrets in test output.
