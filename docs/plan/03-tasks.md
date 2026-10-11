---
title: Bifrost5 Edge-kit — tasks, acceptance criteria, validation
status: PROPOSED (review fixes applied 2026-10-10)
---

# 03 — Tasks

K = [infra-validation-kit](../infra-validation-kit/02-tasks.md) task. E0–E3 need no probes. Build order across all plans: [../shell-box/09-build-order.md](../shell-box/09-build-order.md).

Small, timeout-safe tasks (`.agents/skills/task-breakdown/SKILL.md`). Foundry runs one `test_command` per task (exit 0 = pass); use wrappers like `! probe …` for expected failures. Validation runs through `scripts/run_summary.sh`. Host-mutating steps need explicit operator approval.

| ID | Depends | Task | Acceptance criteria | Validation |
|----|---------|------|---------------------|-----------|
| E0 | — | Verify claims: free-plan tunnel count; tunnel config API (GET/PUT, no ETag); Traefik file provider (subfolder watching, bad-file behaviour); `Cf-Access-Jwt-Assertion` verification options; single-level SSL coverage | `edge-kit/05-findings.md` lists each claim true/false with source | `grep -c VERIFY edge-kit/*.md` = 0 |
| E1 | E0 | Repo skeleton: compose (own project name), middleware copied from `security.yml`, README | Project name not `foundry*`; no Docker provider or socket mount | `docker compose -f compose.yml config -q`; `grep -c docker.sock compose.yml` = 0 |
| E2 | E1 | Domain rules 1–5 | Table tests (≥20): bad owner/id, `alice` vs `alice-bob` collision, reserved ids, backtick in host, DNS-name target, foreign CIDR all rejected | `bats tests/domain` |
| E3 | E2 | `edgectl register/unregister/list/reconcile`, atomic write, `flock`, rate limit/cap in application layer | register twice = same result; concurrent registers do not corrupt; orphan removed | `bats tests/edgectl` |
| E4 | E3, K1 | Traefik file renderer (serializer) + security middleware + Access JWT check for private routes | Golden-file test; Traefik loaded in a container lists the router at `/api/http/routers`; request without JWT to a private route is refused | `scripts/probe_http_expect.sh` (vendored from K1) |
| E5 | E0, K1 | Tunnel-ingress merge helper (GET→merge→PUT) + DNS CNAME adapter, `--dry-run` | Dry-run prints diff; existing rules kept; catch-all last; aborts on GET failure; concurrent run blocked by lock | mocked-API tests + one read-only GET against the real API (`probe_ingress_merge.sh`, K1) |
| E6 | E1, K6 | Standalone check, log rotation, audit hook | Zero Foundry names/imports; logs rotate | vendored `check-standalone.sh` (from K6) exits 0 |
| E7 | E0–E6 | (Deferred) Migrate Foundry onto the kit behind `FOUNDRY_EDGEKIT_ENABLED=0`: preview scripts call `edgectl`; fix or drop the broken `127.0.0.1:3001` route | Previews still auto-register with flag on; `foundry`/`apps` hosts unchanged; flag off = current behaviour | existing preview tests + edge smoke |

## Definition of done (E0–E6)
A producer registers `{owner, name, ip:port}`. Within seconds `https://<host>/p/<owner>--<name>/` serves the target through Traefik behind Cloudflare. Registering `foundry--x` or a colliding id is refused. A private route without an Access token is denied. Unregister removes the route. Evidence: probe logs from the vendored `probe_http_expect.sh`.
