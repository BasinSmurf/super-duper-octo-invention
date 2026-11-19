import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { requirePermission } from '../middleware/rbac.js';
import { attachmentQueueDepth } from '../services/attachmentUploader.js';

import { createAuditLog } from '../utils/auditLog.js';
import { loadApiKeys, issueApiKey, V1_SCOPES } from '../v1/apiKeyStore.js';
import { isServiceDivision } from '../utils/qbClass.js';
import type { ServiceDivision } from '../db.js';
import { supervisorStatus } from '../services/supervisor.js';
import { suggestCompanyMatches } from '../services/qbCustomerListSync.js';

export const adminRouter = Router();

// GET /ops/processors — background-processor supervisor snapshot: which are
// beating, time since last heartbeat, and how many times the watchdog has
// restarted each. Read-only.
adminRouter.get('/ops/processors', requirePermission('page:ops'), (_req: Request, res: Response) => {
  res.json({ processors: supervisorStatus() });
});

// ============================================================
// GET /ops/summary — Platform health triage snapshot
// ============================================================
//
// Single-screen view: what's stuck, where, for how long. All
// thresholds are fixed here (v1) — tune once we have real data.
// No caching — this endpoint is called at most every 30s per
// logged-in admin. Counts run in parallel via Promise.all.

adminRouter.get('/ops/summary', requirePermission('page:ops'), async (req: Request, res: Response, next) => {
  try {
    const now = Date.now();
    const FOUR_H = new Date(now - 4 * 60 * 60 * 1000);
    const EIGHT_H = new Date(now - 8 * 60 * 60 * 1000);
    const ONE_D = new Date(now - 24 * 60 * 60 * 1000);
    const THREE_D = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const FORTY_EIGHT_H = new Date(now - 48 * 60 * 60 * 1000);

    // Optional filters — apply to ticket + invoice counts only.
    // QB queue / Enverus queue / signatures are not division-scoped in v1.
    const divisionParam = req.query.division as string | undefined;
    const division = isServiceDivision(divisionParam) ? divisionParam : undefined;
    const dickinsonParam = req.query.dickinson as string | undefined;
    const dickinsonFilter = dickinsonParam === 'true' ? true
      : dickinsonParam === 'false' ? false
      : undefined;

    const classFilter: { division?: ServiceDivision; isDickinson?: boolean } = {};
    if (division) classFilter.division = division;
    if (dickinsonFilter !== undefined) classFilter.isDickinson = dickinsonFilter;

    const [
      ticketGroups,
      ticketsSupervisorStuck,
      ticketsSignatureStuck,
      qbGroups,
      invoicesSoCreated,
      invoicesSoCreatedOver1d,
      invoicesSoCreatedOver3d,
      qbInvoicesDiverged,
      qbInvoicesNeverChecked,
      enverusGroups,
      blueLionGroups,
      signaturesPending,
      signaturesStuck,
      attachmentQueue,
      shopTransitFailedGroups,
    ] = await Promise.all([
      prisma.serviceTicket.groupBy({
        by: ['status'],
        where: classFilter,
        _count: { _all: true },
      }),
      prisma.serviceTicket.count({
        where: { ...classFilter, status: 'supervisor_review', updatedAt: { lt: FOUR_H } },
      }),
      prisma.serviceTicket.count({
        where: { ...classFilter, status: 'awaiting_signature', updatedAt: { lt: EIGHT_H } },
      }),
      prisma.qbSyncQueue.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.invoice.count({ where: { ...classFilter, status: 'so_created' } }),
      prisma.invoice.count({ where: { ...classFilter, status: 'so_created', updatedAt: { lt: ONE_D } } }),
      prisma.invoice.count({ where: { ...classFilter, status: 'so_created', updatedAt: { lt: THREE_D } } }),
      // Slice F: invoices where SP and QB disagree
      prisma.invoice.count({
        where: { ...classFilter, qbDiffDetectedAt: { not: null } },
      }),
      // Diff watcher in-window candidates that haven't been checked yet
      prisma.invoice.count({
        where: {
          ...classFilter,
          qbInvoiceTxnId: { not: null },
          qbLastCheckedAt: null,
          status: { notIn: ['paid', 'void'] },
        },
      }),
      prisma.enverusSyncQueue.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.blueLionSyncQueue.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.signatureRequest.count({ where: { status: 'PENDING' } }),
      prisma.signatureRequest.count({
        where: { status: 'PENDING', firstSentAt: { lt: FORTY_EIGHT_H } },
      }),
      // Attachment pipeline: files the SP server holds but the object store
      // does not have yet. A number that only ever grows means the second hop
      // is broken, and the buffer disk is filling.
      attachmentQueueDepth(),
      // Field-inspection intakes whose "return to shop" pick never became a
      // transfer event, so the gear is at the intake site while the tech
      // believes it is on its way. Grouped by cause because the two causes
      // have different owners: unknown_short_code means a device sent a code
      // no Site carries, site_inactive means an admin deactivated a shop that
      // techs are still selecting.
      //
      // The filters are what make this self-clearing. A WO that has since
      // transited (transitToSiteId set, or any transfer event at all, however
      // it was created) is no longer stranded and drops off on its own — no
      // write needed, and nothing here has to reach into the transfer routes
      // to clear a flag. Closed WOs are done regardless.
      prisma.shopWorkOrder.groupBy({
        by: ['transitFailedReason'],
        where: {
          transitFailedReason: { not: null },
          transitToSiteId: null,
          transfers: { none: {} },
          status: { not: 'closed' },
        },
        _count: { _all: true },
      }),
    ]);

    const ticketsByStatus: Record<string, number> = {};
    for (const g of ticketGroups) ticketsByStatus[g.status] = g._count._all;

    const qbByStatus: Record<string, number> = {};
    for (const g of qbGroups) qbByStatus[g.status] = g._count._all;

    const enverusByStatus: Record<string, number> = {};
    for (const g of enverusGroups) enverusByStatus[g.status] = g._count._all;

    const blueLionByStatus: Record<string, number> = {};
    for (const g of blueLionGroups) blueLionByStatus[g.status] = g._count._all;

    const shopTransitFailedByReason: Record<string, number> = {};
    let shopTransitFailedTotal = 0;
    for (const g of shopTransitFailedGroups) {
      if (!g.transitFailedReason) continue;
      shopTransitFailedByReason[g.transitFailedReason] = g._count._all;
      shopTransitFailedTotal += g._count._all;
    }

    res.json({
      generatedAt: new Date().toISOString(),
      tickets: {
        byStatus: ticketsByStatus,
        stuck: {
          supervisorReviewOver4h: ticketsSupervisorStuck,
          awaitingSignatureOver8h: ticketsSignatureStuck,
        },
      },
      qb: {
        byStatus: qbByStatus,
        pendingConversion: {
          total: invoicesSoCreated,
          over1d: invoicesSoCreatedOver1d,
          over3d: invoicesSoCreatedOver3d,
        },
        diff: {
          diverged: qbInvoicesDiverged,
          neverChecked: qbInvoicesNeverChecked,
        },
      },
      enverus: {
        byStatus: enverusByStatus,
      },
      bluelion: {
        byStatus: blueLionByStatus,
      },
      signatures: {
        pending: signaturesPending,
        over48h: signaturesStuck,
      },
      attachments: {
        // buffered: waiting for a normal upload. failed: retried and still
        // not landing -- still being retried, still buffered, but a human
        // should look. Neither state ever blocks a technician.
        buffered: attachmentQueue.buffered,
        failed: attachmentQueue.failed,
        oldestPendingAt: attachmentQueue.oldestPendingAt,
      },
      shop: {
        // Gear a tech handed off toward a shop that never got an inbound card
        // for it. Any non-zero number here is physical equipment nobody is
        // expecting, so it reads as a count of things, not a queue depth.
        transitFailed: {
          total: shopTransitFailedTotal,
          byReason: shopTransitFailedByReason,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /admin/jobs — last run per scheduled job + recent error counts
// ============================================================
// Powers the Jobs card on the Ops Dashboard. Returns one row per known
// jobName seen in job_runs, with the latest run + a count of errors and
// skips in the last hour. Skips on their own are normal (lock contention,
// nothing to do); a sustained run of skips means the lock is stuck and
// is worth flagging.

// ============================================================
// POST /admin/qb/sync-items — gank now: enqueue a fresh QB item query
// ============================================================
// QBWC auto-queues an item sync hourly, but admins want a "do it now"
// button when prices/items just changed in QB and they need them in
// Sundog before the next billing batch. Idempotent — if a query is
// already in flight (pending or sent), returns the existing entry's
// status instead of stacking another.

adminRouter.post('/qb/sync-items', requirePermission('billing:qb_sync'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.qbSyncQueue.findFirst({
      where: { entityType: 'item', action: 'query', status: { in: ['pending', 'sent'] } },
      select: { id: true, status: true, createdAt: true },
    });
    if (existing) {
      res.json({
        queued: false,
        message: `Item sync already ${existing.status} (queued ${existing.createdAt.toISOString()})`,
        entry: existing,
      });
      return;
    }

    const entry = await prisma.qbSyncQueue.create({
      data: {
        entityType: 'item',
        action: 'query',
        entityId: 'all-items',
        priority: 5, // bumped above the auto-queue priority — admin-initiated > scheduled
        status: 'pending',
      },
      select: { id: true, status: true, createdAt: true },
    });

    console.log(`[QBWC] Manual item sync queued by ${req.user?.userId || 'unknown'}`);
    res.json({
      queued: true,
      message: 'Item sync queued — QBWC will pick it up on next poll.',
      entry,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/qb/sync-price-levels — gank now: enqueue a fresh PriceLevel pull.
// Same idempotency pattern as sync-items.

adminRouter.post('/qb/sync-price-levels', requirePermission('billing:qb_sync'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.qbSyncQueue.findFirst({
      where: { entityType: 'price_level', action: 'query', status: { in: ['pending', 'sent'] } },
      select: { id: true, status: true, createdAt: true },
    });
    if (existing) {
      res.json({
        queued: false,
        message: `Price level sync already ${existing.status} (queued ${existing.createdAt.toISOString()})`,
        entry: existing,
      });
      return;
    }

    const entry = await prisma.qbSyncQueue.create({
      data: {
        entityType: 'price_level',
        action: 'query',
        entityId: 'all-price-levels',
        priority: 5,
        status: 'pending',
      },
      select: { id: true, status: true, createdAt: true },
    });

    console.log(`[QBWC] Manual price level sync queued by ${req.user?.userId || 'unknown'}`);
    res.json({
      queued: true,
      message: 'Price level sync queued — QBWC will pick it up on next poll.',
      entry,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/qb/sync-sales-tax — gank now: enqueue a fresh QB sales-tax pull
// (ItemSalesTaxQueryRq + ItemSalesTaxGroupQueryRq). QBWC auto-queues this daily,
// but admins want a "do it now" button after editing tax items in QB. Same
// idempotency pattern as sync-items.
adminRouter.post('/qb/sync-sales-tax', requirePermission('billing:qb_sync'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.qbSyncQueue.findFirst({
      where: { entityType: 'sales_tax', action: 'query', status: { in: ['pending', 'sent'] } },
      select: { id: true, status: true, createdAt: true },
    });
    if (existing) {
      res.json({
        queued: false,
        message: `Sales-tax sync already ${existing.status} (queued ${existing.createdAt.toISOString()})`,
        entry: existing,
      });
      return;
    }

    const entry = await prisma.qbSyncQueue.create({
      data: {
        entityType: 'sales_tax',
        action: 'query',
        entityId: 'all-sales-tax',
        priority: 5, // admin-initiated > scheduled
        status: 'pending',
      },
      select: { id: true, status: true, createdAt: true },
    });

    console.log(`[QBWC] Manual sales-tax sync queued by ${req.user?.userId || 'unknown'}`);
    res.json({
      queued: true,
      message: 'Sales-tax sync queued — QBWC will pick it up on next poll.',
      entry,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/qb/sales-tax — reconciliation view. Lists the QB tax records we
// pulled, plus every SalesTaxRate.qbTaxItemName and whether it matches a real
// QB record. `unmatched` rows are exactly the ones that 3140 on push — fix
// their qbTaxItemName to one of the listed `qbRecords[].fullName` values.
adminRouter.get('/qb/sales-tax', requirePermission('billing:qb_sync'), async (_req: Request, res: Response, next) => {
  try {
    const [qbRecords, rates] = await Promise.all([
      prisma.qbSalesTaxRecord.findMany({ orderBy: [{ recordType: 'asc' }, { fullName: 'asc' }] }),
      prisma.salesTaxRate.findMany({
        select: { id: true, name: true, rate: true, county: true, qbTaxItemName: true, active: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    // Case-insensitive lookup of valid QB names (active records only).
    const validNames = new Map(
      qbRecords.filter(r => r.isActive).map(r => [r.fullName.toLowerCase(), r.fullName]),
    );

    const reconciliation = rates.map(r => {
      const mapped = r.qbTaxItemName?.trim() || null;
      const matchedName = mapped ? validNames.get(mapped.toLowerCase()) || null : null;
      return {
        salesTaxRateId: r.id,
        name: r.name,
        county: r.county,
        rate: r.rate,
        active: r.active,
        qbTaxItemName: mapped,
        status: !mapped ? 'unmapped' : matchedName ? 'ok' : 'unmatched',
      };
    });

    const unmatched = reconciliation.filter(r => r.status === 'unmatched');
    res.json({
      lastSyncedAt: qbRecords[0]?.lastSyncedAt ?? null,
      qbRecordCount: qbRecords.length,
      qbRecords,
      reconciliation,
      unmatchedCount: unmatched.length,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/qb/sales-tax-mapping — set a SalesTaxRate's qbTaxItemName to a
// real QB record name (the fix for a 3140 mismatch). Admin-only. Pass an empty
// qbTaxItemName to clear the mapping. Doesn't block on an unknown name (lets you
// pre-map before the first QB pull) but reports back whether it matched a real
// active QB record so the UI can flag it.
adminRouter.patch('/qb/sales-tax-mapping', requirePermission('billing:qb_sync'), async (req: Request, res: Response, next) => {
  try {
    const { salesTaxRateId, qbTaxItemName } = (req.body ?? {}) as { salesTaxRateId?: unknown; qbTaxItemName?: unknown };
    if (typeof salesTaxRateId !== 'string' || !salesTaxRateId) {
      res.status(400).json({ error: 'salesTaxRateId is required' });
      return;
    }
    const name = typeof qbTaxItemName === 'string' && qbTaxItemName.trim() ? qbTaxItemName.trim() : null;

    const rate = await prisma.salesTaxRate.findUnique({ where: { id: salesTaxRateId } });
    if (!rate) {
      res.status(404).json({ error: 'Sales tax rate not found' });
      return;
    }

    let matched = false;
    if (name) {
      const rec = await prisma.qbSalesTaxRecord.findFirst({
        where: { fullName: { equals: name, mode: 'insensitive' }, isActive: true },
      });
      matched = !!rec;
    }

    await prisma.salesTaxRate.update({
      where: { id: salesTaxRateId },
      data: { qbTaxItemName: name },
    });

    console.log(`[QB] sales-tax mapping "${rate.name}" → ${name ?? '(cleared)'} by ${req.user?.userId || 'unknown'}`);
    res.json({
      ok: true,
      salesTaxRateId,
      qbTaxItemName: name,
      status: !name ? 'unmapped' : matched ? 'ok' : 'unmatched',
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// QuickBooks customer list — pull, review, link
// ============================================================
// POST /admin/qb/sync-customers — enqueue a pull of the whole QB customer
// list. This button is the ONLY way a customer pull happens (scheduled pulls
// don't work against QB Desktop). Same idempotency pattern as sync-items.
adminRouter.post('/qb/sync-customers', requirePermission('billing:qb_sync'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.qbSyncQueue.findFirst({
      where: { entityType: 'customer_list', action: 'query', status: { in: ['pending', 'sent'] } },
      select: { id: true, status: true, createdAt: true },
    });
    if (existing) {
      res.json({ queued: false, message: `Customer pull already ${existing.status} (queued ${existing.createdAt.toISOString()})`, entry: existing });
      return;
    }
    const entry = await prisma.qbSyncQueue.create({
      data: { entityType: 'customer_list', action: 'query', entityId: 'all-customers', priority: 5, status: 'pending' },
      select: { id: true, status: true, createdAt: true },
    });
    console.log(`[QBWC] Manual customer pull queued by ${req.user?.userId || 'unknown'}`);
    res.json({ queued: true, message: 'Customer pull queued — QBWC will pick it up on next poll.', entry });
  } catch (err) {
    next(err);
  }
});

// GET /admin/qb/customers — QuickBooks customers no Sundog company is linked
// to. Jobs (sub-customers), inactive and ignored rows are hidden unless asked
// for: ?jobs=1&inactive=1&ignored=1.
adminRouter.get('/qb/customers', requirePermission('billing:qb_sync'), async (req: Request, res: Response, next) => {
  try {
    const on = (k: string) => req.query[k] === '1' || req.query[k] === 'true';
    const [mirror, linked, lastPull] = await Promise.all([
      prisma.qbCustomer.findMany({ orderBy: { fullName: 'asc' } }),
      prisma.company.findMany({ where: { OR: [{ qbCustomerListId: { not: null } }, { isActive: true }] }, select: { id: true, name: true, qbCustomerListId: true } }),
      prisma.qbSyncQueue.findFirst({
        where: { entityType: 'customer_list', action: 'query', status: 'success' },
        orderBy: { completedAt: 'desc' }, select: { completedAt: true },
      }),
    ]);
    const held = new Set(linked.map(c => c.qbCustomerListId).filter(Boolean));
    const unlinked = mirror.filter(c => !held.has(c.qbListId));
    // Near-name suggestions come from Sundog customers that have no QuickBooks
    // link yet. Rows with a suggestion sort first: they are one click from done.
    const linkable = linked.filter(c => !c.qbCustomerListId).map(c => ({ id: c.id, name: c.name }));
    const unmatched = unlinked
      .filter(c => (on('jobs') || c.sublevel === 0) && (on('inactive') || c.isActive) && (on('ignored') || !c.ignored))
      .map(c => ({ ...c, suggestions: suggestCompanyMatches(c.name, linkable) }))
      .sort((a, b) => Number(b.suggestions.length > 0) - Number(a.suggestions.length > 0));
    res.json({
      lastPulledAt: lastPull?.completedAt ?? null,
      qbCustomerCount: mirror.length,
      linkedCount: mirror.length - unlinked.length,
      unmatchedCount: unmatched.length,
      unlinkedSundogCount: linkable.length,
      unmatched: unmatched.slice(0, 500),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/qb/customers/:id — mark a QuickBooks customer as deliberately
// not a Sundog customer (or undo that).
adminRouter.patch('/qb/customers/:id', requirePermission('billing:qb_sync'), async (req: Request, res: Response, next) => {
  try {
    const { ignored } = (req.body ?? {}) as { ignored?: unknown };
    if (typeof ignored !== 'boolean') {
      res.status(400).json({ error: 'ignored (boolean) is required' });
      return;
    }
    const updated = await prisma.qbCustomer.updateMany({ where: { id: req.params.id as string }, data: { ignored } });
    if (!updated.count) {
      res.status(404).json({ error: 'QuickBooks customer not found' });
      return;
    }
    res.json({ ok: true, ignored });
  } catch (err) {
    next(err);
  }
});

// POST /admin/qb/customers/:id/link — bind an existing Sundog company to this
// QuickBooks customer. Refuses to steal: the company must be unlinked and the
// QB customer must not already belong to another company.
adminRouter.post('/qb/customers/:id/link', requirePermission('customers:manage'), async (req: Request, res: Response, next) => {
  try {
    const { companyId } = (req.body ?? {}) as { companyId?: unknown };
    if (typeof companyId !== 'string' || !companyId) {
      res.status(400).json({ error: 'companyId is required' });
      return;
    }
    const [qb, company] = await Promise.all([
      prisma.qbCustomer.findUnique({ where: { id: req.params.id as string } }),
      prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, qbCustomerListId: true, qbCustomerFullName: true } }),
    ]);
    if (!qb || !company) {
      res.status(404).json({ error: !qb ? 'QuickBooks customer not found' : 'Company not found' });
      return;
    }
    if (company.qbCustomerListId && company.qbCustomerListId !== qb.qbListId) {
      res.status(409).json({ error: `${company.name} is already linked to a different QuickBooks customer` });
      return;
    }
    const holder = await prisma.company.findFirst({
      where: { qbCustomerListId: qb.qbListId, NOT: { id: company.id } }, select: { name: true },
    });
    if (holder) {
      res.status(409).json({ error: `That QuickBooks customer is already linked to ${holder.name}` });
      return;
    }
    const after = await prisma.company.update({
      where: { id: company.id },
      data: { qbCustomerListId: qb.qbListId, qbCustomerFullName: qb.fullName },
      select: { id: true, name: true, qbCustomerListId: true, qbCustomerFullName: true },
    });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'company', entityId: company.id, action: 'update',
      changes: { before: company, after }, ipAddress: req.ip,
    });
    res.json({ ok: true, company: after });
  } catch (err) {
    next(err);
  }
});

// POST /admin/qb/customers/:id/create-company — make a Sundog customer from a
// QuickBooks one by hand. The pull already does this for active top-level
// customers; this covers what it skips (jobs, inactive). A same-named active
// company blocks it (link that one instead).
adminRouter.post('/qb/customers/:id/create-company', requirePermission('customers:manage'), async (req: Request, res: Response, next) => {
  try {
    const qb = await prisma.qbCustomer.findUnique({ where: { id: req.params.id as string } });
    if (!qb) {
      res.status(404).json({ error: 'QuickBooks customer not found' });
      return;
    }
    const clash = await prisma.company.findFirst({
      where: { OR: [
        { qbCustomerListId: qb.qbListId },
        { isActive: true, name: { equals: qb.name, mode: 'insensitive' } },
      ] },
      select: { id: true, name: true, qbCustomerListId: true },
    });
    if (clash) {
      res.status(409).json({
        error: clash.qbCustomerListId === qb.qbListId
          ? `Already linked to ${clash.name}`
          : `A customer named ${clash.name} already exists — link it instead`,
        companyId: clash.id,
      });
      return;
    }
    const data = {
      name: qb.name, companyType: 'customer' as const,
      phone: qb.phone, email: qb.email, address: qb.address, city: qb.city, state: qb.state, zip: qb.zip,
      qbCustomerListId: qb.qbListId, qbCustomerFullName: qb.fullName,
    };
    const company = await prisma.company.create({ data });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'company', entityId: company.id, action: 'create',
      changes: { ...data, source: 'quickbooks_customer_pull' }, ipAddress: req.ip,
    });
    res.status(201).json({ ok: true, company: { id: company.id, name: company.name } });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /admin/qb/failed — list dead QB sync entries (for triage + retry)
// ============================================================
// Surfaces every entry the dispatcher will no longer pick up: anything
// in 'error', plus 'pending'/'sent' rows that maxed out retry_count.
// (The dispatcher only takes status='pending' AND retry_count < MAX_RETRIES,
// and the hourly stuck-recovery only rescues recent 'sent' rows — see qbwc.ts.)
// Includes the error message + code so an admin can tell a transient
// connection failure (safe to retry) from a hard QB rejection (3140 bad
// ref, 0x80040400 parse error) that needs a data fix, not a retry.
//
// QB_MAX_RETRIES mirrors MAX_RETRIES in qbwc.ts (kept local to avoid a
// route↔route import cycle). Keep the two in sync.
const QB_MAX_RETRIES = 3;

adminRouter.get('/qb/failed', requirePermission('billing:qb_sync'), async (_req: Request, res: Response, next) => {
  try {
    const entries = await prisma.qbSyncQueue.findMany({
      where: {
        OR: [
          { status: 'error' },
          { status: 'pending', retryCount: { gte: QB_MAX_RETRIES } },
          { status: 'sent', retryCount: { gte: QB_MAX_RETRIES } },
        ],
      },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        action: true,
        status: true,
        retryCount: true,
        errorCode: true,
        errorMessage: true,
        createdAt: true,
        sentAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ count: entries.length, entries });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// GET /admin/qb/failed/:id — one dead entry, in full
// ============================================================
// The list above carries error_message only, which is a one-line summary and
// (for a qbXML parse rejection) rarely enough to name the offending element.
// The expand in the Ops Dashboard pulls this to show the whole thing plus the
// exact qbXML we sent and the raw response QB sent back — that pair is what
// actually identifies a bad ref, a missing element or an unmapped tax item.
//
// The bodies can be tens of KB, so they're deliberately NOT in the list
// payload; one row at a time, on demand.
adminRouter.get('/qb/failed/:id', requirePermission('billing:qb_sync'), async (req: Request, res: Response, next) => {
  try {
    const entry = await prisma.qbSyncQueue.findUnique({
      where: { id: String(req.params.id) },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        action: true,
        status: true,
        retryCount: true,
        errorCode: true,
        errorMessage: true,
        qbxmlRequest: true,
        qbxmlResponse: true,
        createdAt: true,
        sentAt: true,
        completedAt: true,
      },
    });
    if (!entry) {
      res.status(404).json({ error: 'Queue entry not found' });
      return;
    }
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /admin/qb/retry-failed — revive dead QB sync entries
// ============================================================
// Flips dead entries (see GET /qb/failed for the criteria) back to
// 'pending' with retry_count=0 and clears the error fields, so the next
// QBWC poll re-sends them. Optional body { ids: [...] } scopes the reset
// to specific rows (e.g. retry only the ones whose root cause you fixed);
// omit it to revive everything dead.
//
// NOTE: this does NOT fix bad payloads. A row that died on a hard QB
// rejection (3140 invalid ref, 0x80040400 parse error) will re-fail
// identically — fix the underlying reference/XML first, then retry that
// row. Best for genuine connection-loss victims (QB/Web Connector was
// down when they were sent).
adminRouter.post('/qb/retry-failed', requirePermission('billing:qb_sync'), async (req: Request, res: Response, next) => {
  try {
    const rawIds = (req.body?.ids ?? null) as unknown;
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((x): x is string => typeof x === 'string')
      : null;

    const deadFilter = {
      OR: [
        { status: 'error' as const },
        { status: 'pending' as const, retryCount: { gte: QB_MAX_RETRIES } },
        { status: 'sent' as const, retryCount: { gte: QB_MAX_RETRIES } },
      ],
    };
    const where = ids
      ? { AND: [{ id: { in: ids } }, deadFilter] }
      : deadFilter;

    const { count } = await prisma.qbSyncQueue.updateMany({
      where,
      data: {
        status: 'pending',
        retryCount: 0,
        errorMessage: null,
        errorCode: null,
        sentAt: null,
        completedAt: null,
      },
    });

    console.log(`[QBWC] ${count} failed entries reset → pending by ${req.user?.userId || 'unknown'}${ids ? ` (scoped to ${ids.length} ids)` : ' (all dead)'}`);
    res.json({
      retried: count,
      message: count === 0
        ? 'No dead entries to retry.'
        : `${count} entr${count === 1 ? 'y' : 'ies'} reset to pending — QBWC will retry on next poll. (Hard rejections will re-fail until the underlying data is fixed.)`,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/jobs', requirePermission('page:ops'), async (_req: Request, res: Response, next) => {
  try {
    // Walk distinct names through the existing (job_name, started_at DESC)
    // index, then fetch one latest row each. DISTINCT ON scans every historical
    // run even though this card only displays a handful of jobs.
    const latest = await prisma.$queryRaw<Array<{
      job_name: string;
      started_at: Date;
      finished_at: Date | null;
      status: string;
      duration_ms: number | null;
      error_message: string | null;
    }>>`
      WITH RECURSIVE names AS (
        (SELECT job_name FROM job_runs ORDER BY job_name LIMIT 1)
        UNION ALL
        SELECT next_name.job_name FROM names
        CROSS JOIN LATERAL (
          SELECT job_name FROM job_runs
          WHERE job_name > names.job_name ORDER BY job_name LIMIT 1
        ) next_name
      )
      SELECT latest.* FROM names CROSS JOIN LATERAL (
        SELECT job_name, started_at, finished_at, status, duration_ms, error_message
        FROM job_runs WHERE job_name = names.job_name
        ORDER BY started_at DESC LIMIT 1
      ) latest
      ORDER BY latest.job_name
    `;

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await prisma.jobRun.groupBy({
      by: ['jobName', 'status'],
      where: { startedAt: { gte: oneHourAgo } },
      _count: { _all: true },
    });

    // Pivot recent counts into a per-job summary
    const recentByJob = new Map<string, { error: number; skipped: number; success: number }>();
    for (const r of recent) {
      const entry = recentByJob.get(r.jobName) ?? { error: 0, skipped: 0, success: 0 };
      if (r.status === 'error') entry.error += r._count._all;
      else if (r.status === 'skipped') entry.skipped += r._count._all;
      else if (r.status === 'success') entry.success += r._count._all;
      recentByJob.set(r.jobName, entry);
    }

    const jobs = latest.map(row => {
      const recentCounts = recentByJob.get(row.job_name) ?? { error: 0, skipped: 0, success: 0 };
      return {
        jobName: row.job_name,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        durationMs: row.duration_ms,
        errorMessage: row.error_message,
        recentLastHour: recentCounts,
      };
    });

    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// Bug reports / feature requests — submitted from the sidebar
// widget, persisted so they survive a mail outage and surface here.
// ============================================================

adminRouter.get('/bug-reports', requirePermission('page:ops'), async (req: Request, res: Response, next) => {
  try {
    const status = req.query.status as string | undefined;
    const where = status === 'open' || status === 'resolved' ? { status } : {};
    const [reports, openCount] = await Promise.all([
      prisma.bugReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.bugReport.count({ where: { status: 'open' } }),
    ]);
    res.json({ reports, openCount });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/bug-reports/:id', requirePermission('page:ops'), async (req: Request, res: Response, next) => {
  try {
    const status = (req.body as { status?: string }).status;
    if (status !== 'open' && status !== 'resolved') {
      res.status(400).json({ error: "status must be 'open' or 'resolved'" });
      return;
    }
    const updated = await prisma.bugReport.update({
      where: { id: String(req.params.id) },
      data: { status },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// v1 API keys — issue/revoke tokens for external consumers
// (BlueLion's card.issued flag token, bolt-on read keys).
// Plaintext is returned ONCE from POST and never stored.
// ============================================================

adminRouter.get('/api-keys', requirePermission('page:api_keys'), async (_req: Request, res: Response, next) => {
  try {
    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { name: true } } },
    });
    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        label: k.label,
        prefixHint: k.prefixHint,
        scopes: k.scopes,
        allowedIps: k.allowedIps,
        revoked: k.revoked,
        revokedAt: k.revokedAt,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
        createdBy: k.createdBy?.name ?? null,
      })),
      // Legacy env-configured keys (V1_API_KEYS) — visible so nobody forgets
      // they exist; manage those by editing the server env.
      envKeys: loadApiKeys().map((k) => ({ id: k.id, label: k.label ?? null, scopes: k.scopes, revoked: !!k.revoked })),
      scopes: V1_SCOPES,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/api-keys', requirePermission('page:api_keys'), async (req: Request, res: Response, next) => {
  try {
    const { label, scopes, allowedIps } = req.body as {
      label?: string;
      scopes?: string[];
      allowedIps?: string[];
    };
    if (!label || typeof label !== 'string' || !label.trim()) {
      res.status(400).json({ error: 'label is required' });
      return;
    }
    const validScopes = new Set<string>(V1_SCOPES);
    const requested = Array.isArray(scopes) ? scopes.filter((s) => typeof s === 'string') : [];
    if (requested.length === 0) {
      res.status(400).json({ error: 'At least one scope is required' });
      return;
    }
    const unknown = requested.filter((s) => !validScopes.has(s));
    if (unknown.length) {
      res.status(400).json({ error: `Unknown scope(s): ${unknown.join(', ')}` });
      return;
    }
    const ips = Array.isArray(allowedIps)
      ? allowedIps.map((s) => String(s).trim()).filter(Boolean)
      : [];

    const issued = await issueApiKey({
      label: label.trim(),
      scopes: requested,
      allowedIps: ips,
      createdById: req.user?.userId,
    });

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'api_key',
      entityId: issued.id,
      action: 'create',
      changes: { label: issued.label, scopes: requested, allowedIps: ips, prefixHint: issued.prefixHint },
    });

    // `key` is the only time the plaintext ever leaves the server.
    res.status(201).json({ id: issued.id, label: issued.label, prefixHint: issued.prefixHint, scopes: requested, key: issued.plaintext });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/api-keys/:id/revoke', requirePermission('page:api_keys'), async (req: Request, res: Response, next) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    if (existing.revoked) {
      res.json({ ok: true, message: 'Already revoked' });
      return;
    }
    const updated = await prisma.apiKey.update({
      where: { id },
      data: { revoked: true, revokedAt: new Date() },
    });
    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'api_key',
      entityId: id,
      action: 'update',
      changes: { action: 'revoke', label: existing.label },
    });
    res.json({ ok: true, revokedAt: updated.revokedAt });
  } catch (err) {
    next(err);
  }
});
