/**
 * enverus.ts — Routes for Enverus OpenInvoice/OpenTicket integration.
 *
 * All routes behind `requirePermission('billing:enverus')`.
 *
 * Endpoints:
 *   Master Data
 *     GET  /test-connection
 *     GET  /master-data/afes/:buyerDuns
 *     GET  /master-data/cost-centers/:buyerDuns
 *     GET  /master-data/requisitioners/:buyerDuns
 *     GET  /master-data/purchase-orders/:buyerDuns
 *     GET  /master-data/buyer-rules/:buyerDuns/:ticketType?
 *     GET  /master-data/customers
 *
 *   Submission
 *     POST /receipts/submit/:ticketId
 *     POST /receipts/cancel/:ticketId
 *     POST /invoices/submit/:invoiceId
 *
 *   Status Polling
 *     GET  /receipts/status/:ticketId
 *     GET  /invoices/status/:invoiceId
 *
 *   Queue Management + Alerts
 *     GET  /queue
 *     GET  /queue/stats
 *     POST /queue/:id/retry
 *     DELETE /queue/:id
 *     GET  /alerts
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../index.js';
import { requirePermission } from '../middleware/rbac.js';
import { AppError } from '../middleware/errorHandler.js';
import { createAuditLog } from '../utils/auditLog.js';
import {
  testConnection,
  enverusRequest,
  fetchAfes,
  fetchCostCenters,
  fetchRequisitioners,
  fetchPurchaseOrders,
  fetchBuyerFieldRules,
  fetchCustomers,
  fetchAllCustomerManagement,
  submitReceipt,
  submitReceiptWithAttachment,
  pollReceiptStatus,
  getSupplierDuns,
  EnverusApiError,
} from '../services/enverusClient.js';
import {
  getCached,
  setCached,
} from '../services/enverusMasterDataCache.js';
import {
  buildReceiptPayload,
  buildInvoiceAsReceiptPayload,
  validateProfileForReceipt,
  validateProfileForInvoice,
  validateLineItemsForReceipt,
} from '../services/enverusPayloadBuilder.js';
import type { EnverusSubmitOverrides } from '../services/enverusPayloadBuilder.js';
import { getTicketPdfBuffer, getInvoicePdfBuffer } from '../utils/ticketPdfBuffer.js';
import { generateInvoicePdf } from '../services/invoicePdfGenerator.js';
import { pdfToBuffer } from '../utils/pdfToBuffer.js';
import type { Prisma } from '../db.js';

export const enverusRouter = Router();

// All Enverus routes require billing:enverus permission
enverusRouter.use(requirePermission('billing:enverus'));

// ─────────────────────────────────────────────────────────────────────────────
// Helper: wrap EnverusApiError into AppError for the Express error handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the per-location facility code for an invoice from its source tickets'
 * wells/pads (well code wins, pad is fallback). Returns the single distinct code, or
 * null if there's none — or more than one (a consolidated invoice spanning wells with
 * different codes is ambiguous, so we leave the buyer's static default in place).
 */
async function resolveInvoiceFacilityCode(
  lineItems: Array<{ sourceTicketId?: string | null }>,
): Promise<string | null> {
  const ticketIds = [
    ...new Set(lineItems.map((li) => li.sourceTicketId).filter((id): id is string => !!id)),
  ];
  if (ticketIds.length === 0) return null;
  const tickets = await prisma.serviceTicket.findMany({
    where: { id: { in: ticketIds } },
    select: {
      well: { select: { facilityCode: true } },
      pad: { select: { facilityCode: true } },
    },
  });
  const codes = [
    ...new Set(
      tickets
        .map((t) => t.well?.facilityCode ?? t.pad?.facilityCode)
        .filter((c): c is string => !!c),
    ),
  ];
  if (codes.length === 1) return codes[0] as string;
  if (codes.length > 1) {
    console.warn(
      `[enverus] invoice spans ${codes.length} distinct facility codes — skipping facility-code auto-injection`,
    );
  }
  return null;
}

/**
 * Resolve the field tech (assignedTech.name) for each line's source ticket.
 * Returns a Map keyed by sourceTicketId → tech name. Used to populate the COP
 * Labor-line crewMember from who actually did the work. InvoiceLineItem has no
 * Prisma relation to ServiceTicket (only the scalar sourceTicketId), so we look
 * the tickets up directly — mirrors resolveInvoiceFacilityCode.
 */
async function resolveLineCrewMembers(
  lineItems: Array<{ sourceTicketId?: string | null }>,
): Promise<Map<string, string>> {
  const ticketIds = [
    ...new Set(lineItems.map((li) => li.sourceTicketId).filter((id): id is string => !!id)),
  ];
  const map = new Map<string, string>();
  if (ticketIds.length === 0) return map;
  const tickets = await prisma.serviceTicket.findMany({
    where: { id: { in: ticketIds } },
    select: { id: true, assignedTech: { select: { name: true } } },
  });
  for (const t of tickets) {
    if (t.assignedTech?.name) map.set(t.id, t.assignedTech.name);
  }
  return map;
}

function mapEnverusError(err: unknown): never {
  if (err instanceof EnverusApiError) {
    const statusMap: Record<string, number> = {
      auth_failure: 502,
      validation_error: 400,
      not_found: 404,
      rate_limit: 429,
      server_error: 502,
      network_timeout: 504,
      unknown: 500,
    };
    throw new AppError(
      statusMap[err.category] || 500,
      `Enverus API: ${err.message}`,
    );
  }
  throw err;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /test-connection — Smoke test cert + API connectivity
// ─────────────────────────────────────────────────────────────────────────────

enverusRouter.get('/test-connection', async (_req: Request, res: Response) => {
  const result = await testConnection();
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /raw-proxy — Hit any Enverus endpoint through our authenticated connection
// ─────────────────────────────────────────────────────────────────────────────

enverusRouter.post(
  '/raw-proxy',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { method = 'GET', path, queryParams, body } = req.body;
      if (!path) throw new AppError(400, 'path is required (e.g. /supply-chain/v1/receipts)');

      console.log(`[Enverus] Raw proxy: ${method} ${path}`);

      const result = await enverusRequest({
        method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
        path,
        queryParams,
        body,
      });

      res.json({
        ok: result.statusCode >= 200 && result.statusCode < 300,
        statusCode: result.statusCode,
        body: result.body,
      });
    } catch (err: unknown) {
      if (err instanceof EnverusApiError) {
        res.json({
          ok: false,
          statusCode: err.statusCode,
          error: err.message,
          category: err.category,
          rawResponse: err.responseBody,
        });
        return;
      }
      if (err instanceof AppError) return next(err);
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /test-receipt — Fire a minimal test receipt at Enverus to see what happens
// ─────────────────────────────────────────────────────────────────────────────

enverusRouter.post(
  '/test-receipt',
  async (req: Request, res: Response, next: NextFunction) => {
    // Declare outside try so catch block can access for debug output
    let receipt: Record<string, unknown> = {};
    let payload: { events: unknown[] } = { events: [] };
    try {
      const { buyerDuns } = req.body;
      if (!buyerDuns) throw new AppError(400, 'buyerDuns is required');

      const supplierDuns = getSupplierDuns();
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const testNum = `SUNDOG-TEST-${Date.now()}`;

      // Build minimal receipt.
      // IMPORTANT: receiptType is effectively REQUIRED even though buyer
      // rules say it's optional — if omitted, Enverus defaults to 'general'
      // which is NOT a valid type for Continental. Must send a valid type.
      //
      // FIELD RULES BY RECEIPT TYPE:
      //   General  — chargeType FORBIDDEN on line items
      //   LEM      — chargeType REQUIRED on line items (Labor/Equipment/Material)
      //             — AFE (Charge To) REQUIRED on header + line items
      //   Hauling  — TBD
      //   Chemicals — TBD

      // Resolve receipt type FIRST — it determines which fields are allowed
      const rType = req.body.receiptType
        ? String(req.body.receiptType).trim()
        : 'General';  // General confirmed working for Continental
      const isLem = rType.toLowerCase() === 'lem';

      // Build line item — conditionally include chargeType (LEM only)
      const lineItem: Record<string, unknown> = {
        lineItemNumber: '1',
        description: req.body.description || 'Test line item from Service Pro integration',
        serviceDateFrom: dateStr,
        serviceDateTo: dateStr,
        quantity: req.body.quantity || 1,
        unitOfMeasure: req.body.unitOfMeasure || 'EA',
        rate: req.body.rate || 1.00,
      };

      // productServiceCode / partNumber
      if (req.body.productServiceCode) lineItem.productServiceCode = req.body.productServiceCode;
      if (req.body.partNumber) lineItem.partNumber = req.body.partNumber;

      // chargeType — REQUIRED for LEM, FORBIDDEN for General
      if (isLem) {
        lineItem.chargeType = req.body.chargeType
          ? String(req.body.chargeType).trim()
          : 'Labor';
      }

      // COP per-line fields (buyer-field-rules: major=Activity Code, minor=Functional Area)
      if (req.body.major) lineItem.major = req.body.major;
      if (req.body.minor) lineItem.minor = req.body.minor;
      if (req.body.location) lineItem.location = req.body.location;
      if (req.body.crewMember) lineItem.crewMember = req.body.crewMember;

      receipt = {
        receiptNumber: testNum,
        receiptType: rType,
        submissionSource: 'Service Pro',
        description: req.body.headerDescription || `Test receipt from Service Pro — ${dateStr}`,
        serviceDateFrom: dateStr,
        serviceDateTo: dateStr,
        currencyCode: 'USD',
        buyerParty: {
          partyDUNS: buyerDuns,
        },
        totalAmount: req.body.totalAmount || 1.00,
        lineItems: [lineItem],
      };

      // Supplier party — only include if configured
      if (supplierDuns) {
        receipt.supplierParty = { partyDUNS: supplierDuns };
      }

      // orderedByName — only if provided (must match a buyer-side requisitioner)
      if (req.body.requisitioner?.trim()) {
        receipt.orderedByName = req.body.requisitioner.trim();
      }

      // Price Book — COP REQUIRED
      if (req.body.priceBookNumber?.trim()) {
        receipt.priceBookNumber = req.body.priceBookNumber.trim();
      }

      // Header-level location
      if (req.body.location?.trim()) {
        receipt.location = req.body.location.trim();
      }

      // COP Invoice Approver — ADE field (itemID 99872, header-level)
      if (req.body.invoiceApprover?.trim()) {
        receipt.additionalDataFields = [
          ...(receipt.additionalDataFields as any[] || []),
          { itemID: '99872', name: 'Invoice Approver', value: req.body.invoiceApprover.trim().slice(0, 25) },
        ];
      }

      // AFE / Charge To — REQUIRED for LEM per Continental guidelines
      if (req.body.afe?.trim()) {
        receipt.afe = { number: req.body.afe.trim() };
        // Also add to line item
        lineItem.afe = { number: req.body.afe.trim() };
      }

      payload = {
        events: [{ data: { transform: { receipt } } }],
      };

      console.log(`[Enverus] Test receipt: type=${receipt.receiptType}, buyer=${buyerDuns}`);

      const result = await submitReceipt(payload);

      res.json({
        ok: result.statusCode >= 200 && result.statusCode < 300,
        statusCode: result.statusCode,
        receiptNumber: testNum,
        payload,
        response: result.body,
      });
    } catch (err: unknown) {
      if (err instanceof EnverusApiError) {
        // Parse Enverus structured error into human-readable messages
        let messages: Array<{ type: string; field?: string; message: string }> = [];
        try {
          const parsed = JSON.parse(err.responseBody || '{}');
          const resourceMsgs = parsed?.confirmMessage?.resourceMessages || [];
          for (const rm of resourceMsgs) {
            for (const pm of rm.processMessages || []) {
              messages.push({
                type: pm.messageTypeCode?.codeValue || 'unknown',
                field: pm.sourceLocationExpression || undefined,
                message: pm.developerMessage?.messageTxt || 'Unknown error',
              });
            }
          }
        } catch {
          // Couldn't parse — use raw error
        }
        res.json({
          ok: false,
          statusCode: err.statusCode,
          error: err.message,
          category: err.category,
          messages: messages.length > 0 ? messages : undefined,
          payload,
          rawResponse: err.responseBody,
        });
        return;
      }
      if (err instanceof AppError) return next(err);
      next(err);
    }
  },
);
// ─────────────────────────────────────────────────────────────────────────────
// Master Data endpoints — all cached with 1hr TTL, ?refresh=true to bypass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic cached master data fetcher.
 * Checks cache first; on miss or ?refresh=true, hits Enverus API and caches.
 */
async function cachedMasterData<T>(
  cacheKey: string,
  fetcher: () => Promise<{ body: unknown }>,
  refresh: boolean,
): Promise<T[]> {
  if (!refresh) {
    const cached = getCached<T[]>(cacheKey);
    if (cached) return cached;
  }

  const response = await fetcher();
  const body = response.body as Record<string, unknown>;

  // Handle multiple response shapes from Enverus:
  //   OData collection:     { value: [...] }
  //   Flat array:           [...]
  //   Wrapped:              { data: [...] }
  //   Requisitioners:       { orderedByNames: [...] }
  //   Any other named list: { someKey: [...] }  (find first array prop)
  let data: T[];
  if (Array.isArray(body)) {
    data = body;
  } else if (body && Array.isArray(body.value)) {
    data = body.value;
  } else if (body && Array.isArray(body.data)) {
    data = body.data;
  } else if (body && typeof body === 'object') {
    // Fallback: find the first property that is an array (skip 'meta', 'links')
    const skipKeys = new Set(['meta', 'links', '@odata.context', '@odata.count']);
    const arrayProp = Object.entries(body).find(
      ([k, v]) => Array.isArray(v) && !skipKeys.has(k)
    );
    data = arrayProp ? (arrayProp[1] as T[]) : [];
  } else {
    data = [];
  }

  if (data.length === 0) {
    console.log(`[Enverus] Master data ${cacheKey}: empty result`);
  }

  setCached(cacheKey, data);
  return data;
}

// GET /master-data/afes/:buyerDuns
enverusRouter.get(
  '/master-data/afes/:buyerDuns',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buyerDuns } = req.params;
      const refresh = req.query.refresh === 'true';
      const data = await cachedMasterData(
        `afes:${buyerDuns}`,
        () => fetchAfes(buyerDuns as string),
        refresh,
      );
      res.json({ data, count: data.length, cached: !refresh });
    } catch (err) {
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);

// GET /master-data/cost-centers/:buyerDuns
enverusRouter.get(
  '/master-data/cost-centers/:buyerDuns',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buyerDuns } = req.params;
      const refresh = req.query.refresh === 'true';
      const data = await cachedMasterData(
        `cost-centers:${buyerDuns}`,
        () => fetchCostCenters(buyerDuns as string),
        refresh,
      );
      res.json({ data, count: data.length, cached: !refresh });
    } catch (err) {
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);

// GET /master-data/requisitioners/:buyerDuns
enverusRouter.get(
  '/master-data/requisitioners/:buyerDuns',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buyerDuns } = req.params;
      const refresh = req.query.refresh === 'true';
      const data = await cachedMasterData(
        `requisitioners:${buyerDuns}`,
        () => fetchRequisitioners(buyerDuns as string),
        refresh,
      );
      res.json({ data, count: data.length, cached: !refresh });
    } catch (err) {
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);

// GET /master-data/purchase-orders/:buyerDuns
enverusRouter.get(
  '/master-data/purchase-orders/:buyerDuns',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buyerDuns } = req.params;
      const refresh = req.query.refresh === 'true';
      const data = await cachedMasterData(
        `purchase-orders:${buyerDuns}`,
        () => fetchPurchaseOrders(buyerDuns as string),
        refresh,
      );
      res.json({ data, count: data.length, cached: !refresh });
    } catch (err) {
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);
// GET /master-data/buyer-rules/:buyerDuns/:ticketType?
enverusRouter.get(
  '/master-data/buyer-rules/:buyerDuns/:ticketType?',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buyerDuns, ticketType } = req.params;
      const type = (ticketType as string) || 'general';
      const cacheKey = `buyer-rules:${buyerDuns}:${type}`;
      const refresh = req.query.refresh === 'true';

      if (!refresh) {
        const cached = getCached(cacheKey);
        if (cached) {
          res.json({ data: cached, cached: true });
          return;
        }
      }

      const response = await fetchBuyerFieldRules(buyerDuns as string, type);
      setCached(cacheKey, response.body);
      res.json({ data: response.body, cached: false });
    } catch (err) {
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);
// GET /master-data/customers — list all buyers linked to supplier
enverusRouter.get(
  '/master-data/customers',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = 'customers:all';
      const refresh = _req.query.refresh === 'true';

      if (!refresh) {
        const cached = getCached(cacheKey);
        if (cached) {
          res.json({ data: cached, cached: true });
          return;
        }
      }

      const response = await fetchCustomers();
      // Body is a bare JSON array of { id, name, active } — not { value: [] }.
      const body = response.body as unknown;
      const data = Array.isArray(body) ? body : ((response.body as { value?: unknown[] }).value ?? []);
      setCached(cacheKey, data);
      res.json({ data, count: data.length, cached: false });
    } catch (err) {
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);

// GET /master-data/buyer-sites — buyers grouped with their distinct sites.
// Drives the structured Buyer Site picker on the billing profile editor so admins
// pick a site by name and we store the siteUuid (+ matching buyerDUNS) — never a
// hand-typed label like "L48 NORTH DAKOTA-0109" that OpenInvoice rejects.
enverusRouter.get(
  '/master-data/buyer-sites',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = 'buyer-sites:grouped';
      const refresh = req.query.refresh === 'true';
      if (!refresh) {
        const cached = getCached(cacheKey);
        if (cached) { res.json({ data: cached, cached: true }); return; }
      }

      const rows = await fetchAllCustomerManagement();
      // Group by buyer (DUNS), collect distinct sites by siteUuid.
      const byBuyer = new Map<string, {
        customerName: string;
        customerDuns: string;
        customerUuid: string;
        sites: Map<string, string>; // siteUuid -> siteName
      }>();
      for (const r of rows) {
        const duns = (r.customerDuns || '').trim();
        if (!duns) continue;
        let entry = byBuyer.get(duns);
        if (!entry) {
          entry = { customerName: r.customerName || duns, customerDuns: duns, customerUuid: r.customerUuid || '', sites: new Map() };
          byBuyer.set(duns, entry);
        }
        if (r.siteUuid && r.siteName) entry.sites.set(r.siteUuid, r.siteName);
      }
      const data = Array.from(byBuyer.values())
        .map(b => ({
          customerName: b.customerName,
          customerDuns: b.customerDuns,
          customerUuid: b.customerUuid,
          sites: Array.from(b.sites.entries())
            .map(([siteUuid, siteName]) => ({ siteUuid, siteName }))
            .sort((a, z) => a.siteName.localeCompare(z.siteName)),
        }))
        .sort((a, z) => a.customerName.localeCompare(z.customerName));

      setCached(cacheKey, data);
      res.json({ data, count: data.length, cached: false });
    } catch (err) {
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);
// ─────────────────────────────────────────────────────────────────────────────
// Receipt Submission
// ─────────────────────────────────────────────────────────────────────────────

// POST /receipts/submit/:ticketId — validate, build payload, create queue entry
enverusRouter.post(
  '/receipts/submit/:ticketId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ticketId } = req.params;

      // Load ticket with line items + billing profile + products
      const ticket = await prisma.serviceTicket.findUnique({
        where: { id: ticketId as string },
        include: {
          lineItems: {
            include: { product: true },
            orderBy: { lineNumber: 'asc' },
          },
          billingProfile: true,
          company: true,
          well: { select: { facilityCode: true } },
          pad: { select: { facilityCode: true } },
        },
      });

      if (!ticket) throw new AppError(404, 'Ticket not found');

      // Resolve billing profile: use ticket's direct link, or fall back to company's active Enverus profile
      let profile = ticket.billingProfile;
      if (!profile && ticket.companyId) {
        profile = await prisma.customerBillingProfile.findFirst({
          where: { companyId: ticket.companyId, enverusEnabled: true, isActive: true },
        });
      }
      if (!profile) {
        throw new AppError(400, 'No Enverus billing profile found (check company billing profiles)');
      }
      if (!profile.enverusEnabled) {
        throw new AppError(400, 'Enverus is not enabled on billing profile');
      }

      // Validate profile config
      const profileErrors = validateProfileForReceipt(profile);
      if (profileErrors.length > 0) {
        throw new AppError(400, `Billing profile validation failed: ${profileErrors.join('; ')}`);
      }

      // Validate line items have product mappings
      const lineErrors = validateLineItemsForReceipt(ticket.lineItems);
      if (lineErrors.length > 0) {
        throw new AppError(400, `Line item validation failed: ${lineErrors.join('; ')}`);
      }

      // Check for existing pending/submitted queue entry
      const existing = await prisma.enverusSyncQueue.findFirst({
        where: {
          entityId: ticketId as string,
          entityType: 'receipt',
          status: { in: ['pending', 'submitted', 'retrying'] },
        },
      });
      if (existing) {
        throw new AppError(
          409,
          `Ticket already has a ${existing.status} Enverus receipt submission (queue ${existing.id})`,
        );
      }

      // Build payload — well facility code wins, pad is the fallback.
      const facilityCode = ticket.well?.facilityCode ?? ticket.pad?.facilityCode ?? null;
      const payload = buildReceiptPayload(
        ticket,
        ticket.lineItems,
        profile,
        { facilityCode },
      );

      // Create queue entry
      const queueEntry = await prisma.enverusSyncQueue.create({
        data: {
          entityType: 'receipt',
          entityId: ticketId as string,
          target: profile.enverusReceiptMode === 'openticket'
            ? 'openticket'
            : 'openinvoice',
          action: 'submit',
          endpointUrl: '/events/supply-chain/v1/receipt.submit',
          requestPayload: JSON.stringify(payload),
          status: 'pending',
        },
      });

      // Update ticket status
      await prisma.serviceTicket.update({
        where: { id: ticketId as string },
        data: { enverusReceiptStatus: 'submitted' },
      });

      // Audit log
      await createAuditLog({
        userId: req.user?.userId,
        entityType: 'service_ticket',
        entityId: ticketId as string,
        action: 'submit',
        changes: {
          action: 'enverus_receipt_queued',
          queueEntryId: queueEntry.id,
          buyerDuns: profile.buyerDuns,
        },
      });

      // ?immediate=true — fire receipt NOW instead of waiting for queue processor
      if (req.query.immediate === 'true') {
        try {
          // Generate PDF attachment for the receipt
          let pdfBuffer: Buffer | undefined;
          let pdfFileName = 'field-ticket.pdf';
          try {
            const pdf = await getTicketPdfBuffer(ticketId as string, prisma);
            pdfBuffer = pdf.buffer;
            pdfFileName = pdf.fileName;
            console.log(`[Enverus] Receipt attachment: ${pdfFileName} (${pdfBuffer.length} bytes)`);
          } catch (pdfErr) {
            console.warn('[Enverus] PDF generation failed, submitting without attachment:', pdfErr instanceof Error ? pdfErr.message : pdfErr);
          }

          const result = await submitReceiptWithAttachment(payload, pdfBuffer, pdfFileName);
          const body = result.body as Record<string, unknown>;

          // Extract receipt ID + status from response
          // Response shape: { events: [{ data: { output: { receipt: { itemID, receiptUuid, ... } } }, eventStatusCode: { codeValue } }] }
          let enverusItemId: string | null = null;
          let enverusAccepted = false;
          try {
            const events = (body as any)?.events;
            const receipt = events?.[0]?.data?.output?.receipt;
            enverusItemId = receipt?.itemID?.toString() || receipt?.receiptUuid || null;
            const statusCode = events?.[0]?.eventStatusCode?.codeValue;
            enverusAccepted = statusCode === 'completed' || result.statusCode === 200;
          } catch (parseErr) {
            console.warn('[Enverus] Could not parse receipt response:', parseErr instanceof Error ? parseErr.message : parseErr);
          }

          const queueStatus = enverusAccepted ? 'accepted' : 'submitted';

          // Update queue entry
          await prisma.enverusSyncQueue.update({
            where: { id: queueEntry.id },
            data: {
              status: queueStatus,
              responseStatusCode: result.statusCode,
              responsePayload: JSON.stringify(result.body).slice(0, 10000),
              enverusItemId,
              submittedAt: new Date(),
              respondedAt: enverusAccepted ? new Date() : null,
              errorMessage: null,
            },
          });

          // Update ticket with receipt ID
          // EnverusReceiptStatus enum: submitted | approved | disputed | cancelled
          const receiptStatus = enverusAccepted ? 'approved' : 'submitted';
          await prisma.serviceTicket.update({
            where: { id: ticketId as string },
            data: {
              enverusReceiptId: enverusItemId,
              enverusReceiptStatus: receiptStatus,
            },
          });

          res.json({
            ok: true,
            message: enverusAccepted ? 'Receipt accepted by Enverus' : 'Receipt submitted to Enverus',
            queueEntryId: queueEntry.id,
            ticketNumber: ticket.ticketNumber,
            enverusItemId,
            enverusResponse: result.body,
          });
          return;
        } catch (err: unknown) {
          // Immediate submission failed — still queued for retry
          const errMsg = err instanceof Error ? err.message : String(err);
          await prisma.enverusSyncQueue.update({
            where: { id: queueEntry.id },
            data: {
              errorMessage: `Immediate submit failed: ${errMsg.slice(0, 2000)}`,
              status: 'retrying',
            },
          });
          res.json({
            ok: false,
            message: `Immediate submission failed (queued for retry): ${errMsg}`,
            queueEntryId: queueEntry.id,
            ticketNumber: ticket.ticketNumber,
          });
          return;
        }
      }

      res.json({
        ok: true,
        message: 'Receipt queued for Enverus submission',
        queueEntryId: queueEntry.id,
        ticketNumber: ticket.ticketNumber,
      });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);

// POST /receipts/cancel/:ticketId — queue a cancellation
enverusRouter.post(
  '/receipts/cancel/:ticketId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ticketId } = req.params;

      const ticket = await prisma.serviceTicket.findUnique({
        where: { id: ticketId as string },
        include: { billingProfile: true },
      });

      if (!ticket) throw new AppError(404, 'Ticket not found');
      if (!ticket.enverusReceiptId && !ticket.enverusReceiptStatus) {
        throw new AppError(400, 'Ticket has no Enverus receipt to cancel');
      }

      const queueEntry = await prisma.enverusSyncQueue.create({
        data: {
          entityType: 'receipt',
          entityId: ticketId as string,
          target: 'openinvoice',
          action: 'cancel',
          endpointUrl: '/events/supply-chain/v1/receipt.cancel',
          requestPayload: JSON.stringify({
            events: [{
              data: {
                transform: {
                  receipt: {
                    receiptNumber: ticket.ticketNumber,
                    buyerParty: {
                      partyDUNS: ticket.billingProfile?.buyerDuns,
                    },
                  },
                },
              },
            }],
          }),
          status: 'pending',
        },
      });

      await prisma.serviceTicket.update({
        where: { id: ticketId as string },
        data: { enverusReceiptStatus: 'cancelled' },
      });

      await createAuditLog({
        userId: req.user?.userId,
        entityType: 'service_ticket',
        entityId: ticketId as string,
        action: 'submit',
        changes: { action: 'enverus_receipt_cancel_queued', queueEntryId: queueEntry.id },
      });

      res.json({
        ok: true,
        message: 'Receipt cancellation queued',
        queueEntryId: queueEntry.id,
      });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Invoice Submission
// ─────────────────────────────────────────────────────────────────────────────

// POST /invoices/submit/:invoiceId
enverusRouter.post(
  '/invoices/submit/:invoiceId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId } = req.params;

      // Accept Enverus field overrides from request body
      const overrides: EnverusSubmitOverrides = {
        orderedByName: req.body.orderedByName as string | undefined,
        afeNumber: req.body.afeNumber as string | undefined,
        costCenter: req.body.costCenter as string | undefined,
        poNumber: req.body.poNumber as string | undefined,
        receiptType: req.body.receiptType as string | undefined,
        contractNumber: req.body.contractNumber as string | undefined,
        // COP-specific fields (buyer-field-rules mapping)
        serviceApprover: req.body.serviceApprover as string | undefined,
        invoiceApproverName: req.body.invoiceApproverName as string | undefined,
        priceBookNumber: req.body.priceBookNumber as string | undefined,
        major: req.body.major as string | undefined,               // COP "Activity Code"
        minor: req.body.minor as string | undefined,               // COP "Functional Area"
        location: req.body.location as string | undefined,
        crewMembers: req.body.crewMembers as string[] | undefined,
      };

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId as string },
        include: {
          lineItems: {
            include: { product: true },
            orderBy: { lineNumber: 'asc' },
          },
          company: {
            include: {
              billingProfiles: {
                where: { enverusEnabled: true, isActive: true },
                take: 1,
              },
            },
          },
        },
      });

      if (!invoice) throw new AppError(404, 'Invoice not found');

      // Invoice must be approved (or later) before submitting to Enverus
      const allowedStatuses = ['approved', 'queued', 'so_created', 'invoiced'];
      if (!allowedStatuses.includes(invoice.status)) {
        throw new AppError(
          400,
          `Invoice must be approved before Enverus submission (current: ${invoice.status})`,
        );
      }

      const profile = invoice.company?.billingProfiles?.[0];
      if (!profile) {
        throw new AppError(400, 'Company has no active Enverus-enabled billing profile');
      }

      const profileErrors = validateProfileForInvoice(profile);
      if (profileErrors.length > 0) {
        throw new AppError(400, `Billing profile validation failed: ${profileErrors.join('; ')}`);
      }

      // Persist billing field overrides on the invoice record
      if (overrides.afeNumber || overrides.costCenter || overrides.poNumber) {
        await prisma.invoice.update({
          where: { id: invoiceId as string },
          data: {
            ...(overrides.afeNumber ? { afeNumber: overrides.afeNumber } : {}),
            ...(overrides.costCenter ? { costCenter: overrides.costCenter } : {}),
            ...(overrides.poNumber ? { poNumber: overrides.poNumber } : {}),
          },
        });
        // Update local copy too
        if (overrides.afeNumber) (invoice as any).afeNumber = overrides.afeNumber;
        if (overrides.costCenter) (invoice as any).costCenter = overrides.costCenter;
        if (overrides.poNumber) (invoice as any).poNumber = overrides.poNumber;
      }

      // Check for existing queue entry
      const existing = await prisma.enverusSyncQueue.findFirst({
        where: {
          entityId: invoiceId as string,
          entityType: 'invoice',
          status: { in: ['pending', 'submitted', 'retrying'] },
        },
      });
      if (existing) {
        throw new AppError(
          409,
          `Invoice already has a ${existing.status} Enverus submission (queue ${existing.id})`,
        );
      }

      // Build payload as receipt (the /supply-chain/v3/invoice endpoint requires
      // elevated permissions; the receipt.submit endpoint is universally available)
      overrides.facilityCode = await resolveInvoiceFacilityCode(invoice.lineItems);
      // Attach the source ticket's tech as each line's crewMember (per-line).
      const crewByTicket = await resolveLineCrewMembers(invoice.lineItems);
      const linesWithCrew = invoice.lineItems.map((li: any) => ({
        ...li,
        crewMember: li.sourceTicketId ? crewByTicket.get(li.sourceTicketId) ?? null : null,
      }));
      const payload = buildInvoiceAsReceiptPayload(invoice, linesWithCrew, profile, overrides);

      // Create queue entry — uses receipt endpoint
      const queueEntry = await prisma.enverusSyncQueue.create({
        data: {
          entityType: 'invoice',
          entityId: invoiceId as string,
          target: 'openinvoice',
          action: 'submit',
          endpointUrl: '/events/supply-chain/v1/receipt.submit',
          requestPayload: JSON.stringify(payload),
          status: 'pending',
        },
      });

      // ?immediate=true — fire receipt NOW instead of waiting for queue processor
      if (req.query.immediate === 'true') {
        try {
          // Generate PDF attachment for the invoice receipt
          let pdfBuffer: Buffer | undefined;
          let pdfFileName = 'invoice.pdf';
          try {
            const pdf = await getInvoicePdfBuffer(invoiceId as string, prisma);
            pdfBuffer = pdf.buffer;
            pdfFileName = pdf.fileName;
            console.log(`[Enverus] Invoice receipt attachment: ${pdfFileName} (${pdfBuffer.length} bytes)`);
          } catch (pdfErr) {
            console.warn('[Enverus] Invoice PDF generation failed, submitting without attachment:', pdfErr instanceof Error ? pdfErr.message : pdfErr);
          }

          const result = await submitReceiptWithAttachment(payload, pdfBuffer, pdfFileName);
          const body = result.body as Record<string, unknown>;

          // Extract receipt ID + status from response
          let enverusItemId: string | null = null;
          let enverusAccepted = false;
          try {
            const events = (body as any)?.events;
            const receipt = events?.[0]?.data?.output?.receipt;
            enverusItemId = receipt?.itemID?.toString() || receipt?.receiptUuid || null;
            const statusCode = events?.[0]?.eventStatusCode?.codeValue;
            enverusAccepted = statusCode === 'completed' || result.statusCode === 200;
          } catch (parseErr) {
            console.warn('[Enverus] Could not parse receipt response:', parseErr instanceof Error ? parseErr.message : parseErr);
          }

          const queueStatus = enverusAccepted ? 'accepted' : 'submitted';

          // Update queue entry
          await prisma.enverusSyncQueue.update({
            where: { id: queueEntry.id },
            data: {
              status: queueStatus,
              responseStatusCode: result.statusCode,
              responsePayload: JSON.stringify(result.body).slice(0, 10000),
              enverusItemId,
              submittedAt: new Date(),
              respondedAt: enverusAccepted ? new Date() : null,
              errorMessage: null,
            },
          });

          // Update invoice
          await prisma.invoice.update({
            where: { id: invoiceId as string },
            data: {
              enverusStatus: enverusAccepted ? 'accepted' : 'submitted',
              enverusSubmittedAt: new Date(),
            },
          });

          await createAuditLog({
            userId: req.user?.userId,
            entityType: 'invoice',
            entityId: invoiceId as string,
            action: 'submit',
            changes: {
              action: 'enverus_invoice_submitted',
              queueEntryId: queueEntry.id,
              buyerDuns: profile.buyerDuns,
              enverusItemId,
            },
          });

          res.json({
            ok: true,
            message: enverusAccepted ? 'Invoice accepted by Enverus' : 'Invoice submitted to Enverus',
            queueEntryId: queueEntry.id,
            invoiceNumber: invoice.invoiceNumber,
            enverusItemId,
            enverusResponse: result.body,
          });
          return;
        } catch (err: unknown) {
          // Immediate submission failed — save full error + response body
          const errMsg = err instanceof Error ? err.message : String(err);
          const responseBody = (err as any)?.responseBody || null;
          await prisma.enverusSyncQueue.update({
            where: { id: queueEntry.id },
            data: {
              errorMessage: `Immediate submit failed: ${errMsg.slice(0, 4000)}`,
              responsePayload: responseBody ? String(responseBody).slice(0, 10000) : null,
              responseStatusCode: (err as any)?.statusCode || null,
              status: 'error',
              respondedAt: new Date(),
            },
          });
          // Fall through to return queued response
        }
      }

      // Update invoice
      await prisma.invoice.update({
        where: { id: invoiceId as string },
        data: {
          enverusStatus: 'submitted',
          enverusSubmittedAt: new Date(),
        },
      });

      await createAuditLog({
        userId: req.user?.userId,
        entityType: 'invoice',
        entityId: invoiceId as string,
        action: 'submit',
        changes: {
          action: 'enverus_invoice_queued',
          queueEntryId: queueEntry.id,
          buyerDuns: profile.buyerDuns,
        },
      });

      res.json({
        ok: true,
        message: 'Invoice queued for Enverus submission',
        queueEntryId: queueEntry.id,
        invoiceNumber: invoice.invoiceNumber,
      });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Status Polling
// ─────────────────────────────────────────────────────────────────────────────

// GET /receipts/status/:ticketId — live poll Enverus + update local status
enverusRouter.get(
  '/receipts/status/:ticketId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ticketId } = req.params;

      const ticket = await prisma.serviceTicket.findUnique({
        where: { id: ticketId as string },
        select: {
          id: true,
          ticketNumber: true,
          enverusReceiptId: true,
          enverusReceiptStatus: true,
        },
      });

      if (!ticket) throw new AppError(404, 'Ticket not found');

      // If we have a receipt number, poll Enverus for live status
      let enverusData: unknown = null;
      if (ticket.ticketNumber) {
        try {
          const pollResult = await pollReceiptStatus(ticket.ticketNumber);
          enverusData = pollResult.body?.value?.[0] ?? null;

          // Update local status if Enverus has new info
          if (enverusData && typeof enverusData === 'object') {
            const data = enverusData as Record<string, unknown>;
            let newStatus: 'submitted' | 'approved' | 'disputed' | null = null;

            if (data.status === 'Approved' || data.approvedDatetime) {
              newStatus = 'approved';
            } else if (data.status === 'Disputed' || data.disputedDatetime) {
              newStatus = 'disputed';
            }

            if (newStatus && newStatus !== ticket.enverusReceiptStatus) {
              await prisma.serviceTicket.update({
                where: { id: ticketId as string },
                data: { enverusReceiptStatus: newStatus },
              });
            }
          }
        } catch (pollErr) {
          console.warn('[Enverus] Non-fatal status poll error:', pollErr instanceof Error ? pollErr.message : pollErr);
        }
      }

      // Also get queue history for this ticket
      const queueEntries = await prisma.enverusSyncQueue.findMany({
        where: { entityId: ticketId as string, entityType: 'receipt' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      res.json({
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        enverusReceiptId: ticket.enverusReceiptId,
        enverusReceiptStatus: ticket.enverusReceiptStatus,
        enverusLiveData: enverusData,
        queueHistory: queueEntries,
      });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);

// GET /invoices/status/:invoiceId — return cached status + queue history
enverusRouter.get(
  '/invoices/status/:invoiceId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId } = req.params;

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId as string },
        select: {
          id: true,
          invoiceNumber: true,
          enverusReceiptId: true,
          enverusStatus: true,
          enverusSubmittedAt: true,
        },
      });

      if (!invoice) throw new AppError(404, 'Invoice not found');

      const queueEntries = await prisma.enverusSyncQueue.findMany({
        where: { entityId: invoiceId as string, entityType: 'invoice' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      res.json({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        enverusReceiptId: invoice.enverusReceiptId,
        enverusStatus: invoice.enverusStatus,
        enverusSubmittedAt: invoice.enverusSubmittedAt,
        queueHistory: queueEntries,
      });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Open Ticket (Field Ticket) Submission
// ─────────────────────────────────────────────────────────────────────────────

// POST /field-tickets/submit/:invoiceId — build PIDX XML, queue or submit immediately
enverusRouter.post(
  '/field-tickets/submit/:invoiceId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId } = req.params;

      // Accept overrides from request body
      const overrides = {
        serviceApprover: req.body.serviceApprover as string | undefined,
        contractNumber: req.body.contractNumber as string | undefined,
        afeNumber: req.body.afeNumber as string | undefined,
        costCenter: req.body.costCenter as string | undefined,
        orderedByName: req.body.orderedByName as string | undefined,
        receiptType: req.body.receiptType as string | undefined,
        superintendentName: req.body.superintendentName as string | undefined,
        officeApproverName: req.body.officeApproverName as string | undefined,
        invoiceApproverName: req.body.invoiceApproverName as string | undefined,
        crewMembers: req.body.crewMembers as string[] | undefined,
        // COP "Activity Code" → line.major, "Functional Area" → line.minor.
        // These are standard Enverus line fields, NOT additionalDataFields.
        major: req.body.major as string | undefined,
        minor: req.body.minor as string | undefined,
        additionalDataFields: req.body.additionalDataFields as Array<{
          itemID?: string; code?: string; name?: string; value: string; referenceDetailId?: string;
        }> | undefined,
      };

      // Load invoice with line items + company billing profile
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId as string },
        include: {
          lineItems: {
            include: { product: true },
            orderBy: { lineNumber: 'asc' },
          },
          company: {
            include: {
              billingProfiles: {
                where: { enverusEnabled: true, isActive: true },
                take: 1,
              },
            },
          },
        },
      });

      if (!invoice) throw new AppError(404, 'Invoice not found');

      // Invoice must be approved
      const allowedStatuses = ['approved', 'queued', 'so_created', 'invoiced'];
      if (!allowedStatuses.includes(invoice.status)) {
        throw new AppError(
          400,
          `Invoice must be approved before Enverus submission (current: ${invoice.status})`,
        );
      }

      const profile = invoice.company?.billingProfiles?.[0];
      if (!profile) {
        throw new AppError(400, 'Company has no active Enverus-enabled billing profile');
      }

      // Validate mode allows open ticket
      if (profile.enverusReceiptMode !== 'openticket' && profile.enverusReceiptMode !== 'both') {
        throw new AppError(
          400,
          `Billing profile receipt mode is "${profile.enverusReceiptMode}" — Open Ticket requires "openticket" or "both"`,
        );
      }

      if (!profile.buyerDuns) {
        throw new AppError(400, 'Billing profile missing buyerDuns');
      }

      // Check for existing pending/submitted queue entry
      const existing = await prisma.enverusSyncQueue.findFirst({
        where: {
          entityId: invoiceId as string,
          entityType: 'field_ticket',
          status: { in: ['pending', 'submitted', 'retrying'] },
        },
      });
      if (existing) {
        throw new AppError(
          409,
          `Invoice already has a ${existing.status} Open Ticket submission (queue ${existing.id})`,
        );
      }

      // Resolve service approver + contract number (override > invoice > profile default)
      const serviceApprover =
        overrides.serviceApprover ||
        (profile as any).defaultServiceApprover ||
        '';
      const contractNumber =
        overrides.contractNumber ||
        invoice.poNumber ||
        (profile as any).defaultPriceBookNumber ||
        '';

      const supplierDuns = getSupplierDuns();
      const serviceDateFrom = invoice.periodStart
        ? new Date(invoice.periodStart).toISOString().split('T')[0]
        : new Date(invoice.invoiceDate).toISOString().split('T')[0];
      const serviceDateTo = invoice.periodEnd
        ? new Date(invoice.periodEnd).toISOString().split('T')[0]
        : serviceDateFrom;

      // Receipt type: override → default LEM (Basin Safety is all-LEM in practice).
      // PIDX/General was removed when production went all-LEM via receipt.submit.
      const receiptType = (overrides.receiptType || 'lem').toLowerCase();

      let submissionPayload: string;
      const endpointUrl = '/events/supply-chain/v1/receipt.submit';

      // Per-location facility code (well > pad) from the invoice's source tickets.
      const facilityCode = await resolveInvoiceFacilityCode(invoice.lineItems || []);
      // Field tech per source ticket → COP Labor-line crewMember.
      const crewByTicket = await resolveLineCrewMembers(invoice.lineItems || []);

      {
        // JSON via receipt.submit (LEM / Water Hauling / Chemicals)
        const receiptPayload = buildInvoiceAsReceiptPayload(
          {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate,
            periodStart: invoice.periodStart,
            periodEnd: invoice.periodEnd,
            companyName: invoice.companyName,
            subtotal: invoice.subtotal,
            taxAmount: invoice.taxAmount,
            total: invoice.total,
            poNumber: invoice.poNumber,
            afeNumber: invoice.afeNumber,
            costCenter: invoice.costCenter,
            notes: invoice.notes,
          },
          (invoice.lineItems || []).map((li: any) => ({
            lineNumber: li.lineNumber || li.sortOrder || 1,
            description: li.description || li.product?.name || 'Service',
            quantity: li.quantity,
            unitOfMeasure: li.unitOfMeasure,
            rate: li.rate,
            amount: li.amount,
            isTaxable: li.isTaxable || false,
            sourceTicketNumber: li.sourceTicketNumber,
            // Part # / Item ID — send the SAME identifier QB gets (qbItemFullName),
            // falling back to an explicit line partNumber. Empty → Enverus defaults
            // the service code to "PRODUCT" (see 2026-06-16 400 warning).
            partNumber: li.partNumber || li.qbItemFullName,
            // Crew member = the tech assigned to the source ticket (per line).
            crewMember: li.sourceTicketId ? crewByTicket.get(li.sourceTicketId) ?? null : null,
            product: li.product ? {
              enverusProductServiceCode: li.product.enverusProductServiceCode,
              enverusProductServiceDescription: li.product.enverusProductServiceDescription,
              enverusUnitOfMeasure: li.product.enverusUnitOfMeasure,
            } : null,
          })),
          profile as any,
          {
            receiptType,
            afeNumber: overrides.afeNumber,
            costCenter: overrides.costCenter,
            poNumber: overrides.contractNumber, // contractNumber maps to PO for receipts
            orderedByName: overrides.orderedByName || serviceApprover || undefined,
            contractNumber: contractNumber || undefined,
            serviceApprover: serviceApprover || undefined,
            superintendentName: overrides.superintendentName,
            officeApproverName: overrides.officeApproverName,
            invoiceApproverName: overrides.invoiceApproverName,
            crewMembers: overrides.crewMembers,
            major: overrides.major,
            minor: overrides.minor,
            additionalDataFields: overrides.additionalDataFields,
            facilityCode,
          },
        );
        submissionPayload = JSON.stringify(receiptPayload);
      }

      // Create queue entry
      const queueEntry = await prisma.enverusSyncQueue.create({
        data: {
          entityType: 'field_ticket',
          entityId: invoiceId as string,
          target: 'openticket',
          action: 'submit',
          endpointUrl,
          requestPayload: submissionPayload.slice(0, 10000),
          status: 'pending',
        },
      });

      // ?immediate=true — fire NOW
      if (req.query.immediate === 'true') {
        try {
          // Generate PDF attachment if possible
          let pdfBuffer: Buffer | undefined;
          try {
            const pdfDoc = generateInvoicePdf(invoice as any);
            pdfBuffer = await pdfToBuffer(pdfDoc);
          } catch (pdfErr) {
            console.warn('[Enverus OT] PDF generation failed, submitting without attachment:', pdfErr instanceof Error ? pdfErr.message : pdfErr);
          }

          const result = await submitReceiptWithAttachment(
            JSON.parse(submissionPayload),
            pdfBuffer,
            `${invoice.invoiceNumber}.pdf`,
          );
          const body = result.body as Record<string, unknown>;

          // Extract item ID from response
          let enverusItemId: string | null = null;
          let enverusAccepted = false;
          try {
            const events = (body as any)?.events;
            const ft = events?.[0]?.data?.output?.fieldTicket || events?.[0]?.data?.output?.receipt;
            enverusItemId = ft?.itemID?.toString() || ft?.fieldTicketUuid || ft?.receiptUuid || null;
            const statusCode = events?.[0]?.eventStatusCode?.codeValue;
            enverusAccepted = statusCode === 'completed' || result.statusCode === 200;
          } catch (parseErr) {
            console.warn('[Enverus OT] Could not parse response:', parseErr instanceof Error ? parseErr.message : parseErr);
          }

          if (!enverusItemId) {
            enverusItemId = (body?.itemID as string) || (body?.id as string) || null;
          }

          const queueStatus = enverusAccepted ? 'accepted' : 'submitted';

          await prisma.enverusSyncQueue.update({
            where: { id: queueEntry.id },
            data: {
              status: queueStatus,
              responseStatusCode: result.statusCode,
              responsePayload: JSON.stringify(result.body).slice(0, 10000),
              enverusItemId,
              submittedAt: new Date(),
              respondedAt: enverusAccepted ? new Date() : null,
              errorMessage: null,
            },
          });

          await prisma.invoice.update({
            where: { id: invoiceId as string },
            data: {
              enverusStatus: enverusAccepted ? 'accepted' : 'submitted',
              enverusSubmittedAt: new Date(),
            },
          });

          await createAuditLog({
            userId: req.user?.userId,
            entityType: 'invoice',
            entityId: invoiceId as string,
            action: 'submit',
            changes: {
              action: 'enverus_field_ticket_submitted',
              queueEntryId: queueEntry.id,
              buyerDuns: profile.buyerDuns,
              enverusItemId,
            },
          });

          res.json({
            ok: true,
            message: enverusAccepted ? 'Field ticket accepted by Enverus' : 'Field ticket submitted to Enverus',
            queueEntryId: queueEntry.id,
            invoiceNumber: invoice.invoiceNumber,
            enverusItemId,
            enverusResponse: result.body,
          });
          return;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const responseBody = (err as any)?.responseBody || null;
          await prisma.enverusSyncQueue.update({
            where: { id: queueEntry.id },
            data: {
              errorMessage: `Immediate submit failed: ${errMsg.slice(0, 4000)}`,
              responsePayload: responseBody ? String(responseBody).slice(0, 10000) : null,
              responseStatusCode: (err as any)?.statusCode || null,
              status: 'error',
              respondedAt: new Date(),
            },
          });
          // Fall through to return queued response with error info
        }
      }

      // Update invoice
      await prisma.invoice.update({
        where: { id: invoiceId as string },
        data: {
          enverusStatus: 'submitted',
          enverusSubmittedAt: new Date(),
        },
      });

      await createAuditLog({
        userId: req.user?.userId,
        entityType: 'invoice',
        entityId: invoiceId as string,
        action: 'submit',
        changes: {
          action: 'enverus_field_ticket_queued',
          queueEntryId: queueEntry.id,
          buyerDuns: profile.buyerDuns,
        },
      });

      res.json({
        ok: true,
        message: 'Field ticket queued for Enverus submission',
        queueEntryId: queueEntry.id,
        invoiceNumber: invoice.invoiceNumber,
      });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);

// GET /field-tickets/status/:invoiceId — poll Open Ticket status
enverusRouter.get(
  '/field-tickets/status/:invoiceId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceId } = req.params;

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId as string },
        select: {
          id: true,
          invoiceNumber: true,
          enverusReceiptId: true,
          enverusStatus: true,
          enverusSubmittedAt: true,
        },
      });

      if (!invoice) throw new AppError(404, 'Invoice not found');

      // Poll Enverus for live status — after PIDX rip these are receipts.
      let enverusData: unknown = null;
      if (invoice.invoiceNumber) {
        try {
          const pollResult = await pollReceiptStatus(invoice.invoiceNumber);
          enverusData = pollResult.body?.value?.[0] ?? null;

          if (enverusData && typeof enverusData === 'object') {
            const data = enverusData as Record<string, unknown>;
            let newStatus: string | null = null;

            if (data.status === 'Approved' || data.approvedDatetime) {
              newStatus = 'accepted';
            } else if (data.status === 'Disputed' || data.disputedDatetime) {
              newStatus = 'disputed';
            }

            if (newStatus && newStatus !== invoice.enverusStatus) {
              await prisma.invoice.update({
                where: { id: invoiceId as string },
                data: { enverusStatus: newStatus },
              });
            }
          }
        } catch (pollErr) {
          console.warn('[Enverus OT] Non-fatal status poll error:', pollErr instanceof Error ? pollErr.message : pollErr);
        }
      }

      const queueEntries = await prisma.enverusSyncQueue.findMany({
        where: { entityId: invoiceId as string, entityType: 'field_ticket' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      res.json({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        enverusReceiptId: invoice.enverusReceiptId,
        enverusStatus: invoice.enverusStatus,
        enverusSubmittedAt: invoice.enverusSubmittedAt,
        enverusLiveData: enverusData,
        queueHistory: queueEntries,
      });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      try { mapEnverusError(err); } catch (mapped) { next(mapped); }
    }
  },
);
// ─────────────────────────────────────────────────────────────────────────────
// Queue Management
// ─────────────────────────────────────────────────────────────────────────────

// GET /queue — list queue entries (filterable by status, entityType)
enverusRouter.get(
  '/queue',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, entityType, limit = '50', offset = '0' } = req.query;

      const where: Prisma.EnverusSyncQueueWhereInput = {};
      if (status) where.status = status as string as any;
      if (entityType) where.entityType = entityType as string as any;

      const [entries, total] = await Promise.all([
        prisma.enverusSyncQueue.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: parseInt(limit as string, 10),
          skip: parseInt(offset as string, 10),
        }),
        prisma.enverusSyncQueue.count({ where }),
      ]);

      // Attach the human-readable source number (invoice #/ticket #). The Enverus
      // itemID isn't searchable anywhere in OI's UI, so without this the card is
      // just "something happened" with an opaque id.
      const invoiceIds = entries
        .filter((e) => e.entityType === 'invoice' || e.entityType === 'field_ticket')
        .map((e) => e.entityId);
      const ticketIds = entries.filter((e) => e.entityType === 'receipt').map((e) => e.entityId);
      const [invoices, tickets] = await Promise.all([
        invoiceIds.length
          ? prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true } })
          : Promise.resolve([]),
        ticketIds.length
          ? prisma.serviceTicket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, ticketNumber: true } })
          : Promise.resolve([]),
      ]);
      const invMap = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
      const tixMap = new Map(tickets.map((t) => [t.id, t.ticketNumber]));
      const enriched = entries.map((e) => ({
        ...e,
        entityNumber: invMap.get(e.entityId) ?? tixMap.get(e.entityId) ?? null,
      }));

      res.json({ data: enriched, total, limit: parseInt(limit as string, 10), offset: parseInt(offset as string, 10) });
    } catch (err) {
      next(err);
    }
  },
);

// GET /queue/stats — count by status
enverusRouter.get(
  '/queue/stats',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await prisma.enverusSyncQueue.groupBy({
        by: ['status'],
        _count: true,
      });

      const result: Record<string, number> = {};
      for (const row of stats) {
        result[row.status] = row._count;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /queue/:id/retry — reset failed entry to pending
enverusRouter.post(
  '/queue/:id/retry',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const entry = await prisma.enverusSyncQueue.findUnique({
        where: { id: id as string },
      });

      if (!entry) throw new AppError(404, 'Queue entry not found');
      if (!['error', 'rejected'].includes(entry.status)) {
        throw new AppError(400, `Cannot retry entry with status "${entry.status}"`);
      }

      const updated = await prisma.enverusSyncQueue.update({
        where: { id: id as string },
        data: {
          status: 'pending',
          errorMessage: null,
          responsePayload: null,
          responseStatusCode: null,
        },
      });

      await createAuditLog({
        userId: req.user?.userId,
        entityType: 'enverus_queue',
        entityId: id as string,
        action: 'update',
        changes: {
          action: 'retry',
          previousStatus: entry.status,
          entityType: entry.entityType,
          entityId: entry.entityId,
        },
      });

      res.json({ ok: true, entry: updated });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      next(err);
    }
  },
);

// DELETE /queue/:id — remove entry
enverusRouter.delete(
  '/queue/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const entry = await prisma.enverusSyncQueue.findUnique({
        where: { id: id as string },
      });

      if (!entry) throw new AppError(404, 'Queue entry not found');

      await prisma.enverusSyncQueue.delete({
        where: { id: id as string },
      });

      await createAuditLog({
        userId: req.user?.userId,
        entityType: 'enverus_queue',
        entityId: id as string,
        action: 'delete',
        changes: {
          entityType: entry.entityType,
          entityId: entry.entityId,
          status: entry.status,
        },
      });

      res.json({ ok: true, message: 'Queue entry removed' });
    } catch (err) {
      if (err instanceof AppError) return next(err);
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Alerts — "World on Fire" endpoint
// ─────────────────────────────────────────────────────────────────────────────

// GET /alerts — returns all items needing attention
enverusRouter.get(
  '/alerts',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Queue entries with error status (API rejected)
      const errors = await prisma.enverusSyncQueue.findMany({
        where: { status: 'error' },
        orderBy: { createdAt: 'desc' },
      });

      // Queue entries with rejected status (buyer disputed)
      const rejected = await prisma.enverusSyncQueue.findMany({
        where: { status: 'rejected' },
        orderBy: { createdAt: 'desc' },
      });

      // Tickets with disputed receipt status
      const disputedTickets = await prisma.serviceTicket.findMany({
        where: { enverusReceiptStatus: 'disputed' },
        select: {
          id: true,
          ticketNumber: true,
          enverusReceiptId: true,
          enverusReceiptStatus: true,
          serviceDate: true,
          companyId: true,
          company: { select: { name: true } },
        },
        orderBy: { serviceDate: 'desc' },
      });

      const totalIssues = errors.length + rejected.length + disputedTickets.length;

      res.json({
        hasIssues: totalIssues > 0,
        totalIssues,
        errors: {
          count: errors.length,
          items: errors,
        },
        disputed: {
          count: rejected.length + disputedTickets.length,
          queueItems: rejected,
          tickets: disputedTickets,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
