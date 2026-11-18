import 'dotenv/config';
import 'express-async-errors'; // Monkey-patches Express 4 to forward async errors to error middleware — prevents unhandled rejection crashes
import express from 'express';
import https from 'https';
import { readFileSync, existsSync, createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import { authRouter } from './routes/auth.js';
import { brandingRouter } from './routes/branding.js';
import { companiesRouter } from './routes/companies.js';
import { companyMergeRouter } from './routes/companyMerge.js';
import { locationsRouter } from './routes/locations.js';
import { mobileAssetsRouter } from './routes/mobileAssets.js';
import { productsRouter } from './routes/products.js';
import { equipmentRouter } from './routes/equipment.js';
import { ticketsRouter } from './routes/tickets.js';
import { billingRouter } from './routes/billing.js';
import { portalRouter } from './routes/portal.js';
import { syncRouter } from './routes/sync.js';
import { rentalsRouter } from './routes/rentals.js';
import { shopOrdersRouter } from './routes/shopOrders.js';
import { equipmentInspectionsRouter } from './routes/equipmentInspections.js';
import { shopTransfersRouter } from './routes/shopTransfers.js';
import { shopBoardPublicRouter } from './routes/shopBoardPublic.js';
import { rentalsBoardPublicRouter } from './routes/rentalsBoardPublic.js';
import { sitesRouter } from './routes/sites.js';
import { printersRouter } from './routes/printers.js';
import { printJobsRouter } from './routes/printJobs.js';
import { boardsRouter, boardConfigRouter } from './routes/boards.js';
import { permissionsRouter } from './routes/permissions.js';
import { kiosksRouter } from './routes/kiosks.js';
import { claimRouter } from './routes/claim.js';
import { trainingSigninRouter } from './routes/trainingSignin.js';
import { trainingKioskRouter } from './routes/trainingKiosk.js';
import { invoicesRouter } from './routes/invoices.js';
import { salesTaxRatesRouter } from './routes/salesTaxRates.js';
import { coverageRouter } from './routes/coverage.js';
import { routesRouter } from './routes/routes.js';
import { qbwcRouter } from './routes/qbwc.js';
import { enverusRouter } from './routes/enverus.js';
import { roleMappingsRouter } from './routes/roleMappings.js';
import { webhookNotificationsRouter } from './routes/webhookNotifications.js';
import { usersRouter } from './routes/users.js';
import { dashboardRouter } from './routes/dashboard.js';
import { paymentsRouter } from './routes/payments.js';
import { stripeWebhookRouter } from './routes/stripeWebhook.js';
import { signatureRequestsRouter } from './routes/signatureRequests.js';
import { filesRouter } from './routes/files.js';
import { attachmentsRouter } from './routes/attachments.js';
import { adminRouter } from './routes/admin.js';
import { bugReportRouter } from './routes/bugReport.js';
import { classProRouter } from './routes/classpro.js';
import { trainingEmployersRouter } from './routes/trainingEmployers.js';
import { v1Router } from './v1/index.js';
import { startEnverusQueueProcessor, stopEnverusQueueProcessor, SUBMIT_INTERVAL_MS as ENVERUS_TICK_MS } from './services/enverusQueueProcessor.js';
import { blueLionRouter } from './routes/blueLion.js';
import { novaraRouter } from './routes/novara.js';
import { startBlueLionQueueProcessor, stopBlueLionQueueProcessor, SUBMIT_INTERVAL_MS as BLUELION_TICK_MS } from './services/blueLionQueueProcessor.js';
import { startBlueLionTrainingListener } from './services/blueLionTrainingListener.js';
import { startRingcentralListener } from './services/ringcentralListener.js';
import { startAutoApprovalProcessor, stopAutoApprovalProcessor, CHECK_INTERVAL_MS as APPROVAL_TICK_MS } from './services/approvalAutoProcessor.js';
import { logGcalStatus } from './services/gcalSync.js';
import { startQbInvoiceDiffWatcher, stopQbInvoiceDiffWatcher, CHECK_INTERVAL_MS as QB_DIFF_TICK_MS } from './services/qbInvoiceDiffWatcher.js';
import { startRentalBillReadyWatcher, stopRentalBillReadyWatcher, CHECK_INTERVAL_MS as RENTAL_BILL_TICK_MS } from './services/rentalBillReadyWatcher.js';
import { startOperationsDigestWatcher, stopOperationsDigestWatcher, CHECK_INTERVAL_MS as OPS_DIGEST_TICK_MS } from './services/operationsDigestWatcher.js';
import { startAttachmentUploader, stopAttachmentUploader, CHECK_INTERVAL_MS as ATTACHMENT_TICK_MS } from './services/attachmentUploader.js';
import { startShopHardCloseSweep, stopShopHardCloseSweep, CHECK_INTERVAL_MS as HARD_CLOSE_TICK_MS } from './services/shopHardCloseSweep.js';
import { startLocationRescoreListener } from './services/locationRescoreListener.js';
import { startPrintQueueProcessor, stopPrintQueueProcessor, TICK_MS as PRINT_QUEUE_TICK_MS } from './services/printQueue.js';
import { startPrinterHealthCheck, stopPrinterHealthCheck, INTERVAL_MS as PRINTER_HEALTH_TICK_MS } from './services/printerHealthCheck.js';
import { startNovaraEquipmentSync, stopNovaraEquipmentSync, INTERVAL_MS as NOVARA_SYNC_TICK_MS } from './services/novaraEquipmentSync.js';
import { registerTask, startAll, startWatchdog, stopWatchdog, stopAll } from './services/supervisor.js';
import { shutdownRedis } from './services/redis.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authenticate } from './middleware/auth.js';
import { checkEnvironment } from './utils/envCheck.js';

// ── Validate env vars before anything else ──
checkEnvironment();

import { prisma } from './db.js';
import { loadMatrix } from './services/permissions.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Behind the Nginx Proxy Manager → Caddy chain, the socket peer is always the
// proxy. Trust one hop so req.ip / req.protocol reflect the real client — the
// v1 API-key IP allowlist and rate limiter (v1/auth.ts) key off req.ip.
app.set('trust proxy', 1);

// ── Log file: tee console.log/warn/error to server/logs/server.log ──
const logsDir = join(__dirname, '..', 'logs');
try { mkdirSync(logsDir, { recursive: true }); } catch {}
const logStream = createWriteStream(join(logsDir, 'server.log'), { flags: 'a' });
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
console.log = (...args: unknown[]) => { origLog(...args); logStream.write(`[${stamp()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`); };
console.warn = (...args: unknown[]) => { origWarn(...args); logStream.write(`[${stamp()}] WARN ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`); };
console.error = (...args: unknown[]) => { origError(...args); logStream.write(`[${stamp()}] ERROR ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`); };
console.log(`── Service Pro server log → ${join(logsDir, 'server.log')} ──`);

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com/gsi/", "https://accounts.google.com", "https://js.stripe.com"],
      frameSrc: ["'self'", "https://accounts.google.com/gsi/", "https://accounts.google.com", "https://js.stripe.com", "https://hooks.stripe.com"],
      connectSrc: ["'self'", "https://accounts.google.com/gsi/", "https://accounts.google.com", "https://api.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com/gsi/"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));
app.use(cors());
app.use(morgan('dev'));
// Stripe webhook — the signature is computed over the RAW bytes Stripe sent, so
// this parser MUST run before the global express.json() below re-serialises the
// body and invalidates every signature. Path-scoped, so nothing else changes.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));

// QBWC endpoints — need raw text/xml body, NO JWT auth (QBWC has its own auth)
// express.text parses text/xml bodies into req.body as a string
// Must cover /soap and /test-soap paths
app.use('/api/qbwc', express.text({ type: ['text/xml', 'application/xml'], limit: '5mb' }));
app.use('/api/qbwc', qbwcRouter);

// Health check (no auth)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (no auth required)
app.use('/api/auth', authRouter);
app.use('/api/branding', brandingRouter);

// All-sites Shop Kanban board — view-only. Mounts without the global
// authenticate middleware because the router runs its own per-route
// authenticateUserOrKiosk (manager JWT or provisioned kiosk token), so a
// wall tablet can render it without a user login but it's not open to the
// public internet. Click-through to detail still hits a protected route.
app.use('/api/shop-board', shopBoardPublicRouter);
app.use('/api/rentals-board', rentalsBoardPublicRouter);

// Multi-site boards + kiosks — per-route auth (manager JWT, kiosk token, or
// admin), so these mount without the global authenticate middleware.
app.use('/api/boards', boardsRouter);
app.use('/api/board-config', boardConfigRouter);
app.use('/api/permissions', permissionsRouter);
app.use('/api/kiosks', kiosksRouter);
app.use('/api/claim', claimRouter);

// #13 Training QR self-sign-in — public half is keyed by an unguessable
// per-class token (no anonymous-open reads/writes); link generation runs
// per-route authenticate. Mounts pre-auth like the kiosk routers.
app.use('/api/train', trainingSigninRouter);

// Training kiosk — classroom sign-in board / signage. Device-token (or JWT)
// auth; reads today's classes and their sign-in QR. Mounts pre-auth like the
// other kiosk routers.
app.use('/api/train-kiosk', trainingKioskRouter);

// ── Customer-portal containment ──
// Portal accounts (role = customer) are external customers. Their JWT must
// only ever reach /api/portal/* — never an internal endpoint, even one with
// no permission guard. Each protected router runs its own `authenticate`, so
// here we re-verify the token solely to read the role and reject early.
// Absent/invalid tokens fall through to the per-router auth, which 401s them.
app.use('/api', (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();
  const secret = process.env.JWT_SECRET;
  if (!secret) return next();
  try {
    const payload = jwt.verify(authHeader.slice(7), secret) as { role?: string };
    if (
      payload.role === 'customer' &&
      !req.path.startsWith('/portal') &&
      !req.path.startsWith('/auth')
    ) {
      res.status(403).json({ error: 'This account can only access the customer portal' });
      return;
    }
  } catch {
    // malformed/expired token — let the downstream authenticate middleware 401
  }
  next();
});

// Protected routes
app.use('/api/portal', authenticate, portalRouter);
// Mount /merge BEFORE the companies router so /companies/merge/* isn't matched by GET /companies/:id
app.use('/api/companies/merge', authenticate, companyMergeRouter);
app.use('/api/companies', authenticate, companiesRouter);
app.use('/api/sites', authenticate, sitesRouter);
app.use('/api/printers', authenticate, printersRouter);
app.use('/api/print-jobs', authenticate, printJobsRouter);
app.use('/api/locations', authenticate, locationsRouter);
app.use('/api/mobile-assets', authenticate, mobileAssetsRouter);
app.use('/api/products', authenticate, productsRouter);
app.use('/api/equipment', authenticate, equipmentRouter);
app.use('/api/tickets', authenticate, ticketsRouter);
app.use('/api/rentals', authenticate, rentalsRouter);
app.use('/api/shop-orders', authenticate, shopOrdersRouter);
app.use('/api/equipment-inspections', authenticate, equipmentInspectionsRouter);
app.use('/api/shop-transfers', authenticate, shopTransfersRouter);
app.use('/api/invoices', authenticate, invoicesRouter);
app.use('/api/billing', authenticate, billingRouter);
app.use('/api/coverage', authenticate, coverageRouter);
app.use('/api/routes', authenticate, routesRouter);
app.use('/api/enverus', authenticate, enverusRouter);
app.use('/api/bluelion', authenticate, blueLionRouter);
app.use('/api/novara', authenticate, novaraRouter);
app.use('/api/sync', authenticate, syncRouter);
app.use('/api/role-mappings', authenticate, roleMappingsRouter);
app.use('/api/webhook-notifications', authenticate, webhookNotificationsRouter);
app.use('/api/users', authenticate, usersRouter);
app.use('/api/dashboard', authenticate, dashboardRouter);
// Stripe webhook — NO `authenticate`: Stripe cannot carry a JWT. The endpoint
// authenticates by verifying Stripe's signature over the raw body, which also
// proves the payload is unmodified. Mounted outside /api/payments for exactly
// that reason.
app.use('/api/stripe', stripeWebhookRouter);
app.use('/api/payments', authenticate, paymentsRouter);
app.use('/api/signature-requests', authenticate, signatureRequestsRouter);
app.use('/api/files', authenticate, filesRouter);
app.use('/api/attachments', authenticate, attachmentsRouter);
app.use('/api/admin', authenticate, adminRouter);
app.use('/api/bug-reports', authenticate, bugReportRouter);
app.use('/api/sales-tax-rates', authenticate, salesTaxRatesRouter);
app.use('/api/classpro', authenticate, classProRouter);
app.use('/api/training/employers', authenticate, trainingEmployersRouter);

// ── v1 public/bolt-on REST surface ──
// Carries its own auth (scoped API key or staff JWT) via v1Auth, so it mounts
// WITHOUT the global `authenticate`. Curated DTOs only — see openapi/.
app.use('/api/v1', v1Router);

// Keep unknown API requests out of the production SPA fallback.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'No such API endpoint' });
});

// Error handler
app.use(errorHandler);

// ── Production: serve client SPA build ──
// In production, Express serves the Vite build output so nginx only needs to
// reverse-proxy everything to :3001 (no separate static file config needed).
const clientDistPath = join(__dirname, '..', '..', 'client', 'dist');
if (process.env.NODE_ENV === 'production' && existsSync(clientDistPath)) {
  // Serve static assets (JS, CSS, images, SW, manifest)
  app.use(express.static(clientDistPath, {
    maxAge: '7d',            // cache fingerprinted assets aggressively
    immutable: true,
    index: false,            // don't auto-serve index.html for /
  }));

  // SPA fallback: any non-API GET that didn't match a file → index.html
  app.get('*', (_req, res) => {
    res.sendFile(join(clientDistPath, 'index.html'));
  });

  console.log(`[static] Serving client SPA from ${clientDistPath}`);
}

async function main() {
  await prisma.$connect();
  console.log('Database connected');

  // Warm the RBAC permission matrix (admin overrides merged over code defaults)
  // so requirePermission() reads from cache synchronously.
  await loadMatrix();
  console.log('Permission matrix loaded');

  // HTTP server (API + client dev proxy)
  const httpServer = app.listen(PORT, () => {
    console.log(`Service Pro API running on http://0.0.0.0:${PORT}`);
  });

  // HTTPS server for QBWC (self-signed cert)
  const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
  const certPath = join(__dirname, '..', 'certs', 'server.crt');
  const keyPath = join(__dirname, '..', 'certs', 'server.key');

  let httpsServer: https.Server | null = null;
  if (existsSync(certPath) && existsSync(keyPath)) {
    httpsServer = https.createServer(
      { cert: readFileSync(certPath), key: readFileSync(keyPath) },
      app,
    );
    httpsServer.listen(HTTPS_PORT, () => {
      console.log(`Service Pro HTTPS (QBWC) running on https://0.0.0.0:${HTTPS_PORT}`);
    });
  } else {
    console.log(`[QBWC] No SSL certs found at ${certPath} — HTTPS disabled. Run openssl to generate.`);
  }

  // ── Supervised background processors ──
  // Each start()s below self-skip if their integration isn't configured/enabled,
  // and each emits a heartbeat every tick. The supervisor restarts any that stop
  // beating (stallMs is set a few multiples above each tick interval so a slow
  // run never trips it) and stopAll()s them on graceful shutdown. Listeners
  // (event-bus subscriptions) and one-shot logs are NOT supervised — they have
  // no timer to stall.
  // Derive each stall window from the processor's own tick constant rather than
  // hardcoding it: every tick interval is env-overridable (PRINT_QUEUE_TICK_MS,
  // AUTO_APPROVE_CHECK_INTERVAL_MS, …), and a stall window that didn't move with
  // it would restart a perfectly healthy processor on every watchdog pass.
  // 4 ticks of headroom, floor 60s so the fast ones aren't trigger-happy.
  const stallFor = (tickMs: number) => Math.max(4 * tickMs, 60_000);
  registerTask({ name: 'enverus',        start: startEnverusQueueProcessor, stop: stopEnverusQueueProcessor, stallMs: stallFor(ENVERUS_TICK_MS) });
  registerTask({ name: 'bluelion',       start: startBlueLionQueueProcessor, stop: stopBlueLionQueueProcessor, stallMs: stallFor(BLUELION_TICK_MS) });
  registerTask({ name: 'approval',       start: startAutoApprovalProcessor, stop: stopAutoApprovalProcessor, stallMs: stallFor(APPROVAL_TICK_MS) });
  registerTask({ name: 'qb-diff',        start: startQbInvoiceDiffWatcher, stop: stopQbInvoiceDiffWatcher, stallMs: stallFor(QB_DIFF_TICK_MS) });
  registerTask({ name: 'rental-bill',    start: startRentalBillReadyWatcher, stop: stopRentalBillReadyWatcher, stallMs: stallFor(RENTAL_BILL_TICK_MS) });
  registerTask({ name: 'operations-digest', start: startOperationsDigestWatcher, stop: stopOperationsDigestWatcher, stallMs: stallFor(OPS_DIGEST_TICK_MS) });
  registerTask({ name: 'attachment-upload', start: startAttachmentUploader, stop: stopAttachmentUploader, stallMs: stallFor(ATTACHMENT_TICK_MS) });
  registerTask({ name: 'shop-hard-close', start: startShopHardCloseSweep, stop: stopShopHardCloseSweep, stallMs: stallFor(HARD_CLOSE_TICK_MS) });
  registerTask({ name: 'print-queue',    start: startPrintQueueProcessor, stop: stopPrintQueueProcessor, stallMs: stallFor(PRINT_QUEUE_TICK_MS) });
  registerTask({ name: 'printer-health', start: startPrinterHealthCheck, stop: stopPrinterHealthCheck, stallMs: stallFor(PRINTER_HEALTH_TICK_MS) });
  registerTask({ name: 'novara-sync',    start: startNovaraEquipmentSync, stop: stopNovaraEquipmentSync, stallMs: stallFor(NOVARA_SYNC_TICK_MS) });
  startAll();
  startWatchdog();

  // Event-bus listeners + one-shot status — no timers, nothing to supervise.
  startBlueLionTrainingListener();
  startRingcentralListener();
  startLocationRescoreListener();
  logGcalStatus();

  // ── Graceful shutdown ──
  // On SIGTERM (docker stop / deploy) or SIGINT (Ctrl-C): stop the watchdog and
  // every processor, stop accepting connections, and close DB/Redis so nothing
  // is left half-open. A hard-exit timer guarantees the process dies even if a
  // close hangs.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — draining`);
    const hardExit = setTimeout(() => {
      console.error('[shutdown] graceful close timed out — forcing exit');
      process.exit(0);
    }, 10_000);
    hardExit.unref();
    try {
      stopWatchdog();
      stopAll();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      if (httpsServer) await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
      await prisma.$disconnect().catch(() => {});
      await shutdownRedis();
      console.log('[shutdown] clean');
    } catch (err) {
      console.error('[shutdown] error during drain:', err instanceof Error ? err.message : err);
    } finally {
      clearTimeout(hardExit);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // ── Process-level crash safety ──
  // A stray unhandled rejection shouldn't take down field ops — log it. An
  // uncaughtException means process state may be corrupt, so stop the timers
  // and exit non-zero; the container's `restart: unless-stopped` policy brings
  // us back on clean state.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException] fatal — exiting for restart:', err.stack || err);
    try { stopWatchdog(); stopAll(); } catch { /* best effort */ }
    process.exit(1);
  });
}

// Open listeners only when invoked directly. Database consumers import db.ts.
if (require.main === module) {
  main().catch((e) => {
    console.error('Failed to start server:', e);
    process.exit(1);
  });
}
