# ADR-0010 — Failure observability + notification layer

- **Status:** Proposed (net-new)
- **Date:** 2026-06-27
- **Principle flags:** ⚠️ **Bad-divorce** (alerting must never gate work) and a **data-minimization** rule (below). On-prem-clean.

## Context (what exists today)
- **The failure data largely already exists**, just unaggregated: `JobRun` rows (every scheduled job records `success`/`error`/`skipped`, `services/jobs.ts`), the `*SyncQueue` tables (`status='error'` + `retryCount` for Enverus/BlueLion/QB/print), `Invoice.qbDiff*` flags, and `AuditLog`.
- **Mail is wired but dark:** `services/mailer.ts` exports `mailerConfigured` and is `null` when `MAIL_USER`/`MAIL_APP_PASSWORD` are unset — which is the prod state. So email currently fails **silently**.
- In-process `eventBus` (`services/eventBus.ts`) exists; an Ops dashboard route exists (`/admin/ops`).
- Owner symptom: "getting calls" about workflow failures (e.g., a rejected invoice) because nothing proactively tells the responsible person.

## Decision
Build a **durable-first, self-reporting** failure layer with **two audiences** (Fork A, owner-confirmed):

| Audience | Concern | Mechanism |
|---|---|---|
| **System / infra** | "oh no, it's really broken" — queue jammed, job erroring, deploy rolled back | **Zabbix.** Expose fail-points as a structured endpoint + dashboard; Zabbix polls, escalates, pages. We do **not** rebuild an escalation engine. |
| **Workflow / staff** | "go do stuff" — *Ticket #1235 rejected by QuickBooks*, sync stuck, BlueLion push failed | **In-app notification center + email**, routed to the responsible **role**. This is the deferred Notifications spine. |

## Design rules (the load-bearing parts)
1. **Durable-first.** `emitAlert(severity, source, refType, refId, message, audience)` **always writes a `Notification` row first** (no external dependency, so the record can't be the thing that fails). The dashboard reads that table — it is the always-on channel.
2. **Emitters are best-effort fan-out on top, and pluggable** (in-app = the row itself; email; future webhook). A channel failure never fails the emit.
3. **Channels self-report health on the dashboard.** Surface `mailerConfigured` and each emitter's last-success/last-failure: "mail: NOT CONFIGURED", "email: last send failed 14:32". **A dead channel must be visible, not silent** — this is the direct fix for today's silent-mail trap.
4. **⚠️ Data-minimization (owner policy):** notification content is **references only** — "Ticket #1235 rejected", *never* the ticket's business data/PII. Actionable detail lives behind an **authenticated click-through into the app**. Applies to all channels, strictly to email (it leaves the building). Captured as a first-class rule, enforced in the message builders.
5. **Notify-on by default, but tiered so it doesn't bury (owner policy + refinement):** default = ON. To honor "nobody wants to be buried in emails," tier by severity: **actionable/high → immediate**; **informational → daily digest**; per-user opt-out + cadence in `User.notificationPrefs` (JSON, same pattern as `dashboardWidgets`). In-app is always written regardless; email respects prefs **and** `mailerConfigured`.
6. **Bad-divorce:** alerting is auxiliary — it never blocks a primary action. Durable row + dashboard is the guaranteed floor; push is best-effort; a failed channel flags itself and work continues.

## Sketch
```
model Notification {
  id          String   @id @default(uuid())
  createdAt   DateTime @default(now())
  severity    NotifSeverity      // info | warn | error | critical
  category    String             // qb_reject | sync_stuck | bluelion_fail | ...
  audienceRole UserRole?         // role-routed
  userId      String?            // or user-specific
  refType     String?            // "ticket" | "invoice" | ...
  refId       String?            // "1235"  -> click-through
  message     String             // reference-only text, NO business data
  readAt      DateTime?
  channelsSent Json?             // { inapp:true, email:"sent|skipped|failed@ts" }
  @@index([audienceRole, readAt])
}
// User.notificationPrefs Json?  -> per-category { channel, cadence }
```
- `emitAlert` hangs off the existing `eventBus`/queue-error paths — wire it where rows already turn `error` (qbwc response handler, the queue processors, the QB diff watcher).
- **System audience** = a read endpoint (`/api/ops/failpoints`) aggregating JobRun + `*SyncQueue` error counts for Zabbix to poll; plus the `/admin/ops` panel.

### First concrete monitor: QBWC liveness watchdog
The motivating case. QuickBooks **Desktop** fails *environmentally and silently* — the Web Connector stops polling when the admin user is logged in, when the host VM idles too long, or for no discernible reason ("a particular shade of orange in the southern sky on a Tuesday"). **None of it is a payload problem** ([ADR-0008](ADR-0008-quickbooks-boundary.md) golden tests cover payload correctness; they cannot catch this). The failure mode is **absence**, discovered far too late: "we haven't seen invoices in days" → "the QWC's been offline a week."

The watchdog detects *quiet*, not bad XML:
- **Heartbeat:** bump `lastQbwcContactAt` on every QBWC `authenticate`/poll. If `now − lastQbwcContactAt` exceeds a threshold **during business hours**, raise a **critical** alert (Zabbix page + dashboard) — "haven't gotten a 200 out of QBWC lately, everything OK?". Catches it in ~an hour, not a week.
- **Stuck session:** queue entries in `sent` that never received a response past a timeout = a mid-session silent death → alert.
- Cheap to build: computes off `QbSyncQueue.sentAt`/`completedAt` (already there) + one timestamp; rides an existing `setInterval` job. This is the first monitor to ship.

## Migration cost / risk / effort
- **Slice 1 — dashboard over existing data:** Low. Aggregate JobRun + queue error rows into an `/admin/ops` fail-points panel. Works today, zero external deps. Highest value-per-effort.
- **Slice 2 — `Notification` table + `emitAlert` + in-app center:** Medium. Additive; pure write + read.
- **Slice 3 — email channel + per-user prefs:** Low-Medium, gated on `MAIL_USER`/`MAIL_APP_PASSWORD` being set (5-min Google Workspace app password — see [ADR-0001](ADR-0001-ci-source-split-and-observability.md) / prod notes).
- **Slice 4 — Zabbix triggers on `/api/ops/failpoints`:** Low, ops-side config.

## Verdict: **BUILD (net-new), sliced.**
> Durable-first with self-reporting channels — so the layer can't lie about its own health (the trap that makes "alerts on broken email" worse than nothing). Zabbix owns "really broken"; in-app + opt-out-tunable email owns "go do stuff." Messages are reference-only by policy; detail is behind an authenticated click. Start with the dashboard over data you already have.
