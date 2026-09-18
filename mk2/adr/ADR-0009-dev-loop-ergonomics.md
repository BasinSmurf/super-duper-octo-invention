# ADR-0009 — Dev-loop ergonomics & build times

- **Status:** Proposed
- **Date:** 2026-06-27
- **Principle flags:** None.

## Current state — measured on this machine (2026-06-27)

| Step | Command | Time | Notes |
|---|---|---|---|
| Client production build | `npm run build` (`tsc -b && vite build`) | **39 s** | `vite build` alone = **11.4 s**; the other ~28 s is `tsc -b` |
| Server build (correct) | `NODE_OPTIONS=--max-old-space-size=4096 tsc` | **33 s** | succeeds |
| Server build (as scripted) | `npm run build` (plain `tsc`) | **OOM, exit 134 @ ~27 s** | **the npm script has no heap flag — it crashes** |
| API image — cold | `docker build --no-cache ./server` | **150 s** | npm ci + prisma generate + heap-bumped tsc + prune + stage-2 global prisma reinstall |
| API image — warm | `docker build ./server` (no source change) | **3 s** | full layer cache hit |
| Client image — cold | `docker build --no-cache ./client` | **66 s** | npm ci + `npm run build` baked into a layer |

- **Inner loop (HMR) is fine and *not* the problem:** dev runs native (`tsx watch src/index.ts` server, Vite HMR client); Docker holds only Postgres+Redis. No Docker in the edit-save-see loop.
- **The deploy-build pain is `--no-cache`, not Docker per se.** Cold api+client ≈ **216 s (~3.6 min)** on this box; warm api is **3 s**. The owner reports being forced to `--no-cache` because plain `--build` "sometimes doesn't uptake" — i.e. a **cache-correctness bug is driving a ~50× build-time penalty** (3 s → 150 s for the api alone). See [ADR-0006](ADR-0006-container-topology.md) deploy-freshness note. The reported "~12 min" likely adds cold base-layer pulls, all 5 services, and the 60 s health `start_period` on top.
- Dominant cold costs (from `--progress=plain`): `npm ci`, `prisma generate` (emits the **220 K-line** TS client), the heap-bumped `tsc`, and the stage-2 `npm install -g prisma@<matched>` reinstall.

## Root causes (evidence-backed)
1. **The generated Prisma 7 client (220 K LOC) is the heap + typecheck sink.** The Dockerfile literally comments "tsc + the large generated Prisma 7 client exceed Node's default ~2 GB heap and OOM." That same client is why local `tsc` OOMs and why `tsc -b` dominates the client/server build wall-time.
2. **Type-checking is on the deploy critical path.** Both packages run a full `tsc` to *emit*, so a slow/again-OOM type-check blocks shipping.
3. **`server` `build` script is simply wrong** — missing the heap flag the Dockerfile compensates for. Anyone running `npm run build` locally hits the OOM.

## The case to change vs keep
- **Keep:** native inner loop (correct — HMR isn't slow), multi-stage Docker build, `tsc` as the type authority. None of these should change.
- **Change:** get type-checking *off the emit/deploy path* and tame the generated-client cost. These are config fixes, not tool swaps.

## Migration cost / risk / effort — all Low, high payoff
1. **Fix the server `build` script** to include `--max-old-space-size=4096` (or set it in `.npmrc`/`NODE_OPTIONS`). One line. Stops the local OOM.
2. **Split transpile from typecheck.** Emit with esbuild/`vite build` (fast, no full typecheck) and run `tsc --noEmit` as a **CI gate** ([ADR-0001](ADR-0001-ci-source-split-and-observability.md)) rather than in the deploy build. Removes the 30 s+ type-check (and the OOM class) from the critical path.
3. **`incremental: true` + persisted `tsBuildInfo`** so local/CI type-checks are warm, not cold.
4. **Docker:** cache `node_modules` and the Prisma engine layers aggressively (the `--mount=type=cache` is already there for npm); avoid the stage-2 global Prisma reinstall by copying the CLI from stage 1. Normal (cached) deploys should land well under the cold `--no-cache` figure.
5. Confirm `skipLibCheck: true` so the generated client's `.d.ts` isn't deep-checked.

## ⚠️ Prod is a 2-core / 8 GB box — so the real fix is "don't build on it"
The owner deploys via `docker compose up --build` **on the prod box**. On 2 cores / 8 GB, the build (`npm ci` + `prisma generate` + `tsc` at a **4 GB** heap) contends with the running Postgres + live API + Redis + Caddy. A 4 GB Node heap on an 8 GB box that also wants Postgres page cache **swaps** — this is the dominant cause of the felt "~12 min," not compile cost (a dev box does it cold in 150 s). It's also a live OOM risk during deploy.

**Therefore the highest-leverage build fix for this hardware is to move the build off the prod box entirely:** CI builds images → self-hosted registry → prod `docker pull && up -d`. Prod stops running `tsc`/`npm ci` altogether; deploys become seconds. See [ADR-0006](ADR-0006-container-topology.md) and [ADR-0001](ADR-0001-ci-source-split-and-observability.md).

## Verdict: **REPLACE-LATER** (config + move build off-box; no tool changes).
> Inner loop is fine. Two fixes, in order: (1) **move the build off the 2-core prod box** to CI + a local registry — this kills the slow deploy *and* the OOM risk *and* the freshness ambiguity at once; (2) fix the OOM-ing server `build` script (1 line) and move `tsc` to a CI gate (transpile-only on the image build). No bundler/compiler swap — that's effort in the wrong place ([ADR-0004](ADR-0004-frontend-build-vite.md)).
