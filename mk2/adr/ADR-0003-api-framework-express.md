# ADR-0003 — API framework: Express vs Fastify / Hono / NestJS

- **Status:** Proposed
- **Date:** 2026-06-27
- **Principle flags:** None.

## Current state (file evidence)
- **Express 4.21.2** (`server/package.json`). ~35 routers mounted in `server/src/index.ts:106-198`, almost all behind one global `authenticate` middleware.
- `express-async-errors` 3.1.1 monkey-patches Express 4 so async route rejections reach the error middleware (`index.ts:2`).
- **Complexity lives in the route files, not the framework:** `routes/invoices.ts` 97 KB, `routes/locations.ts` 86 KB, `routes/sync.ts` 81 KB, `routes/enverus.ts` 79 KB, `routes/shopOrders.ts` 69 KB, `routes/tickets.ts` 67 KB, `routes/qbwc.ts` 65 KB. Domain logic is inline in handlers; the `services/` layer exists (56 files) but the biggest logic blobs are still routes.
- `helmet` + hand-written CSP, `cors()` **with no origin allowlist**, `morgan`, `zod` available for validation.

## Why it was likely chosen
Express is the default-default for Node + the largest ecosystem + every Prisma/QBWC/Stripe example is written for it. For a solo dev shipping fast, "the one everybody knows" is the correct, boring choice.

## The case to replace
- **Fastify:** ~2–3× throughput, first-class JSON-schema validation + serialization, structured logging (pino) built in, native async error handling (no monkey-patch).
- **Hono:** tiny, fast, great TS ergonomics, edge-portable.
- **NestJS:** would impose the module/provider structure this codebase is *missing* (it would force logic out of route files into providers).
- Express 4 is in maintenance; the monkey-patch is a smell; `cors()` is wide open.

## The case to keep
- **Express is not the bottleneck.** This is a LAN app serving dozens of staff + a QBWC poller, not a high-RPS service. Framework throughput is irrelevant to the felt "lumbering," which is bundle size and god-files ([ADR-0005](ADR-0005-frontend-architecture.md), [ADR-0009](ADR-0009-dev-loop-ergonomics.md)).
- A framework swap would mean rewriting 40k LOC of handlers with **zero test coverage** to catch regressions — maximum risk for a perf win the workload will never notice. Textbook novelty-chasing.
- The thing NestJS would "give" (logic out of routes) can be obtained directly by extracting a service/use-case layer **under Express**, with none of the rewrite.

## Migration cost / risk / effort
- **Full swap (Fastify/Hono/Nest): High / High / wasted.** Refusing.
- **Express 4 → Express 5: Low.** Express 5 handles async rejections natively → delete `express-async-errors`. Mostly drop-in; a few breaking changes (path-to-regexp, removed methods). Worth doing opportunistically, not as a campaign.
- **The real work (decompose routes into a service layer): Medium, and framework-independent.** This is the high-value move and it does *not* require leaving Express.

## Verdict: **KEEP** (Express); **REPLACE-LATER** the version (4→5) opportunistically.
> Express is correct for this workload; the drag is logic-in-routes, not the router. Spend the effort extracting handlers into a tested service layer under Express — and tighten `cors()` to an origin allowlist while you're in there.
