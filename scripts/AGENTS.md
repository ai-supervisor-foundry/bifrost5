# scripts/ - Agent Instructions
Check here before inventing a command.

| Script | Purpose | Run by `npm run ci` |
|--------|---------|---------------------|
| `ci.sh` | Local and GitHub gate: runs every test layer in order, stops on first failure, prints last 5 lines | is the gate |
| `check-standalone.sh [root]` | Fails if the tree has forbidden host-project words or imports | yes |
| `security-audit.sh [root]` | Fails on docker.sock in compose, loose `.env*` permissions, token or private-key patterns; never prints values | yes |
| `rotate_logs.sh <dir> [max_bytes] [keep]` | Copytruncate log rotation, stays inside `<dir>` | tested only (`tests/scripts/ops.test.sh`); generic size-based tool |
| `rotate_traefik_logs.sh [--force]` | Age-based Traefik access log rotation (default 5 days, `EDGEKIT_ROTATE_DAYS`): move to `archive/<date>/`, USR1 to the container (`EDGEKIT_TRAEFIK_CONTAINER`, default `edgekit-traefik-1`), xz -9e or gzip -9, then prune to the newest 5 archived files. Log root: `EDGEKIT_LOG_DIR` (default `<repo>/logs`) | tested (`tests/scripts/rotate-traefik-logs.test.sh`) |
| `bootstrap.sh [--yes] [--no-timers] [--no-linger]` | Guided re-runnable setup: checks requirements, creates log/state dirs, starts the stack (`--profile tunnel` only when `TUNNEL_TOKEN` is set), installs the user timers `edgekit-check` and `edgekit-traefik-guard` into `~/.config/systemd/user/` with the kit's real path, offers `sudo loginctl enable-linger`. Asks y/N before each step (default no; no terminal and no `--yes` = no). No systemd user session: prints a cron alternative, exits 0 | tested (`tests/scripts/bootstrap.test.sh`) |
| `traefik-guard.sh` | Starts `EDGEKIT_TRAEFIK_CONTAINER` only after an unexpected exit (not exit 0/137/143, not running/paused/created/missing); logs and runs `EDGEKIT_ALERT_CMD "<message>"` if set; exit 1 only if the start fails. Run every 2 minutes by `edgekit-traefik-guard.timer` | tested (`tests/scripts/bootstrap.test.sh`) |
| `edgekit-*.service`, `edgekit-*.timer` | Unit templates with `__EDGEKIT_ROOT__` placeholder; `bootstrap.sh` renders them. Do not copy by hand | via bootstrap test |
| `e2e-local.sh` | End-to-end definition-of-done proof in temp dirs | yes |
| `port-check.sh` | Lists listening TCP sockets (`ss -ltnH`) and published container ports (`docker ps --format`); exits 1 if any kit port (`EDGEKIT_PORTS`, default `18080,18081`) is bound to `0.0.0.0`, `[::]` or `*`. Advisory `ufw status` DENY check (prints `ufw: unknown` if it needs root; never calls sudo). Prints at most 10 lines | tested (`tests/scripts/portCheck.test.ts`, via `npm test`) |
| `outside-in.sh <host-or-ip> [allowed-ports]` | Full TCP port scan (`nmap -Pn -p- --min-rate 1000`) against a target; exits 1 if any open port is outside the allowed list (comma-separated, default `443`), exits 2 if `nmap` is missing or the target argument is missing. Prints at most 10 lines. Only means something run from a network outside the host's LAN | tested (`tests/scripts/outsideIn.test.ts`, via `npm test`) |

Tests for these live in `tests/scripts/`. Changing a script: update its test and this table.

## Scheduling log rotation
Compose does not schedule rotation. Example cron entry (not installed; the script itself skips until the interval has passed, so a daily run is fine):
```
17 3 * * * cd /path/to/edge-kit && ./scripts/rotate_traefik_logs.sh >> logs/rotate.log 2>&1
```
