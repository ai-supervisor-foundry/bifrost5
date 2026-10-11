# scripts/ - Agent Instructions
Check here before inventing a command.

| Script | Purpose | Run by `npm run ci` |
|--------|---------|---------------------|
| `ci.sh` | Local and GitHub gate: runs every test layer in order, stops on first failure, prints last 5 lines | is the gate |
| `check-standalone.sh [root]` | Fails if the tree has forbidden host-project words or imports | yes |
| `security-audit.sh [root]` | Fails on docker.sock in compose, loose `.env*` permissions, token or private-key patterns; never prints values | yes |
| `rotate_logs.sh <dir> [max_bytes] [keep]` | Copytruncate log rotation, stays inside `<dir>` | tested only (`tests/scripts/ops.test.sh`); generic size-based tool |
| `rotate_traefik_logs.sh [--force]` | Age-based Traefik access log rotation (default 5 days, `EDGEKIT_ROTATE_DAYS`): move to `archive/<date>/`, USR1 to the container (`EDGEKIT_TRAEFIK_CONTAINER`, default `edgekit-traefik-1`), xz -9e or gzip -9. Log root: `EDGEKIT_LOG_DIR` (default `<repo>/logs`) | tested (`tests/scripts/rotate-traefik-logs.test.sh`) |
| `e2e-local.sh` | End-to-end definition-of-done proof in temp dirs | yes |

Tests for these live in `tests/scripts/`. Changing a script: update its test and this table.

## Scheduling log rotation
Compose does not schedule rotation. Example cron entry (not installed; the script itself skips until the interval has passed, so a daily run is fine):
```
17 3 * * * cd /path/to/edge-kit && ./scripts/rotate_traefik_logs.sh >> logs/rotate.log 2>&1
```
