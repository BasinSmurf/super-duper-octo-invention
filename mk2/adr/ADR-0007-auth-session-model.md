# ADR-0007 — Auth / session model

- **Status:** Proposed
- **Date:** 2026-06-27
- **Principle flags:** None (stateless JWT actively *helps* the split and bad-divorce).

## Current state (file evidence)
- **Stateless JWT**, Bearer header only, no cookies, **no refresh tokens**, 24h expiry, `JWT_SECRET` (`middleware/auth.ts:19-40`). No server-side session store anywhere.
- Three human logins (`routes/auth.ts`): password (bcrypt), **PIN** for field devices (bcrypt), **Google Workspace SSO** (domain-locked, auto-provision + role-sync from Google Groups).
- **Kiosk/device auth** (`middleware/kioskAuth.ts`): `X-Kiosk-Token` → DB lookup of `Kiosk.apiToken`, **stored plaintext**.
- **v1 API auth** (`v1/auth.ts`): `sp_*` keys **sha256-hashed**, scoped, optional IP allowlist, `timingSafeEqual`; or staff JWT.
- Roles: `field_tech | dispatch | field_super | billing_ar | boss | platform_admin` + `customer` (portal) + kiosk roles. RBAC matrix is code-default + a DB `PermissionConfig` row, merged and **cached in memory** (`services/permissions.ts`).
- `cors()` is **wide open** (`index.ts:98`).

## Why it was likely chosen
Stateless JWT is the path of least resistance and the right one for an offline-first field app (a tech's token keeps working with no auth server reachable). PIN/SSO/kiosk paths each map to a real user population (gloved techs, office staff, wall tablets). The v1 key store is visibly the most carefully-built auth surface — newer and better than the core.

## The case to replace
- No refresh tokens → 24h hard expiry; a tech mid-job at hour 25 re-authenticates. Minor for the workflow.
- **Inconsistency, not architecture:** the v1 surface hashes keys + constant-time compares + IP-allowlists, while **kiosk tokens are plaintext in the DB** and login endpoints have **no rate-limit** (PIN brute-force surface, mitigated only by bcrypt cost). `cors()` allows any origin.
- The in-memory matrix cache is a split hazard ([ADR-0006](ADR-0006-container-topology.md)).

## The case to keep
- Stateless JWT is **exactly right** for both offline-first *and* the coming instance split — no shared session store to coordinate, any instance validates any token. This is a load-bearing-correct call; confirm it, don't touch it.
- bcrypt PIN/password, Google domain-lock, scoped v1 keys are all sound.

## Migration cost / risk / effort
- Keep the model. Harden specifics, all **Low** effort:
  1. **Hash kiosk `apiToken`** (sha256, like v1 keys) — small migration + token re-issue.
  2. **Rate-limit `/api/auth/*`** (login + PIN) — a few lines; move the bucket to Redis when split.
  3. **Lock `cors()`** to an origin allowlist (the PWA origin + kiosks).
  4. **Matrix-cache invalidation** over a Redis channel before the split.
  5. Optional: short-lived access + refresh token if hour-25 re-auth becomes a real complaint (defer).

## Verdict: **KEEP** the model; harden the implementation.
> Stateless JWT is the correct backbone for offline-first *and* multi-instance — this is a good call, confirmed. The gap is consistency: bring kiosk tokens, login rate-limiting, and CORS up to the standard the v1 key store already sets.

> **Extended by [ADR-0011](ADR-0011-self-service-credentials-sso-failover.md):** self-service local credentials as the Google-SSO failover — `field_tech` self-set 4–6 digit PIN (recurring skippable nudge, never a hard gate; 5-try/30-min lockout), office/admin password-only, and a **mandatory break-glass admin credential** so a Google outage can't lock you out of your own system. The "rate-limit `/api/auth/*`" item above is specified there.
