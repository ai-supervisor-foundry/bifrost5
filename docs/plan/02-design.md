---
title: Bifrost5 Edge-kit — design
status: PROPOSED (review fixes applied 2026-10-10)
---

# 02 — Design

```
 producer -> edgectl -> [RouteSpec + policy] -> lock -> store -> renderer
                                                                   |
                                                                   v
                                                  dynamic/*.yml (flat folder)
 Internet -> Cloudflare Access -> tunnel -> Traefik (file provider ONLY)
                                              +--(IP allow-list only)--> target
 Trust boundary: edgectl validates. Nothing else writes to dynamic/.
```

## Layers (hexagonal)
- **Domain (pure):** `RouteSpec` shape and validation, naming rules.
- **Application:** `register`, `unregister`, `list`, `reconcile`; **rate limit and per-owner cap** (they need state and a clock, so they sit here behind a `QuotaStatePort`, not in the domain).
- **Ports:** `RouteStorePort`, `RouteRenderPort`, `TunnelIngressPort`, `DnsPort`, `AccessPort` (optional), `QuotaStatePort`.
- **Adapters (first):** file store (`desired/<owner>/<id>.json`), Traefik file renderer, Cloudflare ingress adapter, Cloudflare DNS adapter (CNAME), Cloudflare Access adapter (manual in v1).

## Kit contents
`compose.yml` (cloudflared + Traefik; own project name, own network), `dynamic/security.yml`, `dynamic/` (generated, **flat**), `desired/`, `edgectl`, `scripts/` (vendored copies of the Foundry probes, see infra-validation-kit), `check-standalone.sh` (vendored from K6).

## RouteSpec (JSON)
```json
{ "id": "alice--blog", "owner": "alice", "host": "sites.example.com",
  "pathPrefix": "/p/alice--blog/", "target": "http://10.20.0.5:3000",
  "access": "private", "stripPrefix": true }
```

## Safety rules (enforced by the kit, not by callers)
1. `owner` matches `^[a-z0-9]+$` (no `-`). `id` is `<owner>--<name>` where `name` matches `^[a-z0-9][a-z0-9-]{0,38}$`. This stops owner `alice` from taking names inside owner `alice-bob`.
2. `pathPrefix` is **derived** (`/p/<id>/`). The caller never sets it.
3. Reserved owners and ids (configurable, default `foundry*`, `apps`, `admin`, `api`, `control`, `connect`) can never register. Path-based reservation is not used, because the path is always `/p/<id>/`.
4. `host` comes only from an operator allow-list. The renderer uses a YAML **serializer**, never string templates, and rejects backticks and non-hostname characters.
5. `target` must be an **IP literal** inside an owner-allowed CIDR. DNS names are rejected (stops DNS-rebinding and check-time/use-time gaps). No loopback, no host gateway.
6. Per-owner route cap and registration rate limit (application layer).
7. Writes are atomic: temp file with a non-`.yml` extension, then rename. A malformed spec never reaches the folder. Router and service names are prefixed with the `id` to avoid name clashes.
8. All state-changing commands and the tunnel update run under a local `flock`.
9. The security middleware is always in the chain. Callers cannot drop it.
10. `reconcile` is idempotent and removes orphans.

## Traefik provider choice
**File provider only.** The Docker provider and socket are not part of the kit. A container with labels would bypass the kit's rules. Foundry's preview script moves to `edgectl register` in E7. Route files are written flat in the watched folder (a subfolder may not be watched, VERIFY in E0). One bad file may stop all dynamic updates (VERIFY), so validation before rename is mandatory.

## Access model
Cloudflare Access applies at the edge per hostname and path. The kit does not provide an "access middleware". For private routes, Traefik additionally verifies the `Cf-Access-Jwt-Assertion` header (audience tag configured per route), so a request that bypasses the edge is refused. Public routes opt in per owner.

## Tunnel ingress and DNS
- `/p/` routes on an existing hostname need no tunnel change.
- A new hostname needs an ingress rule **and** a DNS CNAME (`DnsPort`). Use **single-level** hostnames (`alice-ssh.example.com`) so free Universal SSL covers them.
- The ingress endpoint (`PUT …/cfd_tunnel/{id}/configurations`, VERIFY) replaces the whole list and has no ETag. The helper runs GET → merge one rule → PUT under `flock`, keeps the catch-all last, and refuses if the GET fails.

## Isolation and flags
Own compose project, network and tunnel token (mode 600, never printed). Docker/host firewall: allow kit Traefik → target network only. Flag `EDGEKIT_ENABLED=0` default; Foundry-side migration flag `FOUNDRY_EDGEKIT_ENABLED=0`.
