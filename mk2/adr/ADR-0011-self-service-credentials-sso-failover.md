# ADR-0011 — Self-service credentials as SSO failover

- **Status:** Proposed (net-new; extends [ADR-0007](ADR-0007-auth-session-model.md))
- **Date:** 2026-06-27
- **Principle flags:** ⚠️ **Bad-divorce** — Google SSO is an external dependency on the *login* path; this ADR is the graceful-degradation story for it. Requires the break-glass rule below.

## Context (what exists today)
- Login paths: password (bcrypt `passwordHash`), PIN (bcrypt `pinHash`, `routes/auth.ts:62` — field iPads), Google SSO (`google-auth-library`, domain-locked).
- **Credential setting is admin-only:** `PUT /api/users/:id/pin` and `PUT /api/users/:id/password` ("set by admin"). There is **no self-service** path — no `/me/pin`, no `/me/password`.
- **`/api/auth/pin` has no rate-limit / lockout** (confirmed; the ADR-0007 flag).
- `User` already has `pinHash`, `passwordHash`, `email`, `phone`, role.

**The bad-divorce hole:** if Google goes down and a user never had a local credential set *by an admin*, they cannot log in. And if no `platform_admin` has a local credential, **nobody can get in to fix it** — total self-lockout.

## Decision (owner-specified parameters)
Make local credentials **self-service and pre-provisioned**, split by role:

| Role group | Local failover credential | Provisioning |
|---|---|---|
| **`field_tech`** | **PIN, 4–6 digits** (minimal exposure, easiest field load) | **First-login gate:** "pick a 4–6 digit PIN." Self-change via `PUT /me/pin`. |
| **office / dispatch / super / billing / boss / `platform_admin`** | **Password only** (no PIN) | Nudge to set a failover password while SSO works; self-set via `PUT /me/password`. |

### The non-negotiable rules
1. **⚠️ Break-glass admin (the most important rule):** at least one `platform_admin` **must always have a working local password**. Enforce it — seed an admin password at setup, and **refuse to remove/blank the last admin local credential**. Without this, a Google outage locks you out of your own system, including the account that would fix it.
2. **Pre-provision while SSO works — via a recurring NUDGE, never a hard gate.** A failover you can only set *through* Google is useless during a Google outage, so it must get set ahead of time. But a hard "set your PIN before you continue" gate would fire at the worst moment — a tech reopens the app *at the site, offline, mid-job* and is blocked (owner: "100% of the team will lose their minds"). That violates [[feedback_zero_field_prep]]. Instead: a **skippable nudge shown every app-open**, mildly annoying, that **persists until the credential is set once** and then never appears again. Non-blocking; nags rather than gates. Same mechanism for tech (PIN) and office (password).
3. **PIN hardening (now mandatory — PIN is a real, public-facing login path):**
   - **Lockout: 5 failed attempts → 30-minute lock** (owner-specified), per account. Track `failedPinAttempts` + `pinLockedUntil` on `User` (durable, survives restart; Redis optional later).
   - 4–6 digit space is small; lockout — not bcrypt cost alone — is what stops brute force.
   - Also throttle `/api/auth/login` (password) with a comparable backoff, since it's now the office failover path.
4. **Scope discipline:** PIN exists for `field_tech` **only**. Office/admin PIN endpoints are removed/disabled — smaller attack surface, simpler policy.

## Sketch
- `User`: add `failedPinAttempts Int @default(0)`, `pinLockedUntil DateTime?`.
- `POST /api/auth/pin`: before bcrypt compare, reject if `pinLockedUntil > now`; on fail increment + maybe set lock; on success reset counter. Reject for non-`field_tech` users.
- `PUT /api/auth/me/pin` (self, any current session) — `field_tech` only, validates 4–6 digits.
- `PUT /api/auth/me/password` (self) — all roles.
- `/auth/me` returns `mustSetPin` (tech, no `pinHash`) / `shouldSetBackupPassword` (office, no `passwordHash`). Client shows a **skippable, recurring nudge** on every app-open while either flag is true — never a blocking gate (a hard gate would trap a tech offline at the site). Mounted in `AuthProvider` so it needs no routing/App.tsx change.
- Setup/seed: ensure ≥1 admin `passwordHash`; guard against removing the last one.

## Migration cost / risk / effort
- **Low-Medium.** Primitives (bcrypt, `pinHash`/`passwordHash`, `/auth/me`) already exist; this is self-service endpoints + lockout columns + the recurring nudge + the break-glass guard. Two small migrations (`failedPinAttempts`, `pinLockedUntil`).
- **Risk:** low, but the break-glass guard must be tested (don't ship a path that can blank the last admin credential).

## Verdict: **BUILD (net-new), do early.**
> This is a bad-divorce hole in the *login* path — small to fix, expensive to discover during an actual Google outage. Tech = self-set 4–6 digit PIN (recurring skippable nudge, never a hard gate; 5-try/30-min lockout); office/admin = self-set password; **always keep one break-glass admin local credential**. Pre-provision while SSO works, because you can't bootstrap a failover during the outage it exists for.
