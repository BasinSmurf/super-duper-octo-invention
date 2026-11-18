# Claudius application synchronization

SPaaS was synchronized on November 18, 2026 with the tracked working files in
`C:\turdhurdles\Claudius` at commit
`7868434c432b8b955499f8c53dca54d55f7494aa` (November 17, 2026).

The application update contains 292 added files, 223 updated files, and one
deleted file. It covers client/server behavior, regression tests, Prisma schema
and migrations, the public API contract, dependency locks, Node version pins,
Docker build definitions, and runtime asset copying. Major changes include
billing approvals and invoice replacement, rental packages and billing release,
dispatch links, inspection workflows, shop intake, dashboard data, configurable
company branding, PDF exports/attachments, and dependency security updates.

The source checkout also had four uncommitted changes, included in this sync:

- `client/src/components/AppShell.tsx`: sidebar sizing and logo layout.
- `client/src/components/CompanyBrand.tsx`: configurable brand container layout.
- `server/src/routes/invoices.ts`: billing approval/queue validation fixes.
- `server/src/routes/invoiceApproval.test.ts`: corresponding regression tests.

The complete imported file list and SHA-256 hashes are recorded in
[fork-sync/2026-11-18.json](fork-sync/2026-11-18.json), along with the deferred
upstream paths. This is a separate sync record;
`fork-baseline/manifest.json` remains the immutable original copy record.

## Preserved boundaries

SPaaS planning documents, launch materials, and other pre-existing local work
were preserved. Claudius was read only. Source ignored/untracked files,
credentials, runtime environment files, generated artifacts, and customer data
were not imported.

Source CI, deployment targets, Compose/Caddy configuration, public production
environment, seeds, import/sync/repair scripts, operational reports, and deployment
runbooks were excluded from this application sync. Existing copies remain as
inherited configuration and references. Dockerfile updates only bring build
support in line with the imported application; they do not isolate deployment
targets or authorize container startup.

Inherited application branding, integration defaults, and historical migration
data still need customer isolation under [FORK.md](FORK.md) and the existing
customer deployment plans. In particular, the new branding
configuration supports a company name/logo but retains the source-company
fallback. Schema migrations have been copied, not executed or certified for a
fresh customer deployment. No databases, services, production operations, or
deployments were started as part of this sync.

## Validation

- Frontend production build: passed (`npm run build`).
- Frontend regression suite: 244 passed (`node --test`).
- Backend production build, including runtime WSDL copying: passed (`npm run build`).
- Backend regression suite: 132 files passed; 1,374 tests passed and one skipped
  (`npm test -- --maxWorkers=2`). Local HTTP test listeners required loopback
  access outside the restricted sandbox; the full suite passed with that access.
- Prisma client generation: passed against the imported schema, using a dummy
  URL on local port 1; no database connection or migration execution.
- Final source comparison: zero application differences within the sync scope.
  All 516 imported changes were verified by hash. Claudius HEAD and its four
  pre-existing modified files were unchanged.
- Original baseline manifest unchanged. The initial tracked-file
  `git diff --check` passed. The staged check also covers newly added files and
  reports inherited extra blank lines at EOF in `client/rentalOptionalDispatch.test.mjs`,
  `client/src/components/HelpTip.tsx`, `server/src/routes/syncReliability.test.ts`,
  and `server/src/services/rentalLifecycle.ts`; retained for source parity.

Validation used the installed Node 22.13.1. Imported Node version files and Docker
builds pin the newer upstream version, 22.23.4. Docker images and a running customer
deployment were not exercised.

## Future updates

Compare against the latest sync hashes as well as the original baseline. Review
local edits before replacing application files, and review operational/customer
configuration separately. Record the source commit, any included working changes,
file hashes, deliberate exclusions, and validation results in a new sync record.
Do not overwrite the original baseline or blindly mirror the source checkout.
