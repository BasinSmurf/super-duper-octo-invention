// Billing Lineage Phase 1 — manual-entry fallback for mirrored facts.
//
// Handoff §3.2: "If not [an API status], a manual-entry endpoint that
// requires source_actor and an explicit as-of date. Renders as 'Disputed ·
// confirmed by Max · 8/5'. Hearsay, labeled as hearsay, which is acceptable."
//
// This is the ONLY route that can write a billing_observation with
// source:'human' — sourceActor is always resolved from the authenticated
// session, never trusted from the request body, so it's impossible to write
// a human observation without an attributed actor (also enforced by the DB
// CHECK constraint in the migration, belt-and-suspenders).

import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { recordObservation } from '../services/billingObservations.js';
import { createAuditLog } from '../utils/auditLog.js';
import { rebillingReportFilter, combineRebillingTotals } from '../services/rebillingReport.js';

export const billingRouter = Router();

// Complete-history totals; the detail page size never limits the aggregates.
billingRouter.get('/rebilling', async (req: Request, res: Response, next) => {
  try {
    const where = rebillingReportFilter(req.query);
    const page = Number(req.query.page ?? 0);
    if (!Number.isSafeInteger(page) || page < 0) throw new AppError(400, 'Invalid page');
    const group = { by: ['companyId', 'companyName', 'qbCustomerOverride'] as Array<'companyId' | 'companyName' | 'qbCustomerOverride'>,
      _count: { _all: true as const }, _sum: { total: true as const } };
    const [posted, pending, invoices, total] = await Promise.all([
      prisma.invoice.groupBy({ ...group, where: { ...where, qbInvoiceTxnId: { not: null } } }),
      prisma.invoice.groupBy({ ...group, where: { ...where, qbInvoiceTxnId: null } }),
      prisma.invoice.findMany({ where, take: 50, skip: page * 50,
        orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
        select: { id: true, invoiceNumber: true, companyName: true, qbCustomerOverride: true,
          invoiceDate: true, total: true, status: true, qbInvoiceTxnId: true, qbInvoiceNumber: true } }),
      prisma.invoice.count({ where }),
    ]);
    res.json({ groups: combineRebillingTotals(posted, pending), invoices, total, hasMore: total > (page + 1) * 50 });
  } catch (error) { next(error); }
});

// Search all identifier spaces together; only load the full lineage after selection.
billingRouter.get('/lineage/search', async (req: Request, res: Response, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) throw new AppError(400, 'q is required');
    const page = Number(req.query.page ?? 0);
    if (!Number.isSafeInteger(page) || page < 0) throw new AppError(400, 'Invalid page');
    const contains = { contains: q, mode: 'insensitive' as const };
    const docWhere = { OR: [
      { docNumber: contains }, { qbTxnId: contains },
      { submissions: { some: { externalRef: contains } } },
    ] };
    const ticketWhere = { ticketNumber: contains };
    const take = 100;
    const [documents, tickets, documentCount, ticketCount] = await Promise.all([
      prisma.billingDocRef.findMany({
        where: docWhere, skip: page * take, take,
        orderBy: [{ docNumber: 'asc' }, { revision: 'asc' }, { id: 'asc' }],
        select: { id: true, docNumber: true, docType: true, revision: true, qbTxnId: true },
      }),
      prisma.serviceTicket.findMany({
        where: ticketWhere, skip: page * take, take,
        orderBy: [{ ticketNumber: 'asc' }, { id: 'asc' }],
        select: { id: true, ticketNumber: true, workDescription: true, status: true },
      }),
      prisma.billingDocRef.count({ where: docWhere }),
      prisma.serviceTicket.count({ where: ticketWhere }),
    ]);
    res.json({ documents, tickets, total: documentCount + ticketCount,
      hasMore: Math.max(documentCount, ticketCount) > (page + 1) * take });
  } catch (err) {
    next(err);
  }
});

// POST /api/billing/observations — manual mirror entry (source: human only)
billingRouter.post('/observations', requirePermission('billing:record_observation'), async (req: Request, res: Response, next) => {
  try {
    const { docRefId, docLineRefId, ticketId, factKey, factValue, asOf } = req.body ?? {};

    const subjectKeys = ['docRefId', 'docLineRefId', 'ticketId'].filter((k) => req.body?.[k] != null);
    if (subjectKeys.length !== 1) {
      throw new AppError(400, 'Exactly one of docRefId, docLineRefId, ticketId must be set');
    }
    if (!factKey || typeof factKey !== 'string') {
      throw new AppError(400, 'factKey is required');
    }
    if (factValue === undefined) {
      throw new AppError(400, 'factValue is required');
    }
    if (!asOf) {
      throw new AppError(400, 'asOf is required — an explicit date, not defaulted to now (Rule 3: freshness is computed, never stamped at write time)');
    }
    const asOfDate = new Date(asOf);
    if (Number.isNaN(asOfDate.getTime())) {
      throw new AppError(400, 'asOf is not a valid date');
    }

    const subject = docRefId ? { docRefId } : docLineRefId ? { docLineRefId } : { ticketId };

    // sourceActor is meant to render as "confirmed by Max," not a raw user id
    // (handoff §2.5's own example string) — resolve the display name server-side,
    // same "never trust the client for this" rule as the id itself.
    const actorUser = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { name: true, email: true } });
    const sourceActor = actorUser?.name || actorUser?.email || req.user!.userId;

    const observation = await recordObservation(prisma, subject as any, {
      factKey,
      factValue,
      source: 'human',
      sourceActor,
      asOf: asOfDate,
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'billing_observation',
      entityId: observation.id,
      action: 'create',
      changes: { subject, factKey, asOf: asOfDate.toISOString() },
      ipAddress: req.ip,
    });

    res.status(201).json(observation);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/billing/lineage?q=<identifier> — the lineage resolver.
//
// Handoff §4.1: "Accepts a ticket number, invoice number, credit memo
// number, QuickBooks TxnID, or an operator's external submission reference.
// Resolves all of them to the same lineage view." One search box, one page —
// this is the answer to "I can't figure out where this went."
// ---------------------------------------------------------------------------
billingRouter.get('/lineage', async (req: Request, res: Response, next) => {
  try {
    const q = (req.query.q as string | undefined)?.trim();
    if (!q) throw new AppError(400, 'q is required');

    let anchorDocRefIds: string[] = [];
    let resolvedVia: string | null = null;
    let anchorTicketId: string | null = null;

    // Try each identifier space in turn — first hit wins. Order is cheapest
    // (exact-match indexed lookups) first.
    const selectedTicketId = typeof req.query.ticketId === 'string' ? req.query.ticketId : undefined;
    const selectedDocRefId = typeof req.query.docRefId === 'string' ? req.query.docRefId : undefined;
    const byDocNumber = selectedTicketId ? [] : await prisma.billingDocRef.findMany({ where: selectedDocRefId ? { id: selectedDocRefId } : { docNumber: q }, select: { id: true } });
    if (byDocNumber.length > 0) {
      anchorDocRefIds = byDocNumber.map((d) => d.id);
      resolvedVia = 'doc_number';
    }

    if (anchorDocRefIds.length === 0 && !selectedTicketId && !selectedDocRefId) {
      const byTxnId = await prisma.billingDocRef.findMany({ where: { qbTxnId: q }, select: { id: true } });
      if (byTxnId.length > 0) {
        anchorDocRefIds = byTxnId.map((d) => d.id);
        resolvedVia = 'qb_txn_id';
      }
    }

    if (anchorDocRefIds.length === 0 && !selectedTicketId && !selectedDocRefId) {
      const bySubmission = await prisma.billingSubmission.findFirst({ where: { externalRef: q }, select: { docRefId: true } });
      if (bySubmission) {
        anchorDocRefIds = [bySubmission.docRefId];
        resolvedVia = 'submission_external_ref';
      }
    }

    if (anchorDocRefIds.length === 0 && !selectedDocRefId) {
      const ticket = await prisma.serviceTicket.findUnique({ where: selectedTicketId ? { id: selectedTicketId } : { ticketNumber: q }, select: { id: true } });
      if (ticket) {
        anchorTicketId = ticket.id;
        resolvedVia = 'ticket_number';
        const lineRefs = await prisma.billingDocLineRef.findMany({ where: { ticketId: ticket.id }, select: { docRefId: true } });
        anchorDocRefIds = [...new Set(lineRefs.map((l) => l.docRefId))];
      }
    }

    if (!resolvedVia) {
      throw new AppError(404, `No ticket, invoice, credit memo, QuickBooks TxnID, or submission reference matches "${q}"`);
    }

    // Walk supersedes/supersededBy from every anchor, plus every doc sharing
    // a docNumber with an anchor (same-number resubmission revisions) —
    // breadth-first, capped defensively since no supersession data exists
    // yet (Phase 4/5 territory) but the shape should already hold up.
    const allDocRefIds = new Set(anchorDocRefIds);
    const seenDocNumbers = new Set<string>();
    let frontier = [...anchorDocRefIds];
    for (let hop = 0; hop < 10 && frontier.length > 0; hop++) {
      const rows = await prisma.billingDocRef.findMany({
        where: { id: { in: frontier } },
        select: { id: true, docNumber: true, supersedesId: true, supersededById: true },
      });
      const nextFrontier: string[] = [];
      for (const row of rows) {
        if (row.supersedesId && !allDocRefIds.has(row.supersedesId)) nextFrontier.push(row.supersedesId);
        if (row.supersededById && !allDocRefIds.has(row.supersededById)) nextFrontier.push(row.supersededById);
        if (!seenDocNumbers.has(row.docNumber)) {
          seenDocNumbers.add(row.docNumber);
          const siblings = await prisma.billingDocRef.findMany({ where: { docNumber: row.docNumber }, select: { id: true } });
          for (const s of siblings) if (!allDocRefIds.has(s.id)) nextFrontier.push(s.id);
        }
      }
      nextFrontier.forEach((id) => allDocRefIds.add(id));
      frontier = nextFrontier;
    }

    const docRefIds = [...allDocRefIds];

    const [docRefs, lines, submissions, docRefObservations] = await Promise.all([
      prisma.billingDocRef.findMany({ where: { id: { in: docRefIds } }, orderBy: [{ docNumber: 'asc' }, { revision: 'asc' }] }),
      prisma.billingDocLineRef.findMany({
        where: { docRefId: { in: docRefIds } },
        include: { ticket: { select: { ticketNumber: true, status: true, billingReadiness: true, workDescription: true } } },
        orderBy: [{ docRefId: 'asc' }, { lineNo: 'asc' }],
      }),
      prisma.billingSubmission.findMany({ where: { docRefId: { in: docRefIds } }, orderBy: { submittedAt: 'desc' } }),
      prisma.billingObservation.findMany({ where: { docRefId: { in: docRefIds } }, orderBy: { asOf: 'desc' } }),
    ]);

    const lineRefIds = lines.map((l) => l.id);
    const ticketIdsInvolved = [...new Set([...(anchorTicketId ? [anchorTicketId] : []), ...lines.map((l) => l.ticketId)])];

    const [lineObservations, ticketObservations, invoiceMeta] = await Promise.all([
      lineRefIds.length ? prisma.billingObservation.findMany({ where: { docLineRefId: { in: lineRefIds } }, orderBy: { asOf: 'desc' } }) : [],
      ticketIdsInvolved.length ? prisma.billingObservation.findMany({ where: { ticketId: { in: ticketIdsInvolved } }, orderBy: { asOf: 'desc' } }) : [],
      prisma.invoice.findMany({
        where: { invoiceNumber: { in: docRefs.map((d) => d.docNumber) } },
        select: { invoiceNumber: true, id: true, status: true, total: true, companyName: true },
      }),
    ]);
    const invoiceByDocNumber = new Map(invoiceMeta.map((i) => [i.invoiceNumber, i]));
    const sourceTickets = ticketIdsInvolved.length ? await prisma.serviceTicket.findMany({
      where: { id: { in: ticketIdsInvolved } }, select: { id: true, ticketNumber: true, offlineId: true, companyId: true },
    }) : [];
    const sourceLinks = sourceTickets.flatMap(ticket => [...new Set([ticket.id, ticket.offlineId].filter((id): id is string => !!id))]
      .map(sourceId => ({ workOrder: { companyId: ticket.companyId }, customData: { path: ['fieldInspectionRecord', 'sourceTicketOfflineId'], equals: sourceId } })));
    const relatedItems = sourceLinks.length ? await prisma.shopWorkOrderItem.findMany({
      where: { OR: sourceLinks }, select: { workOrder: { select: { id: true, workOrderNumber: true, status: true } } },
    }) : [];
    const relatedShopOrders = [...new Map(relatedItems.map(item => [item.workOrder.id, item.workOrder])).values()];

    res.json({
      resolvedVia,
      tickets: sourceTickets.map(({ id, ticketNumber }) => ({ ticketId: id, ticketNumber })),
      relatedShopOrders,
      docRefs: docRefs.map((d) => ({ ...d, invoice: invoiceByDocNumber.get(d.docNumber) ?? null })),
      lines,
      submissions,
      observations: [...docRefObservations, ...lineObservations, ...ticketObservations].sort(
        (a, b) => b.asOf.getTime() - a.asOf.getTime(),
      ),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/billing/observations/latest?docNumbers=a,b,c — batch pill data for
// a list page (BillingPage.tsx). One request for the whole visible list
// instead of one lineage fetch per card. Returns only the latest observation
// per (docNumber, factKey) — dedupe done in JS since list-page sizes are
// small (a page of invoices, not the whole table); not worth a raw DISTINCT
// ON query for that.
// ---------------------------------------------------------------------------
billingRouter.get('/observations/latest', async (req: Request, res: Response, next) => {
  try {
    const raw = (req.query.docNumbers as string | undefined) ?? '';
    const docNumbers = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (docNumbers.length === 0) {
      res.json({});
      return;
    }

    const docRefs = await prisma.billingDocRef.findMany({
      where: { docNumber: { in: docNumbers } },
      select: { id: true, docNumber: true },
    });
    if (docRefs.length === 0) {
      res.json({});
      return;
    }
    const docNumberByRefId = new Map(docRefs.map((d) => [d.id, d.docNumber]));

    // Sorted desc by as_of — first occurrence per (docNumber, factKey) wins.
    const observations = await prisma.billingObservation.findMany({
      where: { docRefId: { in: docRefs.map((d) => d.id) } },
      orderBy: { asOf: 'desc' },
      select: { docRefId: true, factKey: true, factValue: true, source: true, sourceActor: true, asOf: true },
    });

    const result: Record<string, Record<string, { factValue: unknown; source: string; sourceActor: string | null; asOf: Date }>> = {};
    for (const obs of observations) {
      const docNumber = obs.docRefId ? docNumberByRefId.get(obs.docRefId) : undefined;
      if (!docNumber) continue;
      result[docNumber] ??= {};
      if (result[docNumber][obs.factKey]) continue; // already have the latest (desc order) for this fact
      result[docNumber][obs.factKey] = { factValue: obs.factValue, source: obs.source, sourceActor: obs.sourceActor, asOf: obs.asOf };
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/billing/reason-codes — active vocabulary for the not_billable
// reason picker. Admin-editable table (billing_reason_code) — the client
// fetches this rather than hardcoding the seeded list, so an admin adding a
// code doesn't require a client redeploy.
billingRouter.get('/reason-codes', async (_req: Request, res: Response, next) => {
  try {
    const codes = await prisma.billingReasonCode.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, phase: true, label: true },
    });
    res.json(codes);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/billing/attention-list — handoff §4.3. "Open dollars, oldest
// service date first." Computed on read, nothing persisted — this endpoint
// IS the acceptance criterion ("no persisted table or column backs it"), not
// just an implementation detail.
//
// A billing_doc_line_ref belongs on this list when its doc_ref's invoice is
// not void, and no 'paid' or 'written_off' billing_observation has been
// recorded yet for that doc_ref. One row per line ref — a ticket split
// across two invoices correctly appears twice, that's real, not a bug.
//
// MSA window (handoff §4.4, "stale-ticket alert"): OPEN-B2 (per-operator
// submission windows) is still unresolved, so this ships with a single
// conservative global default (STALE_TICKET_WINDOW_DAYS, default 30) and
// unconfirmedWindow:true on every row — that flag is load-bearing, not
// decoration, so nobody mistakes the default for a confirmed contractual
// number once OPEN-B2 lands and replaces it with a real per-operator value.
// ---------------------------------------------------------------------------
const STALE_WINDOW_DAYS = parseInt(process.env.STALE_TICKET_WINDOW_DAYS || '30', 10);

billingRouter.get('/attention-list', async (_req: Request, res: Response, next) => {
  try {
    const openDocRefs = await prisma.billingDocRef.findMany({
      select: { id: true, docNumber: true, docType: true },
    });
    if (openDocRefs.length === 0) {
      res.json([]);
      return;
    }
    const docRefIds = openDocRefs.map((d) => d.id);
    const docRefById = new Map(openDocRefs.map((d) => [d.id, d]));

    // Void invoices never belong on this list — same reasoning as the
    // backfill script: a void invoice never reached QB, nothing is "open."
    const invoices = await prisma.invoice.findMany({
      where: { invoiceNumber: { in: openDocRefs.map((d) => d.docNumber) } },
      select: { invoiceNumber: true, status: true, companyName: true },
    });
    const invoiceByDocNumber = new Map(invoices.map((i) => [i.invoiceNumber, i]));
    const voidDocNumbers = new Set(invoices.filter((i) => i.status === 'void').map((i) => i.invoiceNumber));

    // Every observation for these doc_refs, sorted desc by as_of — used both
    // to exclude paid/written_off lines and to surface "last mirrored status."
    const observations = await prisma.billingObservation.findMany({
      where: { docRefId: { in: docRefIds } },
      orderBy: { asOf: 'desc' },
      select: { docRefId: true, factKey: true, factValue: true, source: true, sourceActor: true, asOf: true },
    });
    const resolvedDocRefIds = new Set(
      observations.filter((o) => o.factKey === 'paid' || o.factKey === 'written_off').map((o) => o.docRefId),
    );
    const latestObsByDocRef = new Map<string, (typeof observations)[number]>();
    for (const obs of observations) {
      if (!obs.docRefId) continue;
      if (!latestObsByDocRef.has(obs.docRefId)) latestObsByDocRef.set(obs.docRefId, obs); // desc order — first wins
    }

    const lines = await prisma.billingDocLineRef.findMany({
      where: { docRefId: { in: docRefIds } },
      select: { id: true, docRefId: true, ticketId: true, ticketNumber: true, serviceDate: true, amount: true },
    });

    const now = Date.now();
    const rows = lines
      .filter((l) => {
        const docRef = docRefById.get(l.docRefId);
        if (!docRef) return false;
        if (voidDocNumbers.has(docRef.docNumber)) return false;
        if (resolvedDocRefIds.has(l.docRefId)) return false;
        return true;
      })
      .map((l) => {
        const docRef = docRefById.get(l.docRefId)!;
        const invoice = invoiceByDocNumber.get(docRef.docNumber) ?? null;
        const daysSinceService = Math.floor((now - new Date(l.serviceDate).getTime()) / (1000 * 60 * 60 * 24));
        const pctWindowConsumed = daysSinceService / STALE_WINDOW_DAYS;
        const severity = pctWindowConsumed > 1 ? 'overdue' : pctWindowConsumed >= 0.7 ? 'warning' : 'ok';
        const lastObservation = latestObsByDocRef.get(l.docRefId) ?? null;
        return {
          ticketId: l.ticketId,
          ticketNumber: l.ticketNumber,
          serviceDate: l.serviceDate,
          daysSinceService,
          amount: l.amount,
          docNumber: docRef.docNumber,
          companyName: invoice?.companyName ?? null,
          lastObservation: lastObservation
            ? {
                factKey: lastObservation.factKey,
                factValue: lastObservation.factValue,
                source: lastObservation.source,
                sourceActor: lastObservation.sourceActor,
                asOf: lastObservation.asOf,
              }
            : null,
          windowDays: STALE_WINDOW_DAYS,
          pctWindowConsumed,
          severity,
          unconfirmedWindow: true, // always true until OPEN-B2 lands — see header comment
        };
      })
      .sort((a, b) => new Date(a.serviceDate).getTime() - new Date(b.serviceDate).getTime());

    res.json(rows);
  } catch (err) {
    next(err);
  }
});
