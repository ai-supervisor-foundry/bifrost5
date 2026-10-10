---
title: Edge Kit — verified current state and coupling
status: verified against repo 2026-10-10; corrected after Opus design review 2026-10-10
---

# 01 — Context

## How the edge works today (verified)
- `docker-compose.edge.yml` (project `foundry-edge`): `traefik:v3` (providers: docker + file watching `/etc/traefik/dynamic`, entrypoint `web :80`, default middleware `apps-sec@file`, network `myapps-edge`) and `cloudflare/cloudflared` (`tunnel --no-autoupdate run`, token from `.env.edge`). cloudflared starts **only with `--profile tunnel`**. The tunnel is **remotely managed**: a local `config.yml` is ignored; ingress changes go through the Cloudflare dashboard/API.
- `docker-compose.cloud-edge.yml` is the cloud-box variant (token from an SSM-materialized tmpfs file).
- Preview apps (MyApps instances) **auto-register**: `docs/assets/boilerplates/_shared/preview/scripts/preview-up.sh`, wired by `UI/backend/src/services/myAppsPreviewHooks.ts` on `status/worker_assigned`, brings up a container with `traefik.*` labels → `apps…/p/<router>/`. Teardown runs on `settled|cancelled`.
- Other apps are **manual**: `traefik/dynamic/foundrylander.yml` (hand-written), `foundry-api.yml`, `connect-routes.yaml`. Each host-run app also needs `sudo ufw insert 1 allow from 172.16.0.0/12 to any port <p>`. New hostnames need a DNS CNAME and a Cloudflare Access app made by hand.

## Known defect in the current edge (not part of this plan)
`traefik/dynamic/connect-routes.yaml` sends traffic to `http://127.0.0.1:3001`. Inside the Traefik container that address is the container itself, so the route is probably broken. Do not copy this pattern. Raise a separate fix.

## Coupling inventory
| Where | Coupling | Kind |
|-------|----------|------|
| Compose project `foundry-edge`, files in Foundry repo | location/naming | convention |
| `traefik/dynamic/foundry-api.yml`, `connect-routes.yaml` | Foundry backend `:3001`/`:5173` routes | content (becomes Foundry's own route files) |
| `UI/backend/src/services/myAppsPreview.ts`, `myAppsSandbox.ts` | emit Traefik labels in shell templates | generator code |
| `src/domain/ports/deployPort.ts` | port exists; comment names MyApps/Traefik | good seam |
| `.env.edge` (`TUNNEL_TOKEN`, `CF_ACCESS_CLIENT_*`) | secrets owned by Foundry | config |

Conclusion: coupling is mostly location/convention. Traefik's seam (labels or a watched folder) is clean, so extraction is modest work.

## Reuse
- `traefik/dynamic/security.yml` (headers, rate limit, probe block) → kit middleware (copy, rename).
- `scripts/rotate_traefik_logs.sh` → kit log rotation.
- Security audit hook pattern (`scripts/run_security_audit.sh`).
