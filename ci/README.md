# SPaaS continuous integration

`.github/workflows/ci.yml` runs on GitHub-hosted Ubuntu 24.04 runners. No
self-hosted runner registration, registry credentials, or deployment host is
required. Node is pinned by the repository's `.node-version` file.

CI runs for pull requests, pushes to the SPaaS default branch
`codex/customer-buildouts`, and manual workflow dispatches. Separate backend and
frontend jobs install the lockfiles, build the application, and run regression
tests. The backend generates Prisma types with an intentionally unusable local
database URL; its tests mock database/integration access. Package lifecycle
scripts are disabled during installation. There is no database or Redis service.

This workflow does not run migrations, seeds, imports, synchronization, Docker
publishing, or deployment commands. Customer infrastructure and migration
validation need a separately isolated configuration before those operations are
enabled. Source-customer deployment scripts and the older setup guide remain
historical references, not SPaaS CI instructions.

Run checks locally with `npm run build` and `node --test` in `client`, and
`prisma generate`, `npm run build`, and `npm test -- --maxWorkers=2` in `server`.
Use a dummy `DATABASE_URL` for generation/tests, never inherited runtime secrets.
