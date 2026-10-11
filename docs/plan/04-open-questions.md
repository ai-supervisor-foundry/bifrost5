---
title: Bifrost5 Edge-kit — open questions
status: OPEN (items marked DECIDED follow the 2026-10-10 reviews and operator answers)
---

# 04 — Open questions

| # | Question | Status / recommendation |
|---|----------|-------------------------|
| 1 | Repo name and location | `edge-kit`, sibling folder, own git remote (open) |
| 2 | Same domain on a new subdomain vs a separate domain for user sites | Separate domain before more than one untrusted user. Owner: this question; Shell Box Q5 links here |
| 3 | Public or private by default | Private (open) |
| 4 | Access app/policy automation in v1 | Manual in v1; automate with the `cloudflare-api` MCP later |
| 5 | How consumers pin the kit | Git tag + vendored copies; decide in Shell Box |
| 6 | Free-plan tunnel limits | Resolve in E0 |
| 7 | Docker provider in the kit | DECIDED: file provider only |
| 8 | Owner/id format | DECIDED: owner `^[a-z0-9]+$`, id `<owner>--<name>` |
| 9 | Hostname shape | DECIDED: single-level (`alice-ssh.example.com`) |
| 10 | Broken `127.0.0.1:3001` Foundry route | FIXED 2026-10-10 in `traefik/dynamic/connect-routes.yaml` (now `host.docker.internal:3001`; retest 404/401 = reaches Foundry). Not yet committed. The unmounted copy `infra/traefik/dynamic/connect-routes.yaml` still has the old URL |
| 11 | Where the kit runs for Shell Box | DECIDED: inside the shell VM (shell-box/08). The kit must therefore run without the host Docker socket or Foundry paths |
