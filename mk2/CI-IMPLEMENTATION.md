# mk2 — CI implementation plan (proposed)

Concrete first cut of the CI decision in [ADR-0001](adr/ADR-0001-ci-source-split-and-observability.md). **Nothing here is wired to your live infra yet** — these are reviewable artifacts on the `mk2-relitigation` branch.

## Decisions (owner, 2026-06-27)
- **Platform:** self-hosted GitHub Actions runners. Source stays the GitHub monorepo; build work runs on-prem.
- **Scope:** verify → build+push images → **auto-deploy to prod** on merge to `master`.

## Why this shape (the 2-core box drives it)
- **Builds run on the Hyper-V host runner (`[self-hosted, build]`), never on the 2-core prod VM.** This is the whole point — it gets `tsc`/`npm ci`/`prisma generate` off the box that swaps under them.
- **Prod VM runs only `[self-hosted, prod]` for the deploy job:** `pull` + health-gated `up -d` + rollback. No compiling.
- **Self-hosted registry** (`registry:2`, on the host/infra VM, Tailscale-reachable) holds images — no ghcr/dockerhub in the deploy path (on-prem principle).

## Artifacts in this branch
| File | Role |
|---|---|
| `.github/workflows/ci.yml` | the pipeline (verify / build-and-push / deploy) |
| `ci/docker-compose.deploy.yml` | image override so prod `pull`s instead of building |
| `ci/ci-deploy.sh` | prod-side pull + health-gate + auto-rollback |
| `ci/registry/docker-compose.registry.yml` | self-hosted `registry:2` |

> **Note:** these live under tracked `ci/` (and `.github/`), **not** `deploy/` — `deploy/` is `.gitignore`d in this repo (box-local scripts like `prod-deploy.sh`/`restore-env.sh` are managed out-of-band). CI runtime files must be version-controlled so the runner checks them out.

## Local rehearsal (2026-06-29) — what running the verify steps by hand found
- **Hard gates pass:** server `tsc --noEmit`, client `tsc -b`, `npm test` (qbXML), and **migrate-from-zero applies all 97 migrations clean** (the drift gate works).
- **eslint is the catch:** `npx eslint .` exits 1 with **548 errors** (393 `no-explicit-any`, 83 `set-state-in-effect`, …). A hard eslint gate would make the pipeline **permanently red on day one**. So `ci.yml` runs lint **`continue-on-error: true` (report-only)** — visible but non-blocking — until the backlog is burned down, then flip it to a gate.

## What the pipeline does
1. **verify** (every PR + push): **hard gates** = `tsc --noEmit` (server, 4 GB heap) + `tsc -b` (client) + `npm test` + `prisma migrate deploy` against an ephemeral Postgres (the **drift gate**). `eslint` (client) runs **report-only** (548-error backlog — see rehearsal note above).
2. **build-and-push** (master only): builds api+client images on the host runner, tags `:<git-sha>` and `:latest`, pushes to the registry.
3. **deploy** (master only): on the prod runner, `ci-deploy.sh` pulls `:<git-sha>`, swaps **only api+client** (Postgres/Redis/Caddy untouched), health-checks `/api/health`, and **rolls back to the previous tag** if it doesn't come up.

## Setup steps (one-time, on your infra — I can't reach it)
1. **Registry:** `docker compose -f ci/registry/docker-compose.registry.yml up -d` on the host. Pick a Tailscale name, e.g. `registry.<tailnet>.ts.net:5000`.
2. **Trust the registry** (if plain HTTP): add `{"insecure-registries":["registry.<tailnet>.ts.net:5000"]}` to `/etc/docker/daemon.json` on the host **and** the prod VM, then `systemctl restart docker`. (Or front it with your NPM/Let's-Encrypt edge and skip this.)
3. **Runners:** install a GitHub Actions runner on the host with label `build`, and one on the prod VM with label `prod` (Settings → Actions → Runners). The prod runner needs `docker` + repo checked out at `~/sundog`.
4. **Repo config:** set repo **variable** `REGISTRY_HOST=registry.<tailnet>.ts.net:5000` (Settings → Secrets and variables → Actions → Variables). Add registry auth as a secret only if you enable htpasswd.
5. **Server build-script fix (recommended):** set `NODE_OPTIONS=--max-old-space-size=4096` for the server build (CI already does; also fix `server/package.json`'s `build` script so a local `npm run build` stops OOM-ing — see [ADR-0009](adr/ADR-0009-dev-loop-ergonomics.md)).

## Standup (build) machine spec — measured from a local build→push rehearsal (2026-06-29)
The standup machine runs the **`build` runner + the registry**. It is **NOT** the 2-core/8 GB prod VM (that box OOMs building while serving — the whole reason we build off it) and **NOT** a new physical box — make it a **VM on the Hyper-V host** (32c/60 GB free). The `prod` runner stays on the prod VM doing only the lightweight pull+swap.

Measured on the rehearsal:
- **api image = 1.37 GB**, client image = 20.9 MB (static). Push to a local registry: **3 s**.
- api build ~**150–200 s** (needs the **4 GB heap** for `tsc` + the 220k-line generated Prisma client); client ~**55 s**.
- Docker on the dev box after a few builds: **images ~21 GB, build cache ~18 GB** (most reclaimable).

Recommended VM:
| Resource | Spec | Driver |
|---|---|---|
| **RAM** | **8 GB min, 16 GB recommended** | 4 GB-heap `tsc` + Docker daemon + build-cache working set + headroom for concurrent api/client builds |
| **vCPU** | **4 min, 8 comfortable** | `npm ci` + `tsc` + layer builds; not massively parallel, so 4 is enough |
| **Disk** | **60–80 GB** | base images (~21 GB) + build cache (~18 GB, grows) + registry blobs (api ~1.4 GB per changed build; layers dedupe across `:sha` tags) |
| **Network** | Tailscale-reachable (prod pulls from it) + github.com egress (runner polls) | |
| **OS** | Linux + Docker | matches the rest of the stack |

Housekeeping the machine needs:
- **`docker builder prune`** on a schedule — build cache hit ~14 GB reclaimable in one rehearsal session; it grows unbounded otherwise.
- **Registry GC / retention** — keep last N `:sha` tags + `:latest`; the compose already sets `REGISTRY_STORAGE_DELETE_ENABLED=true`, so run the registry GC periodically or the 1.4 GB-ish api images accumulate.

Optional follow-on (not a blocker): the **1.37 GB api image is fat** — slimming the runtime (distroless/slim base, drop the global Prisma CLI from the runtime stage, tighter prune) would cut registry storage and pull time. Tracked separately from standing CI up.

## Cutover (incremental, reversible)
1. Stand up registry + runners; let `verify` run on PRs first (pure safety net, touches nothing).
2. Once `build-and-push` is green and images are in the registry, do **one manual** pull-deploy on prod with the new compose files to prove it:
   `REGISTRY=… TAG=<sha> docker compose -f docker-compose.prod.yml -f ci/docker-compose.deploy.yml pull && … up -d`.
3. Then enable the `deploy` job. The old `deploy/prod-deploy.sh` (build-on-box) stays as the hand fallback.

## How this fixes today's pain
- **~12-min deploy / build swap:** gone — prod never compiles; it pulls. Build runs on 32c/60GB.
- **"rebuild all 5 or api loses Postgres":** gone — images carry no secrets, `.env.production` is never regenerated by a deploy, and `up -d` recreates only api+client (Postgres never cycled). The env/password divergence window closes.
- **"needs `--no-cache`" freshness:** gone server-side — prod runs the exact `:<git-sha>` image CI built. (The PWA service-worker staleness is a separate client fix — [ADR-0006](adr/ADR-0006-container-topology.md).)
- **No tests + unguarded refactors:** `verify` is the net; golden-file qbXML tests slot in here next ([ADR-0008](adr/ADR-0008-quickbooks-boundary.md)).

## ⚠️ Principle sign-off
- **Auto-deploy** (your choice) puts the running stack behind the pipeline — mitigated by the **health-gate + auto-rollback** and by keeping `prod-deploy.sh` as the human fallback, so it does not become a bad-divorce single point of failure. Confirm you're good with auto-deploy staying gated this way.
- **On-prem:** builds + registry are fully on-prem; only GitHub's orchestration touches the internet (source already lives there). No SaaS in the data or deploy path.
