# ADR-0001 — CI, source/build split, and observability

- **Status:** Proposed (net-new — this decision was *aspirational*, never recorded; the brief referenced an "ADR-0001" that does not exist in the repo)
- **Date:** 2026-06-27
- **Principle flags:** ⚠️ Touches **on-prem** (CI runners) and **bad-divorce** (observability must not gate work). Requires sign-off.

## Current state (file evidence)
- **No CI exists in the repo.** No `.github/workflows`, no `.gitlab-ci.yml`, no `.gitlab/`. There is no ADR directory; `grep ADR-0001` matches only `node_modules`. The "GitHub source + GitLab CI split" and "Zabbix" in the brief are aspirational.
- **Deploy is hand-run shell:** `deploy/prod-deploy.sh`, `deploy/deploy.sh`, `deploy/server-setup.sh`, `deploy/restore-env.sh`; migrations apply on container start (`server/docker-entrypoint.sh` → `prisma migrate deploy`).
- **Quality gate = none.** Zero tests in either package (no vitest/jest/playwright, no `*.test`/`*.spec`). ESLint 9 flat config exists on the client only.
- **Observability = homemade.** `console.*` teed to `logs/server.log` (`server/src/index.ts:71-82`) + `morgan('dev')` + an in-app Ops dashboard (`routes/dashboard.ts`, `/admin/ops`). No metrics, no tracing, no error-tracking lib in either `package.json`.

## Why it was likely chosen
Speed. 339 commits in 3.5 months by what reads as a solo/very-small team shipping to one customer. CI and observability are the first things skipped when the deploy loop is "SSH in, `down && up -d --build`" and the developer *is* the monitoring. That was rational at this stage; it stops being rational the moment a second API instance (the planned split) or a second developer exists.

## The case to build it now
- The **instance split is on the roadmap** (confirmed). The moment prod is multi-instance, "the dev watches the logs" stops working, and several current in-memory assumptions (event bus, QBWC session map, rate limiter) become *silent* correctness bugs (see [ADR-0006](ADR-0006-container-topology.md)). You need metrics to even see them.
- **Zero tests + 40k LOC of logic-in-routes + no CI** means every refactor in this mk2 effort is unguarded. CI is the safety net that makes the rest of mk2 affordable.
- A schema-drifted dev DB (README) means migration mistakes already reach prod by hand. A CI step that runs `migrate deploy` against an ephemeral Postgres catches drift before it ships.

## The case to keep (do nothing)
- It works today, single-instance, one operator who knows the system cold.
- CI/observability is pure overhead until there's something to protect (tests) or someone to alert (on-call). Building elaborate observability before the split is speculative.
- **Real risk of over-building:** a Prometheus+Grafana+Loki+alertmanager stack is four more containers to babysit on-prem — the opposite of reducing lumbering.

## Migration cost / risk / effort
- **CI:** Low. A self-hosted runner (Gitea Actions, GitLab CE runner, or a self-hosted GitHub Actions runner on a VM) + a 30-line pipeline: `tsc` both packages, `eslint`, and `prisma migrate deploy` against a throwaway Postgres. Effort: ~1 day. The hard prerequisite is *having something to test* — see sequencing.
- **CI also builds the deploy images** (this is the big one given prod is a **2-core/8 GB box**, [ADR-0009](ADR-0009-dev-loop-ergonomics.md)): the runner builds the api/client images and pushes them to a **self-hosted registry** (`registry:2` container or the runner's built-in registry, on-prem). Prod then `docker pull && up -d` instead of compiling TypeScript on a box with no spare CPU/RAM. This moves the ~12-min build off prod and removes the deploy-freshness ambiguity ([ADR-0006](ADR-0006-container-topology.md)).
- **Observability:** Low-to-medium and incremental. Swap `console.*` for `pino` (structured JSON) — half a day, mechanical. Add a `/metrics` endpoint and point the **already-chosen Zabbix** at it (Zabbix can poll HTTP/JSON natively; no new container). Avoid a full PLG stack until justified.
- **Risk:** Low. Both are additive and degradable.

## Verdict: **REPLACE (build net-new), phased**
> Build CI and structured logging *before* the instance split, not after — but keep observability lean (pino + Zabbix HTTP checks), and gate nothing on it.

**Principle reconciliation for sign-off:**
- **On-prem:** CI runners must be **self-hosted on a VM**, not hosted GitHub Actions, to honor "no SaaS in the critical control path." (Hosted runners are the convenient alternative; flagging because using them would put deploys behind a SaaS — your call.)
- **Bad-divorce:** Zabbix/metrics are observation-only and must never block a deploy or a work action. CI may *gate merges to main* but a human must always be able to deploy by hand (`prod-deploy.sh` stays).
