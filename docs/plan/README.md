---
title: Edge Kit — standalone tunnel + router + route-registration product
status: PROPOSED 2026-10-10 (nothing built); Opus design review 2026-10-10: approve with changes (changes applied); VERIFY items resolved in task E0
summary: Extract the Cloudflare tunnel + Traefik edge pattern into a standalone, reusable kit with a single "register a route" contract. First consumer is the Shell Box; Foundry's own edge is rebuilt on it later.
created: 2026-10-10
---

# Plan: Edge Kit

Part of three plans (see [shell-box](../shell-box/README.md), [infra-validation-kit](../infra-validation-kit/README.md)).

## Goal
One small, standalone repo that gives any product: a Cloudflare tunnel connector, a Traefik router with shared security middleware, a watched folder of route files, and ONE way to register/unregister a route safely (`edgectl`). No Foundry imports, no Foundry names.

## Why
Today the edge lives inside the Foundry repo (`docker-compose.edge.yml`, `traefik/dynamic/*`). Foundry-generated app previews auto-register (Docker labels), but every other app needs a hand-written route file, a manual `sudo ufw` rule and a dashboard-made DNS/Access app. That gap is the "half baked" part. See [01-context](./01-context.md).

## Scope
- In: compose project, security middleware, route-spec schema, `edgectl` (register/unregister/list/reconcile), tunnel-ingress merge helper, standalone check, validation scripts.
- Out: SSH, VMs (Shell Box), Foundry-specific routes (they become route files Foundry drops in later), Cloudflare Access app creation beyond a documented helper.

## Files
| File | Content |
|------|---------|
| [01-context.md](./01-context.md) | Verified current state and coupling inventory |
| [02-design.md](./02-design.md) | Kit contents, route contract, ports, safety rules |
| [03-tasks.md](./03-tasks.md) | Tasks with acceptance criteria + validation commands |
| [04-open-questions.md](./04-open-questions.md) | Decisions needed from the operator |

## Order
First product to build (E0–E5), started at once, together with the research tasks and the 3 small probe tasks it needs (K1, K6). The Shell Box host steps wait for E4; see [../shell-box/09-build-order.md](../shell-box/09-build-order.md). Foundry migration (E7) is deferred.

## Rules
- AGENTS.md rules apply (propose-only until approved, BACKUPS/ before replace, no push to main, shell-tool mandates).
- Living docs under `supervisor-contexts/` must not link to this plan (rule 8); document the kit there only after it ships.

## Cross-plan links
> **Link rule:** if a linked plan path 404s or its status reads DONE/ARCHIVED, it has moved to [`../done/`](../done/) — look there (and in `../README.md` "Recently shipped") before assuming it is missing. Re-check the linked plan's status before relying on it.

| Plan | Relation |
|------|----------|
| [shell-box](../shell-box/README.md) | First consumer of this kit |
| [infra-validation-kit](../infra-validation-kit/README.md) | Probes and task template used by E-tasks |
| [cloud-provider-byoc](../cloud-provider-byoc/README.md) | Cloud-box edge variant (`docker-compose.cloud-edge.yml`) must keep working when Foundry migrates (E7) |
| [done/myapps](../done/myapps/README.md) | Origin of the current edge (Traefik, previews) |
| [saas-tenant-deployments](../saas-tenant-deployments/README.md) | Per-tenant edge/hostname concerns overlap |
| [static-asset-caching](../static-asset-caching/README.md) | Touches Traefik middleware and the Cloudflare edge |
| [app-factory](../app-factory/README.md) | 04-wiring-and-hosting: how kit-built apps are hosted |
| [done/nomad-cloud](../done/nomad-cloud/README.md) | Origin of the cloud-edge variant |
| [done/foundrylander-foundry-connection](../done/foundrylander-foundry-connection/README.md) | Connect routes on the edge |
| [sample-plan-tunnel-product](../sample-plan-tunnel-product/README.md) | Overlaps shell-box (superseded draft) |
