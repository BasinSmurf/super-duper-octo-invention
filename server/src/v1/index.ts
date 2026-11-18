/**
 * v1/index.ts — the /api/v1 router.
 *
 * Read-only, curated surface (plus the BlueLion sync-management writes). Every
 * route is gated by v1Auth(scope); every response is a mapper DTO. Mounted in
 * src/index.ts as `app.use('/api/v1', v1Router)` — outside the global
 * `authenticate`, since it carries its own auth.
 */
import { Router, type Request, type Response } from 'express';
import { basename, extname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import swaggerUi from 'swagger-ui-express';
import { prisma } from '../db.js';
import { v1Auth } from './auth.js';
import { validateListQuery } from './query.js';
import { runList, sendOne, parseLimit, V1Error, v1ErrorHandler } from './respond.js';
import * as m from './mappers.js';
import { getFileStore } from '../services/fileStore.js';
import { generateInvoicePdf } from '../services/invoicePdfGenerator.js';
import { enqueueTrainingRosterForTicket } from '../services/blueLionEnqueue.js';
import { resolveClassCode } from '../services/courseCatalog.js';
import { emitEvent } from '../services/eventBus.js';
import { createAuditLog } from '../utils/auditLog.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const v1Router = Router();

const str = (q: unknown): string | undefined => (typeof q === 'string' && q.length ? q : undefined);
const bool = (q: unknown): boolean | undefined =>
  q === 'true' ? true : q === 'false' ? false : undefined;
const since = (q: unknown): Record<string, unknown> | undefined => {
  const s = str(q);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : { updatedAt: { gte: d } };
};
const merge = (...parts: unknown[]): Record<string, unknown> =>
  Object.assign({}, ...parts.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object'));
const auditUser = (req: Request) => (req.v1?.type === 'user' ? req.v1.id : undefined);
const requireScope = (req: Request, scope: string): void => {
  const sc = req.v1?.scopes ?? [];
  if (!sc.includes('*') && !sc.includes(scope)) {
    throw new V1Error(403, 'forbidden', `Missing required scope: ${scope}`);
  }
};
const FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain', '.csv': 'text/csv',
};

// ── OpenAPI docs ────────────────────────────────────────────────────────────────
// The contract is meant to be published to bolt-on builders. Gated OFF in prod
// unless V1_DOCS_ENABLED=true, per the "don't leave routes anonymous" rule.
// Swagger UI fetches the raw spec from /openapi.yaml (same-origin → CSP-safe).
const DOCS_ENABLED = process.env.NODE_ENV !== 'production' || process.env.V1_DOCS_ENABLED === 'true';
const SPEC_PATH = join(process.cwd(), 'openapi', 'servicepro-v1.yaml');
if (DOCS_ENABLED) {
  v1Router.get('/openapi.yaml', (_req: Request, res: Response) => {
    if (!existsSync(SPEC_PATH)) throw new V1Error(404, 'not_found', 'Spec file not found on server');
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    res.send(readFileSync(SPEC_PATH, 'utf8'));
  });
  v1Router.use('/docs', swaggerUi.serve, swaggerUi.setup(undefined, { swaggerOptions: { url: '/api/v1/openapi.yaml' } }));
}

// ── Tickets ───────────────────────────────────────────────────────────────────
const ticketListInclude = {
  company: { select: { id: true, name: true } },
  field: { select: { name: true } },
  pad: { select: { name: true } },
  well: { select: { wellName: true, apiNumber: true } },
  assignedTech: { select: { id: true, name: true } },
};
const ticketDetailInclude = {
  ...ticketListInclude,
  createdBy: { select: { id: true, name: true } },
  customerContact: { select: { name: true, email: true, phone: true } },
  lineItems: { orderBy: { sortOrder: 'asc' as const } },
  attachments: { orderBy: { uploadedAt: 'desc' as const }, select: { id: true, fileName: true, uploadedAt: true } },
  signatureRequest: { select: { status: true, sentToEmail: true, sentToName: true, sendCount: true, firstSentAt: true, lastSentAt: true } },
  fitTestRecords: { select: { id: true } },
  airSystemInspections: { select: { id: true } },
  ihTestRecords: { select: { id: true } },
  trainingRosterRecords: { select: { id: true } },
};

v1Router.get('/tickets', v1Auth('tickets:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.serviceTicket.findMany({ ...a, include: ticketListInclude } as any),
    where: merge(
      str(req.query.status) && { status: req.query.status as any },
      str(req.query.ticketType) && { ticketType: req.query.ticketType as any },
      str(req.query.companyId) && { companyId: req.query.companyId },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor),
    limit: parseLimit(req.query.limit),
    map: m.ticketSummary,
  });
});

v1Router.get('/tickets/:id', v1Auth('tickets:read'), async (req: Request, res: Response) => {
  const t = await prisma.serviceTicket.findUnique({ where: { id: req.params.id as string }, include: ticketDetailInclude as any });
  sendOne(req, res, t as any, (row) => m.ticketDetail(row, req.v1?.role));
});

// ── Invoices ────────────────────────────────────────────────────────────────
v1Router.get('/invoices', v1Auth('invoices:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.invoice.findMany(a as any),
    where: merge(
      str(req.query.status) && { status: req.query.status as any },
      str(req.query.companyId) && { companyId: req.query.companyId },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor),
    limit: parseLimit(req.query.limit),
    map: m.invoiceSummary,
  });
});

v1Router.get('/invoices/:id', v1Auth('invoices:read'), async (req: Request, res: Response) => {
  const inv = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    include: {
      lineItems: { orderBy: { sortOrder: 'asc' } },
      signatureRequest: { select: { status: true, sentToEmail: true, sentToName: true, sendCount: true, firstSentAt: true, lastSentAt: true } },
      billingGroup: {
        select: {
          tickets: {
            take: 100,
            select: {
              locationDisplay: true, fieldAreaName: true,
              well: { select: { wellName: true, apiNumber: true } },
              pad: { select: { name: true } },
              field: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!inv) throw new V1Error(404, 'not_found', 'Invoice not found');
  const locations = await deriveInvoiceLocations(inv);
  sendOne(req, res, inv as any, (row) => m.invoiceDetail(row, locations));
});

v1Router.get('/invoices/:id/pdf', v1Auth('invoices:read'), async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    include: {
      company: { select: { id: true, name: true } },
      approvedBy: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      lineItems: { orderBy: { sortOrder: 'asc' }, include: { product: { select: { id: true, partNumber: true, name: true } } } },
    },
  });
  if (!invoice) throw new V1Error(404, 'not_found', 'Invoice not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoiceNumber}.pdf"`);
  const doc = await generateInvoicePdf(invoice as any);
  doc.pipe(res);
  doc.end();
});

async function deriveInvoiceLocations(inv: any): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  const push = (t: any) => {
    const display = t.locationDisplay || [t.field?.name, t.pad?.name, t.well?.wellName].filter(Boolean).join(' → ') || 'Unknown';
    if (seen.has(display)) return;
    seen.add(display);
    out.push({
      display,
      fieldName: t.field?.name ?? t.fieldAreaName ?? null,
      padName: t.pad?.name ?? null,
      wellName: t.well?.wellName ?? null,
      apiNumber: t.well?.apiNumber ?? null,
    });
  };
  if (inv.billingGroup?.tickets?.length) {
    inv.billingGroup.tickets.forEach(push);
    return out;
  }
  const ids = [...new Set((inv.lineItems ?? []).map((li: any) => li.sourceTicketId).filter(Boolean))] as string[];
  if (ids.length) {
    const tickets = await prisma.serviceTicket.findMany({
      where: { id: { in: ids } },
      select: {
        locationDisplay: true, fieldAreaName: true,
        well: { select: { wellName: true, apiNumber: true } },
        pad: { select: { name: true } },
        field: { select: { name: true } },
      },
    });
    tickets.forEach(push);
  }
  return out;
}

// ── Files (attachment download) ───────────────────────────────────────────────
// Resolves an attachment id → its stored bytes. Scope required is the PARENT
// resource's (a tickets:read key fetches ticket attachments). NOT an open file
// proxy: only ids that map to a real attachment row are ever served, and the
// stored key is re-checked for traversal before streaming.
v1Router.get('/files/:id', v1Auth(), async (req: Request, res: Response) => {
  const id = req.params.id as string;
  let filePath: string | undefined;
  let fileName: string | undefined;
  let mimeType: string | null | undefined;

  const ta = await prisma.ticketAttachment.findUnique({ where: { id }, select: { filePath: true, fileName: true, mimeType: true } });
  if (ta) {
    requireScope(req, 'tickets:read');
    ({ filePath, fileName, mimeType } = ta);
  } else {
    const ia = await prisma.invoiceAttachment.findUnique({ where: { id }, select: { filePath: true, fileName: true, mimeType: true } });
    if (!ia) throw new V1Error(404, 'not_found', 'Attachment not found');
    requireScope(req, 'invoices:read');
    ({ filePath, fileName, mimeType } = ia);
  }

  if (!filePath || filePath.includes('..')) throw new V1Error(404, 'not_found', 'Attachment file unavailable');
  const store = getFileStore();
  if (!(await store.exists(filePath))) throw new V1Error(404, 'not_found', 'Attachment file missing from storage');

  const ext = extname(filePath).toLowerCase();
  res.setHeader('Content-Type', mimeType || FILE_MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${fileName ?? basename(filePath)}"`);
  (await store.createReadStream(filePath)).pipe(res);
});

// ── Equipment ───────────────────────────────────────────────────────────────
v1Router.get('/equipment', v1Auth('equipment:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.serializedEquipment.findMany({ ...a, include: { product: { select: { id: true, partNumber: true, name: true, category: true } } } } as any),
    where: merge(
      str(req.query.status) && { status: req.query.status as any },
      str(req.query.ownership) && { ownership: req.query.ownership as any },
      str(req.query.productCategory) && { product: { category: req.query.productCategory as any } },
      str(req.query.serialNumber) && { serialNumber: req.query.serialNumber },
      str(req.query.companyId) && { currentCustomerId: req.query.companyId },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor),
    limit: parseLimit(req.query.limit),
    map: m.equipmentSummary,
  });
});

v1Router.get('/equipment/:id', v1Auth('equipment:read'), async (req: Request, res: Response) => {
  const e = await prisma.serializedEquipment.findUnique({
    where: { id: req.params.id as string },
    include: {
      product: { select: { id: true, partNumber: true, name: true, category: true } },
      currentPad: { select: { id: true, name: true } },
      currentWell: { select: { id: true, wellName: true, apiNumber: true } },
      currentFacility: { select: { id: true, name: true } },
      currentCustomer: { select: { id: true, name: true } },
      equipmentInspections: { orderBy: { inspectedAt: 'desc' }, take: 1, include: { inspectedBy: { select: { id: true, name: true } } } },
    },
  });
  sendOne(req, res, e as any, m.equipmentDetail);
});

// ── Equipment inspections ─────────────────────────────────────────────────────
v1Router.get('/equipment-inspections', v1Auth('inspections:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.equipmentInspection.findMany({ ...a, include: { inspectedBy: { select: { id: true, name: true } } } } as any),
    where: merge(
      str(req.query.category) && { category: req.query.category as any },
      str(req.query.outcome) && { outcome: req.query.outcome as any },
      str(req.query.serialNumber) && { serialNumber: req.query.serialNumber },
      str(req.query.ticketId) && { ticketId: req.query.ticketId },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor),
    limit: parseLimit(req.query.limit),
    map: m.equipmentInspectionSummary,
  });
});

v1Router.get('/equipment-inspections/:id', v1Auth('inspections:read'), async (req: Request, res: Response) => {
  const i = await prisma.equipmentInspection.findUnique({
    where: { id: req.params.id as string },
    include: { inspectedBy: { select: { id: true, name: true } } },
  });
  sendOne(req, res, i as any, m.equipmentInspectionDetail);
});

// ── Rentals ───────────────────────────────────────────────────────────────────
v1Router.get('/rentals', v1Auth('rentals:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.rentalAgreement.findMany({
      ...a,
      include: { company: { select: { id: true, name: true } }, field: { select: { name: true } }, pad: { select: { name: true } }, well: { select: { wellName: true, apiNumber: true } } },
    } as any),
    where: merge(
      str(req.query.status) && { status: req.query.status as any },
      str(req.query.companyId) && { companyId: req.query.companyId },
      str(req.query.fieldId) && { fieldId: req.query.fieldId },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor),
    limit: parseLimit(req.query.limit),
    map: m.rentalSummary,
  });
});

v1Router.get('/rentals/:id', v1Auth('rentals:read'), async (req: Request, res: Response) => {
  const r = await prisma.rentalAgreement.findUnique({
    where: { id: req.params.id as string },
    include: {
      company: { select: { id: true, name: true } },
      field: { select: { name: true } },
      pad: { select: { name: true } },
      well: { select: { wellName: true, apiNumber: true } },
      items: { include: { product: { select: { id: true, partNumber: true, name: true, category: true } }, serializedEquipment: { select: { serialNumber: true } } } },
      dailyLogs: { select: { logDate: true } },
    },
  });
  sendOne(req, res, r as any, m.rentalDetail);
});

v1Router.get('/rentals/:id/daily-logs', v1Auth('rentals:read'), validateListQuery, async (req: Request, res: Response) => {
  const exists = await prisma.rentalAgreement.findUnique({ where: { id: req.params.id as string }, select: { id: true } });
  if (!exists) throw new V1Error(404, 'not_found', 'Rental agreement not found');
  const from = str(req.query.from);
  const to = str(req.query.to);
  const logDate = merge(from && { gte: new Date(from) }, to && { lte: new Date(to) });
  await runList(res, {
    findMany: (a) => prisma.rentalDailyLog.findMany({ ...a, include: { loggedBy: { select: { id: true, name: true } } } } as any),
    where: merge({ rentalAgreementId: req.params.id }, Object.keys(logDate).length ? { logDate } : undefined),
    cursor: str(req.query.cursor),
    limit: parseLimit(req.query.limit),
    map: m.rentalDailyLog,
  });
});

// ── Locations ───────────────────────────────────────────────────────────────
v1Router.get('/fields', v1Auth('locations:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.field.findMany(a as any),
    where: merge(bool(req.query.isActive) !== undefined && { isActive: bool(req.query.isActive) }, since(req.query.updatedSince)),
    cursor: str(req.query.cursor), limit: parseLimit(req.query.limit), map: m.fieldDto,
  });
});
v1Router.get('/fields/:id', v1Auth('locations:read'), async (req: Request, res: Response) => {
  const f = await prisma.field.findUnique({ where: { id: req.params.id as string } });
  sendOne(req, res, f as any, m.fieldDto);
});

const padInclude = { field: { select: { id: true, name: true } }, currentOperator: { select: { id: true, name: true } } };
v1Router.get('/pads', v1Auth('locations:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.pad.findMany({ ...a, include: padInclude } as any),
    where: merge(
      bool(req.query.isActive) !== undefined && { isActive: bool(req.query.isActive) },
      str(req.query.fieldId) && { fieldId: req.query.fieldId },
      str(req.query.operatorId) && { currentOperatorId: req.query.operatorId },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor), limit: parseLimit(req.query.limit), map: m.padSummary,
  });
});
v1Router.get('/pads/:id', v1Auth('locations:read'), async (req: Request, res: Response) => {
  const p = await prisma.pad.findUnique({ where: { id: req.params.id as string }, include: padInclude });
  sendOne(req, res, p as any, m.padDetail);
});

const wellInclude = { field: { select: { id: true, name: true } }, pad: { select: { id: true, name: true } }, currentOperator: { select: { id: true, name: true } } };
v1Router.get('/wells', v1Auth('locations:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.well.findMany({ ...a, include: wellInclude } as any),
    where: merge(
      str(req.query.fieldId) && { fieldId: req.query.fieldId },
      str(req.query.padId) && { padId: req.query.padId },
      str(req.query.operatorId) && { currentOperatorId: req.query.operatorId },
      str(req.query.apiNumber) && { apiNumber: req.query.apiNumber },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor), limit: parseLimit(req.query.limit), map: m.wellSummary,
  });
});
v1Router.get('/wells/:id', v1Auth('locations:read'), async (req: Request, res: Response) => {
  const w = await prisma.well.findUnique({ where: { id: req.params.id as string }, include: wellInclude });
  sendOne(req, res, w as any, m.wellDetail);
});

const facilityInclude = { field: { select: { id: true, name: true } }, pad: { select: { id: true, name: true } }, currentOperator: { select: { id: true, name: true } } };
v1Router.get('/facilities', v1Auth('locations:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.facility.findMany({ ...a, include: facilityInclude } as any),
    where: merge(
      bool(req.query.isActive) !== undefined && { isActive: bool(req.query.isActive) },
      str(req.query.fieldId) && { fieldId: req.query.fieldId },
      str(req.query.facilityType) && { facilityType: req.query.facilityType as any },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor), limit: parseLimit(req.query.limit), map: m.facilitySummary,
  });
});
v1Router.get('/facilities/:id', v1Auth('locations:read'), async (req: Request, res: Response) => {
  const f = await prisma.facility.findUnique({ where: { id: req.params.id as string }, include: facilityInclude });
  sendOne(req, res, f as any, m.facilityDetail);
});

// ── Companies ─────────────────────────────────────────────────────────────────
v1Router.get('/companies', v1Auth('companies:read'), validateListQuery, async (req: Request, res: Response) => {
  await runList(res, {
    findMany: (a) => prisma.company.findMany(a as any),
    where: merge(
      bool(req.query.isActive) !== undefined && { isActive: bool(req.query.isActive) },
      str(req.query.companyType) && { companyType: req.query.companyType as any },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor), limit: parseLimit(req.query.limit), map: m.companySummary,
  });
});
v1Router.get('/companies/:id', v1Auth('companies:read'), async (req: Request, res: Response) => {
  const c = await prisma.company.findUnique({ where: { id: req.params.id as string } });
  sendOne(req, res, c as any, m.companyDetail);
});

// ── Trainings ───────────────────────────────────────────────────────────────
v1Router.get('/trainings', v1Auth('trainings:read'), validateListQuery, async (req: Request, res: Response) => {
  const course = str(req.query.course);
  await runList(res, {
    findMany: (a) => prisma.serviceTicket.findMany({
      ...a,
      include: { company: { select: { id: true, name: true } }, trainingRosterRecords: { select: { courseName: true } } },
    } as any),
    where: merge(
      { ticketType: 'training' as any },
      str(req.query.companyId) && { companyId: req.query.companyId },
      str(req.query.status) && { status: req.query.status as any },
      course && { trainingRosterRecords: { some: { courseName: { contains: course, mode: 'insensitive' } } } },
      since(req.query.updatedSince),
    ),
    cursor: str(req.query.cursor), limit: parseLimit(req.query.limit), map: m.trainingClassSummary,
  });
});
v1Router.get('/trainings/:id', v1Auth('trainings:read'), async (req: Request, res: Response) => {
  const t = await prisma.serviceTicket.findUnique({
    where: { id: req.params.id as string },
    include: {
      company: { select: { id: true, name: true } },
      field: { select: { name: true } }, pad: { select: { name: true } }, well: { select: { wellName: true, apiNumber: true } },
      assignedTech: { select: { id: true, name: true } },
      trainingRosterRecords: true,
    },
  });
  if (!t || t.ticketType !== 'training') throw new V1Error(404, 'not_found', 'Training class not found');
  sendOne(req, res, t as any, m.trainingClassDetail);
});

// ── BlueLion sync management ───────────────────────────────────────────────────
v1Router.get('/bluelion/queue', v1Auth('bluelion:read'), validateListQuery, async (req: Request, res: Response) => {
  const status = str(req.query.status);
  const rows = await prisma.blueLionSyncQueue.findMany({
    where: status ? { status: status as any } : undefined,
    orderBy: { createdAt: 'desc' },
    take: parseLimit(req.query.limit, 200, 500),
  });
  res.json(rows.map(m.blueLionQueueEntry));
});

v1Router.get('/bluelion/queue/stats', v1Auth('bluelion:read'), async (_req: Request, res: Response) => {
  const stats = await prisma.blueLionSyncQueue.groupBy({ by: ['status'], _count: true });
  const out: Record<string, number> = {};
  for (const s of stats) out[s.status] = (s as any)._count;
  res.json(out);
});

v1Router.post('/bluelion/trainings/sync/:ticketId', v1Auth('bluelion:write'), async (req: Request, res: Response) => {
  const ticketId = req.params.ticketId as string;
  const ticket = await prisma.serviceTicket.findUnique({ where: { id: ticketId }, select: { id: true, ticketType: true } });
  if (!ticket) throw new V1Error(404, 'not_found', 'Ticket not found');
  if (ticket.ticketType !== 'training') throw new V1Error(400, 'bad_request', 'Not a training ticket');
  const result = await enqueueTrainingRosterForTicket(ticketId, { force: req.body?.force === true });
  await createAuditLog({ userId: auditUser(req), entityType: 'bluelion_queue', entityId: ticketId, action: 'create', changes: { action: 'sync_training', via: 'v1', ...result } });
  res.json({ ok: true, ...result });
});

v1Router.post('/bluelion/queue/:id/retry', v1Auth('bluelion:write'), async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const entry = await prisma.blueLionSyncQueue.findUnique({ where: { id } });
  if (!entry) throw new V1Error(404, 'not_found', 'Queue entry not found');
  if (!['error', 'needs_attention'].includes(entry.status)) {
    throw new V1Error(400, 'bad_request', `Cannot retry entry with status "${entry.status}"`);
  }
  const updated = await prisma.blueLionSyncQueue.update({
    where: { id },
    data: { status: 'pending', errorMessage: null, responsePayload: null, responseStatusCode: null, resultStatus: null, candidates: undefined, retryCount: 0 },
  });
  await createAuditLog({ userId: auditUser(req), entityType: 'bluelion_queue', entityId: id, action: 'update', changes: { action: 'retry', via: 'v1', previousStatus: entry.status } });
  res.json({ ok: true, entry: m.blueLionQueueEntry(updated) });
});

v1Router.post('/bluelion/queue/:id/resolve', v1Auth('bluelion:write'), async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const blueLionId = req.body?.blueLionId;
  if (!blueLionId || typeof blueLionId !== 'string') throw new V1Error(400, 'bad_request', 'blueLionId (string) is required');
  const entry = await prisma.blueLionSyncQueue.findUnique({ where: { id } });
  if (!entry) throw new V1Error(404, 'not_found', 'Queue entry not found');
  if (entry.resultStatus !== 'ambiguous') {
    throw new V1Error(400, 'bad_request', `Only ambiguous entries can be resolved (this one is "${entry.resultStatus ?? entry.status}")`);
  }
  await prisma.trainingRosterRecord
    .update({ where: { id: entry.entityId }, data: { blueLionPersonId: blueLionId } })
    .catch(() => { throw new V1Error(404, 'not_found', 'Roster record for this entry no longer exists'); });
  const updated = await prisma.blueLionSyncQueue.update({
    where: { id },
    data: { status: 'pending', errorMessage: null, candidates: undefined, resultStatus: null, responsePayload: null, retryCount: 0 },
  });
  await createAuditLog({ userId: auditUser(req), entityType: 'bluelion_queue', entityId: id, action: 'update', changes: { action: 'resolve_ambiguous', via: 'v1', blueLionId } });
  res.json({ ok: true, entry: m.blueLionQueueEntry(updated) });
});

// ── BlueLion card.issued receiver ──────────────────────────────────────────────
// The ONE inbound BlueLion call (docs/bluelion/SERVICEPRO-CARD-FLAG.md §3).
// BlueLion is pointed at this URL via SERVICEPRO_OUTBOUND_URL and authenticates
// with an sp_ API key issued from /admin/api-keys (scope bluelion:write).
//
// Response-code contract: 2xx = done; 4xx = PERMANENT (BlueLion parks the flag
// and stops retrying — only for malformed payloads/auth); 5xx = transient
// (BlueLion retries with backoff). Dedupe on the Idempotency-Key header — a
// re-send returns 2xx without re-applying.
const CARD_CERT_IS_FIT_TEST = new Set(['FIT-TEST', 'RESP-FIT', 'AUDIO']);

v1Router.post('/bluelion/card-issued', v1Auth('bluelion:write'), async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const cardId = typeof b.cardId === 'string' ? b.cardId : '';
  const personId = typeof b.personId === 'string' ? b.personId : '';
  const certCode = typeof b.certCode === 'string' ? b.certCode : '';
  const issuedOnRaw = typeof b.issuedOn === 'string' ? b.issuedOn : '';
  const issuedOn = new Date(issuedOnRaw);
  if (!cardId || !personId || !certCode || Number.isNaN(issuedOn.getTime())) {
    // 400 is permanent by contract — correct for a malformed flag.
    throw new V1Error(400, 'bad_request', 'cardId, personId, certCode and issuedOn (ISO) are required');
  }

  // The Idempotency-Key header is unique per card (the event hash). Spec says
  // it's always sent; fall back to cardId so a missing header still dedupes.
  const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) || `card:${cardId}`;

  const existing = await prisma.blueLionCardFlag.findUnique({ where: { idempotencyKey } });
  if (existing) {
    res.json({ ok: true, status: 'duplicate', receivedAt: existing.receivedAt });
    return;
  }

  // Stamp "card printed" on the matching source row. FIT-TEST/RESP-FIT/AUDIO
  // certs live on fit_test_records; everything else is a training roster row
  // (matched by person + classCode via the course map). No match is NOT an
  // error — the flag is stored either way and we still ack.
  let matchedEntityType: string | null = null;
  let matchedEntityId: string | null = null;

  if (CARD_CERT_IS_FIT_TEST.has(certCode)) {
    const rec = await prisma.fitTestRecord.findFirst({
      where: { blueLionPersonId: personId },
      orderBy: { testDate: 'desc' },
      select: { id: true },
    });
    if (rec) {
      await prisma.fitTestRecord.update({
        where: { id: rec.id },
        data: { blueLionCardId: cardId, blueLionCardIssuedAt: issuedOn },
      });
      matchedEntityType = 'fit_test_record';
      matchedEntityId = rec.id;
    }
  } else {
    const candidates = await prisma.trainingRosterRecord.findMany({
      where: { blueLionPersonId: personId },
      orderBy: { trainedAt: 'desc' },
      take: 50,
      select: { id: true, courseName: true },
    });
    // Resolve each distinct course name once (catalog lookup is async).
    const codeByName = new Map<string, string | null>();
    for (const name of new Set(candidates.map((c) => c.courseName))) {
      codeByName.set(name, await resolveClassCode(name));
    }
    const match = candidates.find((c) => codeByName.get(c.courseName) === certCode);
    if (match) {
      await prisma.trainingRosterRecord.update({
        where: { id: match.id },
        data: { blueLionCardId: cardId, blueLionCardIssuedAt: issuedOn },
      });
      matchedEntityType = 'training_roster_record';
      matchedEntityId = match.id;
    }
  }

  try {
    await prisma.blueLionCardFlag.create({
      data: {
        idempotencyKey,
        event: typeof b.event === 'string' ? b.event : 'card.issued',
        cardId,
        personId,
        certCode,
        issuedOn,
        issuedBy: typeof b.issuedBy === 'string' ? b.issuedBy : null,
        templateId: typeof b.templateId === 'string' ? b.templateId : null,
        templateVersion: typeof b.templateVersion === 'number' ? b.templateVersion : null,
        reissueOf: typeof b.reissueOf === 'string' ? b.reissueOf : null,
        verifyUrl: typeof b.verifyUrl === 'string' ? b.verifyUrl : null,
        payload: b as object,
        matchedEntityType,
        matchedEntityId,
      },
    });
  } catch (e: unknown) {
    // Unique-violation race with a concurrent re-send → it's a duplicate; ack.
    if ((e as { code?: string }).code === 'P2002') {
      res.json({ ok: true, status: 'duplicate' });
      return;
    }
    throw e; // → 500 → BlueLion retries (transient by contract)
  }

  console.log(`[v1] bluelion card.issued ${cardId} → person ${personId} (${certCode})${matchedEntityId ? ` stamped ${matchedEntityType} ${matchedEntityId}` : ' — no local match'}`);
  void emitEvent('bluelion.card.issued', { cardId, personId, certCode, issuedOn: issuedOn.toISOString(), matchedEntityType, matchedEntityId });
  res.status(201).json({ ok: true, status: 'recorded', matchedEntityType, matchedEntityId });
});

// Anything unmatched under /api/v1 → JSON 404 (not the SPA fallback).
v1Router.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { code: 'not_found', message: 'No such v1 endpoint' } });
});

v1Router.use(v1ErrorHandler);
