# ServicePRO client

React 19 / TypeScript / Vite / Tailwind PWA. Reviewed 2026-09-17 against source
through 45b3d44. See the [root README](../README.md) for API/database setup and
[current workflows](../server/docs/CURRENT-WORKFLOWS.md) for operating behavior.

## Development

From this directory, with Node 22:

```powershell
npm ci --legacy-peer-deps
npm run dev
```

Vite defaults to 5173, binds to the LAN, and proxies `/api` to
`http://127.0.0.1:3001`. Override in ignored `client/.env.local`:

```ini
PORT=5174
VITE_API_URL=http://127.0.0.1:3002
```

The API and databases run separately. `VITE_*` values are public configuration,
never secrets. `@/` resolves to `src/`.

## Source map

| Path | Responsibility |
|---|---|
| `src/App.tsx` | Lazy routes, staff/portal separation, permission guards, PWA updates |
| `src/pages/wizard/` | Division-first `/tickets/start`; delegates to existing work types |
| `src/pages/TicketWizard.tsx` | Direct `/tickets/new`, editing, work-type flows |
| `src/pages/portal/` | Company-scoped customer experience |
| `src/contexts/` | Auth, effective permissions, sync |
| `src/lib/db.ts`, `db-types.ts`, `syncEngine.ts` | Dexie schema, local models, synchronization |
| `src/components/widgets/` | Dashboard components and registry |
| `vite.config.ts` | Proxy, assets, service-worker configuration |

Staff land at `/dashboard`; `/home` redirects there. Customers land at `/portal`.
Portal sections include `/portal/service`, `/portal/h2s`, `/portal/shop`,
`/portal/rentals`, and `/portal/account`. Platform admins can preview a selected
company. Permissions are edited at `/admin/permissions`.

Shop boards separate customer (`/shop-board`) and internal (`/shop-board/inhouse`)
work. Kiosk `/kiosk/...` routes use device tokens; the server controls site and
rental pickup scope. Client visibility is not server authorization.

## Offline work and updates

Supported staff mutations queue in IndexedDB and sync push-first, then pull.
Not every screen/action works offline. Inspect failed mutations before clearing
browser data: unsynced records and attachment buffers can be lost. Offline shop
completion still runs server QA checks; incomplete QA can replay successfully
into `qc_testing`, with the reason recorded in unit history.

The production PWA prompts for updates and defers activation around active work.
Vite development alone does not verify production service-worker behavior.
Check pending work and the update prompt when diagnosing stale UI.

## Checks and delivery

```powershell
npm run build   # tsc -b, then Vite production build
npm run lint    # existing backlog; report-only in CI
```

There is no client test script in `package.json`. Exercise changed interactions
in a browser, including offline replay where applicable. Production's client
container copies files into `client-dist` and exits successfully; Caddy serves
them. An exited client-copy container is expected.
