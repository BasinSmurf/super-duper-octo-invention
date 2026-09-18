# ServicePRO operational runbook

Source audit: **2026-09-17**, baseline **45b3d44**. Live hosts/services were not
inspected. See [Current workflows](CURRENT-WORKFLOWS.md) for user behavior and
the [root README](../../README.md) for development setup.

## Environments

| Environment | Application | Database/cache | Configuration |
|---|---|---|---|
| Development | Host API 3001; Vite 5173 | Default Compose: 5432 / 6379 | `server/.env`, optional `client/.env.local` |
| Sandbox | Host API 3002; Vite 5174 | Sandbox Compose: 5435 / 6380 | Separate checkout; [SANDBOX.md](../../SANDBOX.md) |
| Production | API container 3001; Caddy HTTP 80 | Internal Postgres / Redis | Root `~/sundog/.env`, explicit production Compose |

The one-shot `servicepro-client-build` container copies assets into `client-dist`
and exits. External TLS is documented at upstream Nginx Proxy Manager; QBWC
uses published API port 3001 directly. Confirm host addresses from installed configuration.

Root `.env` supplies Compose interpolation. The production API receives only
variables explicitly listed in `docker-compose.prod.yml`; there is no `env_file`.
Update the reader, `.env.example`, and Compose passthrough together for new
settings. Mounted storage paths also need correct ownership in the image.

## Deployment and recovery

The [workflow](../../.github/workflows/ci.yml) verifies PRs/master pushes on the
`build` runner: server/client typechecks, server tests, migrations on empty
Postgres, and report-only client lint. Master builds/pushes API/client images
with short-SHA and `latest` tags. The `prod` runner pulls master into `~/sundog`
and runs `ci/ci-deploy.sh` with the built tag.

To deploy an **existing verified registry tag** manually on production:

```bash
cd ~/sundog
git pull --ff-only origin master
export REGISTRY='<configured-registry-host>:5000'
./ci/ci-deploy.sh <built-short-sha>
```

The script requires root `.env` and `server/certs/`. It uses production Compose
plus `ci/docker-compose.deploy.yml`, pulls before swapping, and recreates only
`api client` with `--no-deps`. Postgres, Redis, and Caddy stay running. Pending
migrations apply at API startup before it serves requests.

It polls `/api/health` for about 80 seconds and attempts the previous image tag
on failure. This is **image rollback only**: migrations, Compose changes, and
data changes are not reversed. The probe does not verify client copying, browser
behavior, or integration delivery. A missing previous tag or incompatible
migration can prevent recovery.

After deployment:

```bash
docker inspect --format '{{.Config.Image}}' servicepro-api
curl -fsS http://localhost:3001/api/health
docker logs servicepro-api --tail 80
docker logs servicepro-client-build --tail 20
docker compose -f docker-compose.prod.yml ps -a
```

Confirm client-copy exit code 0, then load the app through its normal URL and
exercise the changed workflow. Check Ops/queues for integration failures.
Preserve the previous tag for rollback and registry GC.

Older local `deploy/prod-deploy.sh` / `restore-env.sh` scripts restore
`.env.production` while Compose reads `.env`; they also build on production and
cycle the full stack. Review those differences before using the legacy path.
Bare `docker compose down/up` is not the production deployment procedure.

## Migrations, storage, and disk

Development `dev.bat` does not generate Prisma or migrate. From `server/`, run
`npx prisma generate` and `npx prisma migrate deploy` after schema changes.
`prisma.config.ts` requires `DATABASE_URL` even for generation. Production
migration failure stops the entrypoint; read its error before retrying. Do not
replace migration history with `db push` to resolve production drift.

Back up database and durable files together. Production uses external volume
`servicepro_postgres-data`; if missing on an existing deployment, investigate
rather than creating a blank replacement. Preserve `api-storage`, `api-uploads`,
any configured object store, and host secrets/certificates through the backup
process. An attachment buffer may still be its only acknowledged copy.

Use `docker system df` and host disk usage for capacity diagnosis. Follow
[CI housekeeping](../../ci/SETUP-CI-PIPELINE.md) for registry reclamation: review
`ci/registry-gc.sh --dry-run`, pin the deployed tag with `REGISTRY_GC_PIN`, and
never add `--delete-untagged`. Do not use blanket volume pruning for recovery.

## Triage

| Symptom | Check |
|---|---|
| API fails after pull | API logs, migration failure, canonical `.env`, DB connectivity; container DB host is `postgres` |
| UI old/blank | Client-copy logs/exit status, assets through Caddy, PWA update prompt; preserve pending offline work |
| Setting does nothing in prod | Explicit Compose `environment:` passthrough and reader enable/disable logic |
| Sync pending/error | Actual mutation error and record; correct cause before retry, preserve IndexedDB/files |
| Unit replays into testing | QA diversion reason in unit history; complete required checkpoints |
| Shop missing from billing | Closed WO, unit hard-close deadlines, disposition, existing invoice; no intermediate repair ticket expected |
| Receive Back blocked | Durable invoice or warranty packing slip, upload acknowledgement, disposition, numeric total |
| Vault record missing | QA eligibility, `hardClosesAt`, hard-close worker, upload/BlueLion queue errors |
| Rental total wrong | Deploy/return dates, billing period, manual rate including zero, logs, pickup type |
| QB push fails | Failed-sync detail, mappings/headers, credentials/company file, enabled flag, queue |
| Enverus remains pending | Submission and status-poll responses; upload is not final acceptance |
| Portal empty/403 | Active account, company, role; admin preview needs selected company |
| Board shows wrong work | Customer/in-house route, site, kiosk token and rental pickup role |

Avoid clearing IndexedDB first: unsynced work may exist only on that device.
Shop QA diversion is successful replay with a different status, not necessarily
an errored mutation.

## Integrations and workers

`server/src/index.ts` registers supervised jobs for Enverus, BlueLion, auto
approval, QB differences, rental readiness, attachment upload, shop hard close,
printing, printer health, and Novara. Ops (`/admin/ops`) and dashboard widgets
expose failures. Effective permissions are at `/admin/permissions`. Jobs can
self-disable when configuration is absent.

QBWC `/api/qbwc/soap` is the protocol endpoint; `/qwc` and `/cert` setup downloads
remain public. Diagnostics/queue tools, including `/test`, require a staff bearer
token with `billing:qb_sync`. A bare browser URL may return 401.

Novara provides equipment existence/compliance, not authority for every local
operational field. See `/admin/novara`. BlueLion contracts and known Div 6 gaps
remain in [bluelion/](bluelion/).

Sandbox restores include queued work. Stop the sandbox API during restore, run
sanitization, and recheck outbound settings before restart. The sanitizer clears
QB/Enverus/BlueLion queues and live print jobs; it does not sanitize every
integration or attachment destination. Follow [SANDBOX.md](../../SANDBOX.md).
