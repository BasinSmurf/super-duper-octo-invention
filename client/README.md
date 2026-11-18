# ServicePRO client

React 19 and TypeScript PWA built with Vite and Tailwind. Staff workflows,
customer portal pages, and kiosk displays share this package. Dexie stores
local records and the offline mutation outbox.

## Development

Use Node.js 22.23.4, matching `.node-version`, `.nvmrc`, and CI. Start Postgres and Redis from the repository root,
configure `server/.env` from the root `.env.example`, and run the API on port 3001.
Then, in this directory:

```powershell
npm ci --legacy-peer-deps
npm run dev
```

Vite defaults to port 5173 and proxies `/api` to `http://127.0.0.1:3001`.
Optional `client/.env.local` settings:

```dotenv
PORT=5173
VITE_API_URL=http://127.0.0.1:3001
```

The development server binds to all interfaces for LAN testing. Camera and service
worker features may require a secure context on devices. `VITE_*` values are
public build inputs; keep secrets in the server environment.

## Validation and build

```powershell
npx tsc -b
node --test *.test.mjs
npm run lint
npm run build
```

CI gates the production build (including TypeScript), workflow regressions, and
`npm audit --audit-level=low`; lint is currently report-only.
Build output is `dist/`. Production copies the client image's static files into
the shared `client-dist` volume served by Caddy.

## Where to look

- `src/pages/wizard/WizardShell.tsx`: division-first `/tickets/start` entry.
- `src/pages/TicketWizard.tsx`: setup, dispatch preparation, field completion.
- `src/pages/TicketEditPage.tsx`: online admin and rental-visit ticket editing.
- `src/lib/rentalCatalog.ts`: catalog/customer rental rates and manual-rate preservation.
- `src/components/HelpTip.tsx` and `src/lib/helpTips.ts`: contextual help visibility.
- `src/lib/db.ts` and `src/lib/db-types.ts`: offline database and record types.
- `src/lib/syncEngine.ts`: pull, outbox replay, and reconciliation.
- `src/lib/manualRentalVisit.ts`: offline swap/return batches.
- `vite.config.ts`: dev proxy, PWA manifest, and service worker settings.

Read the [user guide](../server/docs/USER_GUIDE.md),
[current workflows](../server/docs/CURRENT-WORKFLOWS.md), and
[operational runbook](../server/docs/RUNBOOK.md). Sync pending work before
accepting a PWA update; clearing browser storage can discard unsynced records.
