# Sandbox

A second, complete checkout of this repo on the dev box, holding a **copy of
production data** and wired to the **sandbox** Enverus tenant and the **sandbox**
QuickBooks company file. For looking at real data, and for trying a change
against real data, without touching production.

It is a separate clone rather than a mode of the dev checkout, for one reason:
"identical to prod except a few env vars" is only true if the code tree is
pinned independently. A sandbox launched from the dev checkout runs whatever
branch happens to be checked out there — which is usually somebody's
in-progress work, not master.

```
C:\turdhurdles\Claudius          dev      — your working tree, any branch
C:\turdhurdles\sundog-sandbox    sandbox  — pinned to origin/master
```

Both run at once. Nothing is shared but the Docker daemon.

|          | dev  | sandbox  |
|----------|------|----------|
| API      | 3001 | **3002** |
| Vite     | 5173 | **5174** |
| Postgres | 5432 | **5435** |
| Redis    | 6379 | **6380** |

Postgres is 5435, not the more obvious 5433: `redlion-postgres` holds 5433 and
`zebra-db` holds 5434 on this box. Check `docker ps` before changing any of them.

## One-time setup

```
git clone <repo> C:\turdhurdles\sundog-sandbox
cd C:\turdhurdles\sundog-sandbox
git checkout master
cd server && npm install && cd ..\client && npm install && cd ..
```

Copy `server\certs\` over from the dev checkout — the Enverus PFX, the public
PEM and the Google service-account JSON are not in git.

Then three env files, none of them tracked:

**`.env`** (repo root) — makes plain `docker compose` act on the sandbox stack,
so `dev.bat` starts the right containers:

```
COMPOSE_FILE=docker-compose.sandbox.yml
```

**`client\.env.local`** — the dev server's port and which API it proxies to:

```
PORT=5174
VITE_API_URL=http://127.0.0.1:3002
```

**`server\.env`** — start from the root `.env.example` (copy it to `server\.env`), then apply the overrides below.

### server\.env overrides

```ini
# Its own database, Redis and port
DATABASE_URL=postgresql://sandbox:sandbox_dev@127.0.0.1:5435/sandbox?schema=public
REDIS_URL=redis://127.0.0.1:6380
PORT=3002
HTTPS_PORT=3444

# Its own JWT secret — a dev token must not authenticate against a database
# full of real customer records, or the reverse
JWT_SECRET=<openssl rand -hex 32>

# Its own upload and file-store directories
UPLOAD_DIR=./uploads
STORAGE_DIR=./data/storage

# Enverus SANDBOX (onboard-api). api.openinvoice.com is production and does
# not belong in this file.
ENVERUS_BASE_URL=https://onboard-api.openinvoice.com

# QuickBooks — its own registration, manual pulls only, see below
QBWC_ENABLED=false
QBWC_RUN_EVERY_N_MINUTES=0
QBWC_APP_NAME=Service Pro - Basin Safety (SANDBOX)
QBWC_FILE_ID={2CB5831A-6317-412A-8B42-E0A761CAE56F}
QBWC_OWNER_ID={2067493E-FF09-451E-A45E-84596D4FA6CB}

# Outbound integrations that must stay off — see "What is disabled" below
GOOGLE_MAIL_FROM=
BLUELION_URL=
BLUELION_TOKEN=
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
PRINT_QUEUE_ENABLED=false
PRINTER_HEALTH_ENABLED=false
AUTO_APPROVE_ENABLED=false

# Newer integrations and storage must be isolated too
RINGCENTRAL_WEBHOOK_URL=
RINGCENTRAL_BILLING_WEBHOOK_URL=
RINGCENTRAL_DISPATCH_WEBHOOK_URL=
RINGCENTRAL_RENTALS_WEBHOOK_URL=
RINGCENTRAL_INTAKE_WEBHOOK_URL=
CLASSPRO_GCAL_CALENDAR_ID=
NOVARA_SYNC_ENABLED=false
NOVARA_API_TOKEN=
STORAGE_DRIVER=local
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

## Daily use

```
sync-prod-to-sandbox.bat   # replaces sandbox data; stop sandbox API first (read-only on prod)
dev.bat                    # run it — same launcher as dev, own .env, own ports
```

For a clean sandbox checkout on master, update with a fast-forward pull. If it diverges, inspect local changes before resetting anything:

```
git fetch origin
git pull --ff-only origin master
```

`sync-prod-to-sandbox.bat` targets the sandbox database explicitly, so it is
safe to run from either checkout — it never touches dev's database on 5432.

## What is disabled, and why

The database is a copy of production, so it arrives full of live references:
real printer IPs, real customer email addresses, and queued outbound work that
production is also going to push. A real restore carried **12 pending
QuickBooks pushes** and **three live shop-floor printers**. Two layers stop
that reaching anyone:

1. The `server\.env` overrides above turn the outbound workers off.
2. `scripts\sandbox-sanitize.sql`, run by the sync script, empties the QB,
   Enverus and BlueLion queues and repoints the printers at loopback — so even
   with a worker switched back on there is nothing queued to send.

Business records are untouched; only in-flight outbound state is cleared.

Note that an empty `qb_sync_queue` is not permanent: QBWC re-queues item,
sales-tax and invoice lookups on every poll. Those are all `query` actions,
which read from QuickBooks and write nothing. New transaction work can be queued by application actions and automatic billing/payment flows. Clearing the restored queue is not a permanent write barrier; keep QBWC disabled until the sandbox company file is explicitly configured.

## QuickBooks

Two registrations against one QB host, separated by the `.qwc` and run manually.

**The constraint, and why it is not a blocker.** QuickBooks Desktop opens one
company file at a time per instance, so two registrations bound to different
files cannot both be on a timer — whichever one fires while the other's file is
open just fails. The answer is to take both off auto-run and pull manually:
open the file you want, click *Update Selected* on the matching app.

That costs less than it sounds like, because Web Connector auto-run was never
truly unattended. It is a desktop app, so a scheduled run already needed a
signed-in Windows user, QuickBooks up, a company file open, and no modal dialog
in the way. The timer only ever fired when a human had already set the stage.

`QBWC_RUN_EVERY_N_MINUTES=0` omits the `<Scheduler>` block from the generated
`.qwc`, registering the app with no schedule. Set it on **both** instances.

### Wiring it up

Set `QBWC_COMPANY_FILE` **before** adding the registration — see below for why.

1. Set in the sandbox `server\.env`:
   ```ini
   QBWC_ENABLED=true
   QBWC_COMPANY_FILE=<absolute path to the sandbox .QBW, as the QB host sees it>
   QBWC_RUN_EVERY_N_MINUTES=0
   ```
   Restart the sandbox API.
2. Open the **sandbox** company file in QuickBooks on the QB host.
3. Add a hosts entry on the **QB host** pointing a `localhost`-prefixed name at
   this dev box — see "Why the AppURL is a fake hostname" below:
   ```
   <dev-box-IP-the-QB-host-can-reach>   localhost9
   ```
   Production already uses `localhost2` for its own API, so the sandbox needs a
   different name — `localhost9` is the one in use. The dev box also needs an
   inbound firewall rule for 3002.
4. Download the registration using that name:
   ```
   http://127.0.0.1:3002/api/qbwc/qwc?host=localhost9:3002
   ```
5. Add it in the Web Connector and authorise it. Doing that while the sandbox
   file is open binds the two together.
6. Call `http://127.0.0.1:3002/api/qbwc/test` with a staff bearer token whose role has `billing:qb_sync` (a bare browser URL returns 401). The `identity` block
   reports the app name, FileID, company file and auto-run state in use.
7. Set `QBWC_RUN_EVERY_N_MINUTES=0` on production too and untick its auto-run,
   so it cannot fire while the sandbox file is open.

From then on: whichever company file is open, click *Update Selected* on the
matching app.

### Why the AppURL is a fake hostname

The Web Connector refuses a plain `http://` AppURL unless the host looks like
`localhost`. Anything else — an IP, a real hostname — has to be `https://` with
a certificate the QB machine trusts.

Rather than issue and install a certificate, production maps a
`localhost`-prefixed name to the API's address in the QB host's hosts file and
uses plain HTTP: `http://localhost2:3001/...`. The name satisfies the Web
Connector's check while resolving to a different machine entirely. The sandbox
does the same thing with a different name, because `localhost2` is already
pointed at production.

So `127.0.0.1` in the AppURL is wrong for two separate reasons — it would mean
*the QB machine itself*, and it is the wrong name to be hosts-mapped. Always
generate the `.qwc` with `?host=`.

There is a real HTTPS listener on `HTTPS_PORT` (3444) using
`server/certs/server.crt`, and `/api/qbwc/cert` serves that certificate for
installing into the QB host's Trusted Root store. It is the road not taken:
production does not use it, and the checked-in certificate's SAN covers
`localhost`, `127.0.0.1`, this box's hostname and its Tailscale address — not
its LAN address — so going that way means reissuing the certificate first.

### Why the two app-identity vars matter

`QBWC_APP_NAME` and `QBWC_FILE_ID` are what let the registrations coexist — the
Web Connector keys its app list on that pair, so matching production's values
would overwrite production's registration rather than sit beside it.

`QBWC_COMPANY_FILE` stops being optional under manual pulls. The failure mode
is now human: add the sandbox `.qwc` while the *live* file happens to be open
and the Web Connector binds the sandbox app to the real books — after which a
single *Update Selected* posts sandbox invoices into production accounting. Set
it, and the server names the expected file on every authenticate, so
QuickBooks refuses the session instead. That is why step 1 comes before step 4.

## Checking what it is wired to

- `http://127.0.0.1:3002/api/qbwc/test` — `identity` block: QB app name, FileID,
  company file
- the API console at boot — `[Enverus Queue] Starting processor — SANDBOX` or
  `— PRODUCTION`, plus a `Skipped`/`disabled` line for every outbound worker

## September 2026 isolation review

Reviewed 2026-09-17 against source through 45b3d44; live registrations and host
certificates were not re-inspected. Older host/IP observations above are setup
history, not a fresh assertion about the installed environment.

Stop the sandbox API before restoring and sanitizing. The current SQL clears
QB, Enverus, BlueLion queues and live print jobs, and repoints printers. It does
not scrub RingCentral, Calendar, Novara, object-store destinations, or the newer
attachment lifecycle. Keep the overrides above even after a successful sanitize.
Use local storage and sandbox-owned file buffers; restoring database rows does
not copy attachment files or make production object keys safe to reuse.

The host-run API reads `server/.env`; root `.env` chooses Compose's database
stack. `dev.bat` does not generate Prisma or apply migrations. After updating
sandbox code, run `npx prisma generate` and `npx prisma migrate deploy` from
`server/` before starting the API. Match code to the intended production image
tag when reproducing an incident; origin/master may be ahead of the deployed tag.
