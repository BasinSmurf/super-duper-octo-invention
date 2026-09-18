# Sundog — ServicePRO

Field-service platform for Basin Safety: field tickets, safety-equipment service,
shop work orders, rentals, training, billing, and a company-scoped customer portal.

Reviewed 2026-09-17 against local source through **45b3d44 (2026-09-16)**.
The workflow reference also covers uncommitted work present on September 17.
This is a source audit, not confirmation of the version running in production.

## Documentation

| Document | Purpose |
|---|---|
| [Operational runbook](server/docs/RUNBOOK.md) | Deployment, migrations, health checks, integration and sync triage |
| [Current workflows](server/docs/CURRENT-WORKFLOWS.md) | Shop QA/billing, rentals, field work, portal, and recent changes |
| [Client development](client/README.md) | Routes, offline data, setup, and checks |
| [Sandbox](SANDBOX.md) | Production-data checkout and integration isolation |
| [CI setup and recovery](ci/SETUP-CI-PIPELINE.md) | Runners, registry, deployment, rollback, and disk maintenance |
| [BlueLion integration](server/docs/bluelion/SERVICEPRO-INTEGRATION.md) | External integration contract |

`mk2/` contains architecture decisions and plans; proposals are not evidence of
shipped features. This workstation also has onboarding/runbooks in
`docs/onboarding/` and host notes in `deploy/`. Those directories are gitignored
and absent from fresh clones. The tracked guides above cover current operations.

## Stack and layout

| Path | Purpose |
|---|---|
| `server/` | Node 22, Express, TypeScript, Prisma 7, PostgreSQL 16, Redis 7; API and workers |
| `client/` | React 19, Vite, Tailwind, Dexie/IndexedDB offline PWA; staff, portal, kiosks |
| `docker-compose.yml` | Development databases only: Postgres and Redis |
| `docker-compose.sandbox.yml` | Isolated sandbox databases |
| `docker-compose.prod.yml` | API, databases, static client-copy container, and Caddy |
| `ci/` | Prebuilt-image deployment and registry maintenance |

Production Caddy serves HTTP on port 80; the documented external TLS terminator
is Nginx Proxy Manager on a separate host. QBWC reaches the API directly on 3001.

## Capabilities

- Division-first ticket entry, field service and inspections, training and
  occupational health, shop intake, direct sales, rental deployment and returns.
- Customer and in-house shop boards, per-unit/batch QA and evidence, vendor
  receiving, 48-hour correction windows, direct work-order invoicing, transfers.
- Rental billing using actual deployment/return dates, daily logs, contract
  rates, partial returns, and dispatch versus walk-in pickup.
- QuickBooks Desktop via QBWC, Enverus submission and status polling, Stripe,
  BlueLion/VaultPRO records, and Novara equipment sync.
- Customer portal: service/testing history and CSV export, H₂S history/location
  comparison, shop progress, rentals, and account information.
- Site-scoped Zebra labels and shop, rental, claim, and training kiosks.

## Local development

Use Node 22 and Docker Desktop. From the root in PowerShell:

```powershell
# First setup only; preserve an existing server/.env.
Copy-Item .env.example server/.env
npm --prefix server ci
npm --prefix client ci --legacy-peer-deps
docker compose up -d
Set-Location server
npx prisma generate
npx prisma migrate deploy
Set-Location ..
.\dev.bat
```

Review `server/.env` before starting: use a local JWT secret and only the intended
integration credentials/endpoints. For production-data copies, follow [SANDBOX.md](SANDBOX.md).

`dev.bat` starts database containers and runs the API and Vite on the host. It
**does not build the app, generate Prisma, or apply migrations**. After schema
changes, repeat generation and migration deployment from `server/` before
restarting. `restart.bat` restarts development processes; it is not a migration command.

Defaults: API 3001, Vite 5173, Postgres 5432, Redis 6379. `client/.env.local` can
set `PORT` and `VITE_API_URL` for Vite's proxy. Use `http://127.0.0.1:3001` as the
API proxy target on Windows.

## Verification

```powershell
$env:NODE_OPTIONS='--max-old-space-size=4096'
npm --prefix server run build
npm --prefix server test
npm --prefix client run build
npm --prefix client run lint
```

CI also applies migrations to an empty disposable database. Lint is report-only;
typechecks, server tests, and migration application are blocking. Never use a
working database for the disposable-database check.

## Deployment

Master pushes verify/build on the `build` runner, then deploy on the `prod`
runner. Production pulls tagged images and replaces **api and client only**,
with an API health check and attempted image rollback. The API entrypoint runs
migrations before starting.

Use the [runbook](server/docs/RUNBOOK.md) for manual deployment and recovery.
Bare Compose selects the development stack. Image rollback does not reverse
migrations; an API health check does not verify the UI or integrations.
