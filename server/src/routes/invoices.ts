import { approvedInvoiceAllocations, invoiceApprovalTickets } from '../services/ticketApprovalAllocation.js';
import { billingCardLocation, billingLocationSelect, invoiceCardLocations, shopBillingCardLocation } from '../services/billingCardLocation.js';
import { billingApprovalPlan, splitBillingApprovals } from '../services/billingApprovalSplit.js';
import { profileForBillingWork } from '../services/billingApprovalGroups.js';
import { resolveInvoiceBillingProfile } from '../services/invoiceBillingProfile.js';
import { lockRental, rentalDate, rentalToday } from '../services/rentalLifecycle.js';
import { occupiedRentalPeriods, dailyRentalCharges, proratedRentalCharges, rentalBillingDays } from '../services/rentalBillingPolicy.js';
import { applyCustomerDescriptions } from '../services/customerDescriptions.js';
import { invoiceQbErrors } from '../services/invoiceQbStatus.js';
import { rentalSweepLines } from '../services/rentalSweepLines.js';
import { applyInvoiceProductTax } from '../services/invoiceProductTax.js';
import { inspectionBillingError } from '../services/inspectionBillingGuard.js';
import { excludedShopTicketIds, getBilledShopWorkOrderIds, shopBillingExcluded } from '../services/shopBillingQueue.js';
import { assertShopBillingAllowed, previewShopBillingWaiver, waiveShopBilling } from '../services/shopBillingWaiver.js';
import { priceShopCharges } from '../services/shopChargePreview.js';
import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { createAuditLog } from '../utils/auditLog.js';
import { generateInvoiceNumber } from '../utils/ticketNumber.js';
import { getProductForCourse, getCourseLabel, trainingBillingBasis } from '../utils/courseProductMap.js';
import { getDefaultPartNumber, getLaborProduct, getMileageProduct } from '../utils/servicePartMap.js';
import { hasRatedComposition, unpricedCompositionLines, hasRate, RENTAL_DEFAULT_DIVISION, type RentalComposition } from '../services/rentalComposition.js';
import { defaultDivisionForWork, DICKINSON_SITE_SHORT_CODE, SHOP_DIVISION } from '../utils/qbClass.js';
import { resolveInvoiceRules } from '../services/billingRules.js';
import { blockersFor, isReadyForBilling, rentalReleaseState, RELEASE_BLOCKING_STATUSES } from '../services/rentalBillingRelease.js';
import { computeRentalBillingState, seedsDeliveryPickupLines } from '../services/rentalBilling.js';
import { billableRentalPeriods, isBillingPaused, isMannedDailyTicket, parseRentalBillingPolicy, ticketRatesOn } from '../services/rentalBillingPolicy.js';
import { isBillableShopItem, toBillingItem, type ShopBillingItem } from '../services/shopBillingLines.js';
import { billingRoute, collectedTotal, attribution } from '../services/paidAtDrop.js';
import {
  defaultTaxableForLineType,
  resolveJurisdictionForCounty,
  getJurisdictionRate,
  countyFromTicketLocations,
  computeTaxAmount,
} from '../services/salesTax.js';
import { generateInvoicePdf } from '../services/invoicePdfGenerator.js';
import { pdfToBuffer } from '../utils/pdfToBuffer.js';
import { getFileStore, invoiceKey } from '../services/fileStore.js';
import { requirePermission } from '../middleware/rbac.js';
import { roleHasCapability } from '../services/permissions.js';
import { runAndCacheReviewSignal } from '../services/ticketReviewRules.js';
import { emitEvent } from '../services/eventBus.js';
import { upsertDocRefAndLines } from '../services/billingLineage.js';
import { invoiceBillingCodes } from '../services/locationBillingCodes.js';
import { Prisma, type InvoiceStatus } from '../db.js';

export const invoicesRouter = Router();

invoicesRouter.get('/shop-billing-waiver/preview', requirePermission('shop_orders:waive_billing'), async (_req: Request, res: Response) => {
  res.json({ data: await previewShopBillingWaiver() });
});
invoicesRouter.post('/shop-billing-waiver', requirePermission('shop_orders:waive_billing'), async (req: Request, res: Response) => {
  const { ids, reason } = req.body;
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string') || typeof reason !== 'string') throw new AppError(400, 'Workorder IDs and a reason are required');
  res.json(await waiveShopBilling(ids, reason, req.user!.userId));
});

// ============================================================
// GET / — List invoices (filterable)
// ============================================================

invoicesRouter.get('/', async (req: Request, res: Response) => {
  const { status, companyId, rentalAgreementId, search, limit = '50', offset = '0' } = req.query;

  const where: any = {};
  if (status) where.status = { in: String(status).split(',').map(s => s.trim()).filter(Boolean) };
  if (companyId) where.companyId = companyId as string;
  if (rentalAgreementId) where.rentalAgreementId = rentalAgreementId as string;
  if (search) {
    const q = (search as string).trim();
    where.OR = [
      { invoiceNumber: { contains: q, mode: 'insensitive' } },
      { companyName: { contains: q, mode: 'insensitive' } },
      { qbCustomerOverride: { contains: q, mode: 'insensitive' } },
      { poNumber: { contains: q, mode: 'insensitive' } },
      { qbSalesOrderNumber: { contains: q, mode: 'insensitive' } },
      { qbInvoiceNumber: { contains: q, mode: 'insensitive' } },
      { createdBy: { name: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const [rawInvoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(200, Math.max(1, parseInt(String(limit), 10) || 50)),
      skip: Math.max(0, parseInt(String(offset), 10) || 0),
      include: {
        company: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        _count: { select: { lineItems: true } },
        lineItems: { select: { sourceTicketId: true, sourceTicketNumber: true }, distinct: ['sourceTicketId'] },
      },
    }),
    prisma.invoice.count({ where }),
  ]);

  const qbErrors = await invoiceQbErrors(prisma, rawInvoices);
  const locations = await invoiceCardLocations(prisma, rawInvoices);
  // Extract distinct source tickets and strip lineItems from response
  const invoices = rawInvoices.map(inv => {
    const sourceTickets = inv.lineItems
      .filter(li => li.sourceTicketId)
      .map(li => ({ id: li.sourceTicketId!, number: li.sourceTicketNumber }));
    // Deduplicate by ticket ID
    const seen = new Set<string>();
    const uniqueTickets = sourceTickets.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
    const { lineItems: _li, ...rest } = inv;
    return { ...rest, locationName: locations.get(inv.id) ?? null, sourceTickets: uniqueTickets, qbExportError: qbErrors.get(inv.id) ?? null };
  });

  res.json({ data: invoices, total });
});

// ============================================================
// GET /stats — Billing dashboard stats
// ============================================================

invoicesRouter.get('/stats', async (_req: Request, res: Response) => {
  const [
    draftCount,
    approvedCount,
    queuedCount,
    soCreatedCount,
    invoicedCount,
    totalOutstanding,
  ] = await Promise.all([
    prisma.invoice.count({ where: { status: 'draft' } }),
    prisma.invoice.count({ where: { status: 'approved' } }),
    prisma.invoice.count({ where: { status: 'queued' } }),
    prisma.invoice.count({ where: { status: 'so_created' } }),
    prisma.invoice.count({ where: { status: 'invoiced' } }),
    // Month-to-date billing total: all non-void invoices created this calendar month
    (() => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      return prisma.invoice.aggregate({
        where: {
          status: { not: 'void' },
          invoiceDate: { gte: monthStart },
        },
        _sum: { total: true },
      });
    })(),
  ]);

  // Tickets in billing_queue (ready to be invoiced)
  const ticketsInBillingQueue = await prisma.serviceTicket.count({
    where: { status: 'billing_queue', id: { notIn: await excludedShopTicketIds() } },
  });

  // Completed shop WOs not yet billed (closed, not internal, no direct invoice
  // AND no RP ticket already spawned from the per-unit sweep).
  const billedWOIdSet = await getBilledShopWorkOrderIds();

  const allClosedWOs = await prisma.shopWorkOrder.findMany({
    where: { status: 'closed', isInternal: false },
    select: { id: true },
  });
  const shopWOsReadyToBill = allClosedWOs.filter(wo => !billedWOIdSet.has(wo.id)).length;

  const invoiceStatuses = await prisma.invoice.groupBy({ by: ['status'], _count: true });
  const statusCounts = Object.fromEntries(invoiceStatuses.map(row => [row.status, row._count]));

  // Active rentals with deployed items
  const activeRentalsWithItems = await prisma.rentalAgreement.count({
    where: { status: 'active', items: { some: { status: 'deployed' } } },
  });

  res.json({
    drafts: draftCount,
    approved: approvedCount,
    queued: queuedCount,
    salesOrders: soCreatedCount,
    invoiced: invoicedCount,
    monthToDateTotal: totalOutstanding._sum.total || 0,
    ticketsReadyToBill: ticketsInBillingQueue,
    shopWOsReadyToBill,
    activeRentals: activeRentalsWithItems,
    statusCounts,
  });
});

// ============================================================
// GET /uninvoiced/shop-wos — List closed shop WOs with no invoice
// ============================================================

invoicesRouter.get('/uninvoiced/shop-wos', async (_req: Request, res: Response) => {
  // Hide WOs already being billed — a shop-WO invoice already exists, or (legacy)
  // an RP ticket was spawned from it. Everything else that's closed surfaces here
  // for WO-direct invoicing.
  const billedIds = await getBilledShopWorkOrderIds();

  const wos = await prisma.shopWorkOrder.findMany({
    where: { status: 'closed', isInternal: false },
    include: {
      sourceLocation: { select: { name: true } },
      intakeSite: { select: { name: true } },
      company: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      _count: { select: { items: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const uninvoiced = wos.filter(wo => !billedIds.has(wo.id));
  res.json({ data: uninvoiced.map(wo => ({ ...wo, locationName: shopBillingCardLocation(wo) })) });
});

// ============================================================
// GET /uninvoiced/tickets — List tickets in billing_queue
// ============================================================

invoicesRouter.get('/uninvoiced/tickets', async (_req: Request, res: Response) => {
  const tickets = await prisma.serviceTicket.findMany({
    where: { status: 'billing_queue', linkedRentalAgreementId: null, id: { notIn: await excludedShopTicketIds() } },
    include: {
      ...billingLocationSelect,
      company: { select: { id: true, name: true } },
      field: { select: { id: true, name: true } },
      assignedTech: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      lineItems: { select: { total: true } },
      _count: { select: { lineItems: true } },
    },
    orderBy: { serviceDate: 'desc' },
  });

  // Flatten line item totals into a ticket-level total, then strip lineItems
  const enriched = tickets.map(t => {
    const ticketTotal = t.lineItems.reduce((sum, li) => sum + (li.total ? parseFloat(li.total.toString()) : 0), 0);
    const { lineItems: _li, ...rest } = t;
    return { ...rest, locationName: billingCardLocation(t), total: ticketTotal || null };
  });

  // Group by billingGroupKey (customer + field + month) for stacked invoicing.
  // Tickets without a key fall back to grouping by companyId alone.
  interface TicketGroup {
    groupKey: string;
    company: { id: string; name: string };
    field: { id: string; name: string } | null;
    month: string | null;       // "2026-03" or null
    monthLabel: string | null;  // "March 2026" or null
    tickets: typeof enriched;
  }

  const profiles = await prisma.customerBillingProfile.findMany({ where: { companyId: { in: [...new Set(enriched.map(t => t.companyId))] }, isActive: true } });
  const grouped: Record<string, TicketGroup> = {};

  for (const t of enriched) {
    let profileKey: string;
    try { profileKey = profileForBillingWork(profiles.filter(p => p.companyId === t.companyId), t)?.id || 'default'; }
    catch { profileKey = `needs-split:${t.id}`; }
    const key = `${t.billingGroupKey || `co:${t.companyId}`}|bp:${profileKey}`;

    if (!grouped[key]) {
      // Parse month from billingGroupKey (format: "co:...|fld:...|mo:YYYY-MM")
      let month: string | null = null;
      let monthLabel: string | null = null;
      const moMatch = (t.billingGroupKey || '').match(/mo:(\d{4}-\d{2})/);
      if (moMatch) {
        month = moMatch[1];
        const [y, m] = month.split('-');
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        monthLabel = `${monthNames[parseInt(m, 10) - 1]} ${y}`;
      }

      grouped[key] = {
        groupKey: key,
        company: t.company,
        field: t.field,
        month,
        monthLabel,
        tickets: [],
      };
    }
    grouped[key].tickets.push(t);
  }

  res.json({ data: Object.values(grouped) });
});

// ============================================================
// GET /:id — Single invoice with line items
// ============================================================

invoicesRouter.get('/:id', async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    include: {
      company: {
        select: {
          id: true,
          name: true,
          taxExempt: true,
          billingProfiles: {
            where: { isActive: true },
            take: 1,
            orderBy: { effectiveFrom: 'desc' as const },
            select: {
              id: true,
              buyerDuns: true,
              buyerSiteUuid: true,
              buyerDunsPlus4: true,
              buyerCode: true,
              supplierDuns: true,
              supplierSiteDunsPlus4: true,
              defaultOrderedByName: true,
              defaultAfeNumber: true,
              defaultCostCenter: true,
              defaultPoNumber: true,
              requiresPo: true,
              requiresAfe: true,
              requiresCostCenter: true,
              requiresBuyerSite: true,
              defaultBuyerDepartment: true,
              requiresBuyerDepartment: true,
              defaultServiceApprover: true,
              defaultPriceBookNumber: true,
              defaultMajor: true,
              defaultMinor: true,
              lineFieldLabels: true,
              defaultAdditionalDataFields: true,
              enverusReceiptMode: true,
              signatureRequired: true,
              signatureApprovers: true,
            },
          },
        },
      },
      signatureRequest: {
        select: {
          id: true,
          status: true,
          sentToEmail: true,
          sentToName: true,
          sendCount: true,
          firstSentAt: true,
          lastSentAt: true,
        },
      },
      billingGroup: {
        select: {
          id: true, groupKey: true, periodStart: true, periodEnd: true,
          fieldAreaName: true,
          field: { select: { id: true, name: true } },
          tickets: {
            take: 5,
            orderBy: { serviceDate: 'desc' },
            select: {
              id: true,
              ticketNumber: true,
              locationDisplay: true,
              fieldAreaName: true,
              well: { select: { id: true, wellName: true, apiNumber: true } },
              pad: { select: { id: true, name: true } },
              field: { select: { id: true, name: true } },
            },
          },
        },
      },
      approvedBy: { select: { id: true, name: true } },
      rejectedBy: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      lineItems: {
        orderBy: { sortOrder: 'asc' },
        include: {
          product: { select: { id: true, partNumber: true, name: true, qbItemListId: true, qbItemFullName: true } },
        },
      },
    },
  });

  if (!invoice) throw new AppError(404, 'Invoice not found');

  // Enrich with location data from source tickets
  const inv = invoice as any;
  try {
    const profile = await resolveInvoiceBillingProfile(prisma, invoice);
    if (inv.company) inv.company.billingProfiles = profile ? [profile] : [];
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (inv.company) inv.company.billingProfiles = [];
    inv.billingProfileError = error.message;
  }
  const locationSummary: {
    locations: Array<{ display: string; ticketNumber?: string; wellName?: string; padName?: string; fieldName?: string; apiNumber?: string }>;
  } = { locations: [] };

  if (inv.billingGroup?.tickets?.length) {
    const seen = new Set<string>();
    for (const t of inv.billingGroup.tickets) {
      const display = t.locationDisplay || [t.field?.name, t.pad?.name, t.well?.wellName].filter(Boolean).join(' → ') || 'Unknown';
      if (!seen.has(display)) {
        seen.add(display);
        locationSummary.locations.push({
          display,
          ticketNumber: t.ticketNumber,
          wellName: t.well?.wellName || undefined,
          padName: t.pad?.name || undefined,
          fieldName: t.field?.name || t.fieldAreaName || undefined,
          apiNumber: t.well?.apiNumber || undefined,
        });
      }
    }
  } else {
    const sourceTicketIds = [...new Set(inv.lineItems?.map((li: any) => li.sourceTicketId).filter(Boolean))] as string[];
    if (sourceTicketIds.length > 0) {
      const tickets = await prisma.serviceTicket.findMany({
        where: { id: { in: sourceTicketIds } },
        select: {
          ticketNumber: true,
          locationDisplay: true,
          fieldAreaName: true,
          well: { select: { wellName: true, apiNumber: true } },
          pad: { select: { name: true } },
          field: { select: { name: true } },
        },
      });
      const seen = new Set<string>();
      for (const t of tickets) {
        const display = t.locationDisplay || [t.field?.name, t.pad?.name, t.well?.wellName].filter(Boolean).join(' → ') || 'Unknown';
        if (!seen.has(display)) {
          seen.add(display);
          locationSummary.locations.push({
            display,
            ticketNumber: t.ticketNumber,
            wellName: t.well?.wellName || undefined,
            padName: t.pad?.name || undefined,
            fieldName: t.field?.name || t.fieldAreaName || undefined,
            apiNumber: t.well?.apiNumber || undefined,
          });
        }
      }
    }

    if (inv.shopWorkOrderId) {
      const wo = await prisma.shopWorkOrder.findUnique({
        where: { id: inv.shopWorkOrderId },
        select: { workOrderNumber: true },
      });
      if (wo && locationSummary.locations.length === 0) {
        locationSummary.locations.push({ display: 'Shop / In-House', ticketNumber: wo.workOrderNumber });
      }
    }
  }

  const qbErrors = await invoiceQbErrors(prisma, [invoice]);
  res.json({ ...invoice, locationSummary, qbExportError: qbErrors.get(invoice.id) ?? null });
});

// ============================================================
// GET /:id/pdf — Download invoice as PDF
// ============================================================

invoicesRouter.get('/:id/pdf', async (req: Request, res: Response, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id as string },
      include: {
        company: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: {
            product: { select: { id: true, partNumber: true, name: true } },
          },
        },
      },
    });

    if (!invoice) throw new AppError(404, 'Invoice not found');

    const fileName = `invoice-${invoice.invoiceNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const pdfDoc = await generateInvoicePdf(invoice as any);
    pdfDoc.pipe(res);
    pdfDoc.end();
  } catch (err) {
    next(err);
  }
});

// POST /:id/pdf/store — generate invoice PDF and save to file storage
invoicesRouter.post('/:id/pdf/store', async (req: Request, res: Response, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id as string },
      include: {
        company: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        lineItems: {
          orderBy: { sortOrder: 'asc' },
          include: {
            product: { select: { id: true, partNumber: true, name: true } },
          },
        },
      },
    });

    if (!invoice) throw new AppError(404, 'Invoice not found');

    const pdfDoc = await generateInvoicePdf(invoice as any);
    const buffer = await pdfToBuffer(pdfDoc);

    const fileName = `invoice-${invoice.invoiceNumber}.pdf`;
    const store = getFileStore();
    const key = invoiceKey(invoice.id, fileName);
    await store.write(key, buffer, 'application/pdf');

    // Create or update InvoiceAttachment record
    const existing = await prisma.invoiceAttachment.findFirst({
      where: { invoiceId: invoice.id, fileType: 'document', fileName },
    });

    let attachment;
    if (existing) {
      attachment = await prisma.invoiceAttachment.update({
        where: { id: existing.id },
        data: { filePath: key, fileSizeBytes: buffer.length, uploadedAt: new Date() },
      });
    } else {
      attachment = await prisma.invoiceAttachment.create({
        data: {
          invoiceId: invoice.id,
          fileName,
          fileType: 'document',
          filePath: key,
          fileSizeBytes: buffer.length,
          mimeType: 'application/pdf',
          uploadedById: req.user!.userId,
        },
      });
    }

    res.status(201).json({
      key,
      fileName,
      size: buffer.length,
      attachmentId: attachment.id,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /generate/from-shop-wo — Generate invoice from a closed shop WO
// ============================================================

invoicesRouter.post('/generate/from-shop-wo', async (req: Request, res: Response) => {
  const { shopWorkOrderId } = req.body;
  if (!shopWorkOrderId) throw new AppError(400, 'shopWorkOrderId is required');

  const wo = await prisma.shopWorkOrder.findUnique({
    where: { id: shopWorkOrderId },
    include: {
      company: { select: { id: true, name: true, taxExempt: true, qbPriceLevelId: true } },
      intakeSite: { select: { salesTaxJurisdictionId: true, shortCode: true } },
      // Money already taken at the counter. Read here so the invoice can credit
      // it -- see the paid-at-drop credit line below.
      payments: {
        select: {
          amount: true, ccFeeAmount: true, status: true, paymentMethod: true, stripeChargeId: true,
          stripeReceiptUrl: true, cardLast4: true, cardBrand: true, createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
      items: {
        include: {
          product: { select: { id: true, partNumber: true, name: true, defaultSellPrice: true, qbItemListId: true, qbItemFullName: true } },
        },
        orderBy: { itemNumber: 'asc' },
      },
    },
  });

  if (!wo) throw new AppError(404, 'Shop work order not found');
  if (wo.status !== 'closed') throw new AppError(400, 'Shop WO must be closed before invoicing');
  if (shopBillingExcluded(wo)) throw new AppError(400, 'Internal, voided, or billing-waived work orders cannot be invoiced');

  // Check if invoice already exists for this WO
  const existing = await prisma.invoice.findFirst({
    where: { shopWorkOrderId, status: { not: 'void' } },
  });
  if (existing) throw new AppError(400, `Invoice ${existing.invoiceNumber} already exists for this work order`);

  const invoiceNumber = await generateInvoiceNumber();

  // Build line items from the WO's BILLABLE units (settled, non-warranty,
  // top-level — SCBA child components roll into their parent assembly, never
  // billed alone). buildShopBillingLines owns the four line shapes: rolled-up
  // visual-only, in-house labor+parts, vendor passthrough, and rolled-up
  // condemned inspection labor, plus structured billing.labor/misc/vendor/
  // rollup overrides. buildWoExtraLines appends the WO-level mileage/trip +
  // order-level misc lines once.
  // Arrow, not a bare reference: `.filter` passes the index as the second
  // argument, which would land in isBillableShopItem's `now` parameter and make
  // the hard-close comparison read an array index as a date.
  const billedAt = new Date();
  // Projected, not cast. toBillingItem copies the fields the derivation is
  // allowed to see and drops the rest — notably WI-09's vendorBillingNotes,
  // which must be impossible to consume in a calculation rather than merely
  // discouraged. A cast would have left the notes on the object.
  const forBilling: ShopBillingItem[] = wo.items.map(
    (it) => toBillingItem(it as unknown as Record<string, unknown>),
  );
  const billableItems = forBilling.filter((it) => isBillableShopItem(it, billedAt));

  // WI-05: a unit still inside its 48-hour soft window is deliberately not
  // billable yet. Say so, rather than letting the caller read "nothing
  // billable" as "this work order has no chargeable work on it".
  const withheld = forBilling.filter(
    (it) => !it.parentItemId && !it.isWarranty && !isBillableShopItem(it, billedAt)
      && it.hardClosesAt && it.hardClosesAt.getTime() > billedAt.getTime(),
  );
  if (billableItems.length === 0 && withheld.length > 0) {
    const soonest = withheld
      .map((it) => it.hardClosesAt!.getTime())
      .reduce((a, b) => Math.min(a, b));
    throw new AppError(
      409,
      `${withheld.length} unit(s) on this work order are still inside their 48-hour `
      + `correction window and are not billable yet. The earliest closes at `
      + `${new Date(soonest).toISOString()}.`,
    );
  }
  const { lines: charges, ruleResult } = await priceShopCharges(wo, billableItems);
  const lineItems: Array<any> = charges.map(({ serialNumber, chargeKind, total, ...line }) => line);
  if (!lineItems.length) throw new AppError(400, 'Nothing billable on this work order');
  let lineNum = lineItems.length + 1;

  if (ruleResult.appliedRules.length > 0) {
    console.log(
      `[invoices] billing rules fired for ${invoiceNumber} (shop WO ${wo.workOrderNumber}): ${ruleResult.appliedRules.join(', ')}` +
        (ruleResult.qbCustomerOverride ? ` (qb customer override → ${ruleResult.qbCustomerOverride})` : ''),
    );
  }

  // WI-08 — credit whatever was collected at the counter.
  //
  // Without this the money is taken twice: `paidAtDropExemptWorkOrderIds` only
  // keeps a FULLY-covered order off the billable list, so an order that grew
  // past its deposit came through here and billed the whole job again, deposit
  // and all. The panel had been calling that case `overage` and showing the
  // delta while the invoice it warned about still charged the lot.
  //
  // A negative line rather than an `amountPaid` column, for two reasons. The
  // reduced total explains itself on the page the customer reads, which is the
  // question anyone looking at it actually asks; and it survives the push to
  // QuickBooks unchanged, where an invoice-level paid figure would have had to
  // become a separate ReceivePayment against a receipt QB already holds.
  //
  // Apply counter payments after pricing the work performed.
  const collectedAtCounter = Math.round(collectedTotal(wo.payments) * 100) / 100;
  if (collectedAtCounter > 0) {
    lineItems.push({
      lineNumber: lineNum++,
      lineType: 'misc',
      description: attribution(wo, wo.payments) ?? `Paid at drop-off — $${collectedAtCounter.toFixed(2)}`,
      productId: null,
      partNumber: null,
      quantity: 1,
      unitOfMeasure: 'ea',
      rate: -collectedAtCounter,
      amount: -collectedAtCounter,
      // Never taxable. Tax is computed on the work performed; a payment against
      // that work is not itself a taxable sale, and marking it taxable would
      // refund tax the customer was correctly charged.
      isTaxable: false,
      sourceShopItemId: null,
      qbItemListId: null,
      qbItemFullName: null,
      sortOrder: lineNum - 1,
    });
  }

  const subtotal = lineItems.reduce((sum, li) => sum + li.amount, 0);

  // ND sales tax — shop deliverables are received at the intake shop, so use
  // that shop's configured jurisdiction (e.g. Dickinson → Stark, Williston →
  // Williston). Falls back to ND state rate if the shop has none set.
  const jurisdiction = wo.company.taxExempt
    ? null
    : (await getJurisdictionRate(wo.intakeSite?.salesTaxJurisdictionId)) ?? (await resolveJurisdictionForCounty(null));
  const taxRate = jurisdiction?.rate ?? 0;
  await applyInvoiceProductTax(prisma, lineItems, wo.company.taxExempt);
  const taxAmount = computeTaxAmount(lineItems, taxRate);

  await applyCustomerDescriptions(prisma, wo.companyId, lineItems);
  const invoice = await prisma.$transaction(async tx => {
    await assertShopBillingAllowed(tx, [wo.id]);
    const duplicate = await tx.invoice.findFirst({ where: { shopWorkOrderId: wo.id, status: { not: 'void' } } });
    if (duplicate) throw new AppError(409, 'Workorder already has an invoice');
    return tx.invoice.create({
      data: {
        invoiceNumber,
        status: 'draft',
        sourceType: 'shop_work_order',
        companyId: wo.companyId,
        companyName: wo.company.name,
        shopWorkOrderId: wo.id,
        poNumber: wo.poNumber,
        afeNumber: wo.afeNumber,
        // QB Class — shop work is always D6 (FEX); the intake shop decides
        // whether it bills on the Dickinson class. Without this the invoice
        // pushed to QB with a blank CLASS.
        division: SHOP_DIVISION,
        isDickinson: wo.intakeSite?.shortCode === DICKINSON_SITE_SHORT_CODE,
        invoiceDate: wo.completedDate || new Date(),
        subtotal,
        taxAmount,
        total: subtotal + taxAmount,
        taxJurisdictionId: jurisdiction?.id ?? null,
        taxRate,
        qbCustomerOverride: ruleResult.qbCustomerOverride,
        createdById: (req as any).user?.id || null,
        lineItems: {
          // Strip the builder's internal `lineType` (not an InvoiceLineItem column).
          create: lineItems.map(({ lineType, ...rest }) => rest),
        },
      },
      include: {
        lineItems: true,
      },
    });
  });

  await upsertDocRefAndLines(invoice.id);

  await createAuditLog({
    userId: (req as any).user?.id,
    entityType: 'invoice',
    entityId: invoice.id,
    action: 'create',
    changes: { sourceType: 'shop_work_order', shopWorkOrderId: wo.id, invoiceNumber },
    ipAddress: req.ip,
  });

  res.status(201).json(invoice);
});

// ============================================================
// POST /generate/from-tickets — Generate invoice from tickets in billing_queue
// ============================================================

invoicesRouter.post('/generate/from-tickets', async (req: Request, res: Response) => {
  const { ticketIds, companyId } = req.body;

  if (!companyId) throw new AppError(400, 'companyId is required');
  if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
    throw new AppError(400, 'ticketIds array is required');
  }

  // Verify all tickets belong to this company and are in billing_queue.
  // Location Tier 1 flags route the QB billed customer to Pale Horse
  // while SP retains the original customer and prices.
  const tickets = await prisma.serviceTicket.findMany({
    where: { id: { in: ticketIds }, companyId },
    orderBy: { id: 'asc' },
    include: {
      pad: { select: { id: true, tier1: true, county: true, wells: { select: { county: true } }, costCenter: true, facilityCode: true, buyerSiteUuid: true, buyerDepartment: true } },
      well: { select: { id: true, tier1: true, county: true, costCenter: true, facilityCode: true, buyerSiteUuid: true, buyerDepartment: true } },
      field: { select: { county: true } },
      facility: { select: { county: true } },
      lineItems: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: {
          product: { select: { id: true, partNumber: true, name: true, defaultSellPrice: true, qbItemListId: true, qbItemFullName: true } },
        },
      },
      trainingRosterRecords: {
        select: { employeeName: true, courseName: true, passed: true },
        orderBy: { employeeName: 'asc' },
      },
      ihTestRecords: {
        select: { id: true, testType: true, testData: true, locationPoint: true },
        orderBy: { testedAt: 'asc' },
      },
      gasDetectionRecords: {
        select: { id: true, monitorMake: true, monitorModel: true, monitorSerial: true, subtype: true, testResult: true, sensorReplaced: true, workPerformed: true, notes: true },
        orderBy: { createdAt: 'asc' },
      },
      fitTestRecords: {
        select: { id: true, employeeName: true, employerName: true, passFail: true, respiratorMake: true, respiratorModel: true, respiratorSize: true, includesFitTest: true, includesAudiometric: true, audiometricResult: true },
        orderBy: { employeeName: 'asc' },
      },
    },
  });

  for (const ticket of tickets) {
    const error = inspectionBillingError(ticket, ticket.lineItems.length);
    if (error) throw new AppError(400, `${ticket.ticketNumber}: ${error}`);
  }

  // Look up the fit test product for billing (QB part #11009)
  const fitTestPartNumber = getDefaultPartNumber('training', 'fit_test', 'fit_test') || '11009';
  const fitTestProduct = await prisma.product.findFirst({
    where: { partNumber: fitTestPartNumber },
    select: { id: true, partNumber: true, name: true, defaultSellPrice: true, qbItemListId: true, qbItemFullName: true },
  });

  // #11 Audiometric (Occ Health) — part 12104 "Sound Detection" per person
  const audiometricProduct = await prisma.product.findFirst({
    where: { partNumber: '12104' },
    select: { id: true, partNumber: true, name: true, defaultSellPrice: true, qbItemListId: true, qbItemFullName: true },
  });

  // #10/#12 On-site mileage (Occ Health + Training), per mile. Mileage follows
  // the work's own division — occ health bills 0800001, training 0100001 —
  // rather than everything landing on the old flat 101.
  const batchDivision = tickets[0]?.division ?? defaultDivisionForWork(tickets[0] ?? {});
  const mileageProduct = await getMileageProduct(batchDivision);

  // Universal call-out fee (part 148). One line emitted per ticket flagged via customData.isCallOut.
  const calloutProduct = await prisma.product.findFirst({
    where: { partNumber: '148' },
    select: { id: true, partNumber: true, name: true, defaultSellPrice: true, qbItemListId: true, qbItemFullName: true },
  });

  const notBillingQueue = tickets.filter(t => t.status !== 'billing_queue');
  if (notBillingQueue.length > 0) {
    throw new AppError(400, `Tickets not in billing_queue: ${notBillingQueue.map(t => t.ticketNumber).join(', ')}`);
  }

  if (tickets.length !== ticketIds.length) {
    throw new AppError(400, 'Some tickets not found or do not belong to this company');
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, taxExempt: true },
  });
  if (!company) throw new AppError(404, 'Company not found');
  const approvalProfiles = await prisma.customerBillingProfile.findMany({ where: { companyId, isActive: true } });
  const invoiceNumber = 'ticket billing batch';

  // Build line items from all tickets
  const lineItems: Array<any> = [];
  let lineNum = 1;

  for (const ticket of tickets) {
    for (const li of ticket.lineItems) {
      const qty = parseFloat(li.quantity.toString());
      const capturedRate = li.rate ? parseFloat(li.rate.toString()) : 0;
      const productPrice = li.product?.defaultSellPrice != null
        ? parseFloat(li.product.defaultSellPrice.toString())
        : null;

      // Never strip pricing between ticket and billing. A line can reach the
      // queue with a 0/null rate — e.g. the product synced to the iPad before
      // AR set its sell price, so the wizard captured null (defaultLineItems.ts).
      // When the captured rate is missing or zero, fall back to the product's
      // current sell price so the price the customer should see actually lands
      // on the invoice. A real, non-zero rate the rep entered is left untouched.
      const rate = capturedRate > 0 ? capturedRate : (productPrice ?? capturedRate);
      const amount = capturedRate > 0 && li.total
        ? parseFloat(li.total.toString())
        : rate * qty;

      lineItems.push({
        lineNumber: lineNum++,
        description: li.description || `${li.lineType} — ${ticket.ticketNumber}`,
        productId: li.productId,
        partNumber: li.partNumber || li.product?.partNumber || null,
        quantity: qty,
        unitOfMeasure: li.unitOfMeasure || 'EA',
        rate,
        amount,
        isTaxable: company.taxExempt ? false : defaultTaxableForLineType(li.lineType),
        sourceTicketLineItemId: li.id,
        sourceTicketId: ticket.id,
        sourceTicketNumber: ticket.ticketNumber,
        qbItemListId: li.product?.qbItemListId || null,
        qbItemFullName: li.product?.qbItemFullName || null,
        sortOrder: lineNum - 1,
        notes: li.notes || null,
      });
    }

    // Universal call-out fee (part 148) — one line per callout-flagged ticket
    if ((ticket.customData as any)?.isCallOut === true && !ticket.lineItems.some(line => line.partNumber === '148')) {
      const rate = calloutProduct?.defaultSellPrice
        ? parseFloat(calloutProduct.defaultSellPrice.toString())
        : 150;
      lineItems.push({
        lineNumber: lineNum++,
        description: calloutProduct?.name || 'Emergency Call out Fee',
        productId: calloutProduct?.id || null,
        partNumber: calloutProduct?.partNumber || '148',
        quantity: 1,
        unitOfMeasure: 'EA',
        rate,
        amount: rate,
        isTaxable: false,
        sourceTicketId: ticket.id,
        sourceTicketNumber: ticket.ticketNumber,
        qbItemListId: calloutProduct?.qbItemListId || null,
        qbItemFullName: calloutProduct?.qbItemFullName || null,
        sortOrder: lineNum - 1,
      });
    }

    // Training roster: append a $0 notes line listing the trainees
    if (ticket.trainingRosterRecords && ticket.trainingRosterRecords.length > 0) {
      const names = ticket.trainingRosterRecords.map(r => r.employeeName).join(', ');
      const course = ticket.trainingRosterRecords[0]?.courseName || 'Training';
      lineItems.push({
        lineNumber: lineNum++,
        description: `Attendees (${ticket.trainingRosterRecords.length}): ${names}`,
        productId: null,
        partNumber: null,
        quantity: 0,
        unitOfMeasure: 'EA',
        rate: 0,
        amount: 0,
        isTaxable: false,
        sourceTicketId: ticket.id,
        sourceTicketNumber: ticket.ticketNumber,
        qbItemListId: null,
        qbItemFullName: null,
        sortOrder: lineNum - 1,
        notes: `${course} — ${ticket.ticketNumber}`,
      });
    }

    // Occ Health roster: consolidated billable line(s) + attendee notes line.
    // Each person can take Fit Test, Audiometric, or both — bill each service
    // for the people who took it. (Legacy rows have no flags = pure fit test.)
    if (ticket.fitTestRecords && ticket.fitTestRecords.length > 0) {
      const ftRecs = ticket.fitTestRecords.filter(r => (r as any).includesFitTest !== false);
      const audRecs = ticket.fitTestRecords.filter(r => (r as any).includesAudiometric === true);

      if (ftRecs.length > 0) {
        const fitTestRate = fitTestProduct?.defaultSellPrice
          ? parseFloat(fitTestProduct.defaultSellPrice.toString())
          : 35; // fallback $35 per person if product has no price set
        lineItems.push({
          lineNumber: lineNum++,
          description: fitTestProduct?.name || 'Fit Test',
          productId: fitTestProduct?.id || null,
          partNumber: fitTestProduct?.partNumber || fitTestPartNumber,
          quantity: ftRecs.length,
          unitOfMeasure: 'EA',
          rate: fitTestRate,
          amount: fitTestRate * ftRecs.length,
          isTaxable: false,
          sourceTicketId: ticket.id,
          sourceTicketNumber: ticket.ticketNumber,
          qbItemListId: fitTestProduct?.qbItemListId || null,
          qbItemFullName: fitTestProduct?.qbItemFullName || null,
          sortOrder: lineNum - 1,
        });
      }

      // #11 Audiometric — part 12104 per person tested
      if (audRecs.length > 0) {
        const audRate = audiometricProduct?.defaultSellPrice
          ? parseFloat(audiometricProduct.defaultSellPrice.toString())
          : 100; // fallback when no product row exists
        lineItems.push({
          lineNumber: lineNum++,
          description: audiometricProduct?.name || 'Audiometric Testing',
          productId: audiometricProduct?.id || null,
          partNumber: audiometricProduct?.partNumber || '12104',
          quantity: audRecs.length,
          unitOfMeasure: 'EA',
          rate: audRate,
          amount: audRate * audRecs.length,
          isTaxable: false,
          sourceTicketId: ticket.id,
          sourceTicketNumber: ticket.ticketNumber,
          qbItemListId: audiometricProduct?.qbItemListId || null,
          qbItemFullName: audiometricProduct?.qbItemFullName || null,
          sortOrder: lineNum - 1,
        });
      }

      // $0 notes — Attendees list (services tagged per person)
      const names = ticket.fitTestRecords.map(r => {
        const svc = [
          (r as any).includesFitTest !== false ? 'FT' : null,
          (r as any).includesAudiometric === true ? 'Audio' : null,
        ].filter(Boolean).join('+');
        return `${r.employeeName}${svc && svc !== 'FT' ? ` (${svc})` : ''}`;
      }).join(', ');
      lineItems.push({
        lineNumber: lineNum++,
        description: `Attendees (${ticket.fitTestRecords.length}): ${names}`,
        productId: null,
        partNumber: null,
        quantity: 0,
        unitOfMeasure: 'EA',
        rate: 0,
        amount: 0,
        isTaxable: false,
        sourceTicketId: ticket.id,
        sourceTicketNumber: ticket.ticketNumber,
        qbItemListId: null,
        qbItemFullName: null,
        sortOrder: lineNum - 1,
        notes: `Occ Health - ${ticket.ticketNumber}`,
      });
    }

    // #10/#12 On-site mileage for Occ Health + Training visits
    if (ticket.ticketType === 'training') {
      const miles = Number((ticket.customData as any)?.mileage) || 0;
      if (miles > 0) {
        const mileageRate = mileageProduct?.defaultSellPrice
          ? parseFloat(mileageProduct.defaultSellPrice.toString())
          : 0;
        lineItems.push({
          lineNumber: lineNum++,
          description: `${mileageProduct?.name || 'Mileage'} — on-site visit`,
          productId: mileageProduct?.id || null,
          partNumber: mileageProduct?.partNumber || null,
          quantity: miles,
          unitOfMeasure: 'MI',
          rate: mileageRate,
          amount: Math.round(miles * mileageRate * 100) / 100,
          isTaxable: false,
          sourceTicketId: ticket.id,
          sourceTicketNumber: ticket.ticketNumber,
          qbItemListId: mileageProduct?.qbItemListId || null,
          qbItemFullName: mileageProduct?.qbItemFullName || null,
          sortOrder: lineNum - 1,
        });
      }
    }

    // IH test records carry NO automated pricing. Billing comes solely from the
    // ticket's manually-added line items (copied above). Test records remain
    // attached to the ticket for the field record / PDF, but they do not
    // synthesize invoice lines.

    // Gas detection records (Phase B): one billing line per monitor.
    // Pricing comes from a per-subtype default product if one is set up;
    // otherwise the line lands at $0 for the back-office to price during review.
    if (ticket.gasDetectionRecords && ticket.gasDetectionRecords.length > 0) {
      const subtypeLabel: Record<string, string> = {
        bump: 'Bump Test',
        calibration: 'Calibration',
        sensor_replacement: 'Sensor Replacement',
        other_repair: 'Repair',
      };
      for (const gd of ticket.gasDetectionRecords) {
        const monitorIdent = [gd.monitorMake, gd.monitorModel].filter(Boolean).join(' ').trim();
        const lineDescParts = [
          subtypeLabel[gd.subtype] || gd.subtype,
          monitorIdent || null,
          gd.monitorSerial ? `S/N: ${gd.monitorSerial}` : null,
          gd.testResult ? gd.testResult.toUpperCase() : null,
          gd.subtype === 'sensor_replacement' && gd.sensorReplaced ? `sensor: ${gd.sensorReplaced}` : null,
        ].filter(Boolean);
        const description = lineDescParts.join(' — ');

        lineItems.push({
          lineNumber: lineNum++,
          description,
          productId: null,
          partNumber: null,
          quantity: 1,
          unitOfMeasure: 'EA',
          rate: 0,
          amount: 0,
          isTaxable: false,
          sourceTicketId: ticket.id,
          sourceTicketNumber: ticket.ticketNumber,
          qbItemListId: null,
          qbItemFullName: null,
          sortOrder: lineNum - 1,
          notes: gd.notes || (gd.subtype === 'other_repair' && gd.workPerformed) || null,
        });
      }
    }
  }

  const emptyTickets = tickets.filter(ticket => !lineItems.some(line => line.sourceTicketId === ticket.id));
  if (emptyTickets.length) {
    throw new AppError(400, `No invoice lines for ${emptyTickets.map(ticket => ticket.ticketNumber).join(', ')}. Check ticket sync before invoicing.`);
  }

  // Wave 5C: pre-fetch the Price Level admin-assigned to this customer
  // (Company.qbPriceLevelId — option B). The resolver applies per-line rate
  // adjustments without a DB call. If no price level is assigned, the
  // lookup yields nothing and pricing falls back to existing rates.
  const companyForPL = await prisma.company.findUnique({
    where: { id: companyId },
    select: { qbPriceLevelId: true },
  });
  const priceLevelRows = companyForPL?.qbPriceLevelId
    ? await prisma.priceLevel.findMany({
        where: { id: companyForPL.qbPriceLevelId, isActive: true },
        include: { items: true },
      })
    : [];

  // Run the billing-rules resolver. Returns line adjustments (5C Price
  // Levels), any extra lines, and the Tier 1 QB customer override.
  const ruleResult = resolveInvoiceRules({
    invoiceCompanyId: companyId,
    invoiceCompanyName: company.name,
    tickets: tickets.map(t => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      pad: t.pad ? { id: t.pad.id, tier1: t.pad.tier1 } : null,
      // Well-level Tier 1 matters more than pad-level here: reservation
      // tickets are nearly always booked straight to a pad-less well.
      well: t.well ? { id: t.well.id, tier1: t.well.tier1 } : null,
    })),
    lineItems: lineItems.map(li => ({
      qbItemListId: li.qbItemListId,
      partNumber: li.partNumber,
      rate: li.rate,
      quantity: li.quantity,
      amount: li.amount,
      qbSkip: false,
    })),
    priceLevels: priceLevelRows.map(pl => ({
      id: pl.id,
      name: pl.name,
      items: pl.items.map(it => ({
        qbItemListId: it.qbItemListId,
        customPrice: it.customPrice ? parseFloat(it.customPrice.toString()) : null,
        adjustPercent: it.adjustPercent ? parseFloat(it.adjustPercent.toString()) : null,
      })),
    })),
  });

  // Apply Price Level rate/amount adjustments to the existing line items.
  for (const adj of ruleResult.lineAdjustments) {
    const li = lineItems[adj.index];
    if (!li) continue;
    li.rate = adj.newRate;
    li.amount = adj.newAmount;
    const existingNotes = li.notes ? `${li.notes} · ` : '';
    li.notes = `${existingNotes}${adj.source}`;
  }

  // Append rule-generated extras with the next sortOrder values
  for (const extra of ruleResult.extraLines) {
    lineItems.push({
      lineNumber: lineNum++,
      description: extra.description,
      productId: extra.productId,
      partNumber: extra.partNumber,
      quantity: extra.quantity,
      unitOfMeasure: extra.unitOfMeasure,
      rate: extra.rate,
      amount: extra.amount,
      isTaxable: extra.isTaxable,
      sourceTicketId: extra.sourceTicketId,
      sourceTicketNumber: extra.sourceTicketNumber,
      qbItemListId: extra.qbItemListId,
      qbItemFullName: extra.qbItemFullName,
      qbSkip: extra.qbSkip,
      sortOrder: lineNum - 1,
      notes: extra.notes,
    });
  }

  const subtotal = lineItems.reduce((sum: number, li: any) => sum + li.amount, 0);

  // ND sales tax — per-item, destination-based. Auto-pick the jurisdiction from
  // the service location's county (most-specific of well/pad/field/facility).
  const taxCounty = tickets.map(countyFromTicketLocations).find(Boolean) ?? null;
  const jurisdiction = company.taxExempt ? null : await resolveJurisdictionForCounty(taxCounty);
  const taxRate = jurisdiction?.rate ?? 0;
  await applyInvoiceProductTax(prisma, lineItems, company.taxExempt);
  const taxAmount = computeTaxAmount(lineItems, taxRate);

  if (ruleResult.appliedRules.length > 0) {
    console.log(
      `[invoices] billing rules fired for ${invoiceNumber}: ${ruleResult.appliedRules.join(', ')}` +
        (ruleResult.lineAdjustments.length > 0
          ? ` (${ruleResult.lineAdjustments.length} line${ruleResult.lineAdjustments.length === 1 ? '' : 's'} re-priced)`
          : '') +
        (ruleResult.qbCustomerOverride ? ` (qb customer override → ${ruleResult.qbCustomerOverride})` : ''),
    );
  }

  // Date range from tickets
  const serviceDates = tickets.map(t => new Date(t.serviceDate)).sort((a, b) => a.getTime() - b.getTime());

  // Division (QB Class) — one invoice = one class. Take from first ticket;
  // warn if batch mixes divisions so ops can investigate.
  const divisions = new Set(tickets.map(t => `${t.division ?? ''}:${t.isDickinson}`));
  if (divisions.size > 1) {
    console.warn(`[invoices] mixed divisions in billing batch for ${company.name}: ${Array.from(divisions).join(', ')} — using ticket[0]`);
  }

  // Shop-sourced (RP) tickets carry their parent SW#/id in customData. Surface
  // the SW# clearly on the invoice (notes) and link it back to the WO when the
  // batch is all one WO, so AR can cross-reference in either direction.
  const shopWoNumbers = [...new Set(
    tickets.map(t => (t.customData as any)?.shopWorkOrderNumber).filter((n: unknown): n is string => typeof n === 'string'),
  )];
  const shopWoIds = [...new Set(
    tickets.map(t => (t.customData as any)?.shopWorkOrderId).filter((n: unknown): n is string => typeof n === 'string'),
  )];

  await applyCustomerDescriptions(prisma, companyId, lineItems);
  const approvalTickets = invoiceApprovalTickets(approvalProfiles, tickets);
  const approvalPlan = billingApprovalPlan(approvalProfiles, approvalTickets, lineItems);
  if (req.body.preview === true) {
    res.json({ approvalPlan, subtotal, taxAmount, total: subtotal + taxAmount });
    return;
  }
  const partitions = splitBillingApprovals(approvalProfiles, approvalTickets, lineItems,
    approvedInvoiceAllocations(approvalProfiles, tickets, lineItems), approvalPlan.version);
  const invoices = await prisma.$transaction(async tx => {
    await assertShopBillingAllowed(tx, shopWoIds);
    // Serialize competing billing attempts; all split invoices commit together.
    await tx.$queryRaw`SELECT id FROM service_tickets WHERE id = ANY(${ticketIds}::text[]) ORDER BY id FOR UPDATE`;
    const current = await tx.serviceTicket.count({ where: { id: { in: ticketIds }, status: 'billing_queue' } });
    if (current !== ticketIds.length) throw new AppError(409, 'Source tickets are no longer ready to bill');
    const snapshots = await tx.serviceTicket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, updatedAt: true } });
    if (snapshots.some(snapshot => +snapshot.updatedAt !== +tickets.find(ticket => ticket.id === snapshot.id)!.updatedAt))
      throw new AppError(409, 'Source ticket changed. Refresh billing before generating invoices.');
    await assertTicketsNotOnLiveInvoice(tx, ticketIds);
    const created = [];
    for (const partition of partitions) {
      const sourceIds = new Set(partition.lines.map(line => line.sourceTicketId).filter(Boolean));
      const sourceTickets = tickets.filter(ticket => sourceIds.has(ticket.id));
      const source = sourceTickets[0] || tickets[0];
      const dates = (sourceTickets.length ? sourceTickets : tickets).map(t => new Date(t.serviceDate)).sort((a, b) => +a - +b);
      const partSubtotal = partition.lines.reduce((sum, line) => sum + Number(line.amount), 0);
      const partTax = computeTaxAmount(partition.lines, taxRate);
      const codes = invoiceBillingCodes(approvalProfiles.find(p => p.id === partition.billingProfileId),
        sourceTickets.length ? sourceTickets : tickets);
      created.push(await tx.invoice.create({
        data: {
          invoiceNumber: await generateInvoiceNumber(), status: 'draft', sourceType: 'billing_group',
          billingProfileId: partition.billingProfileId,
          companyId, companyName: company.name, poNumber: [...new Set(sourceTickets.map(ticket => ticket.poNumber?.trim()).filter(Boolean))].join(', ') || source.poNumber, afeNumber: codes.afeNumber ?? source.afeNumber,
          costCenter: codes.costCenter,
          buyerSiteUuid: codes.buyerSiteUuid, buyerDepartment: codes.buyerDepartment,
          division: source.division ?? defaultDivisionForWork(source), isDickinson: source.isDickinson,
          shopWorkOrderId: shopWoIds.length === 1 ? shopWoIds[0] : null,
          notes: shopWoNumbers.length ? `Shop WO: ${shopWoNumbers.join(', ')}` : null,
          invoiceDate: dates[dates.length - 1], periodStart: dates[0], periodEnd: dates[dates.length - 1],
          subtotal: partSubtotal, taxAmount: partTax, total: partSubtotal + partTax,
          taxJurisdictionId: jurisdiction?.id ?? null, taxRate, qbCustomerOverride: ruleResult.qbCustomerOverride,
          createdById: (req as any).user?.id || null,
          lineItems: { create: partition.lines },
        }, include: { lineItems: true },
      }));
    }
    await tx.serviceTicket.updateMany({ where: { id: { in: ticketIds } }, data: { status: 'invoiced' } });
    return created;
  }, { timeout: 30000 });
  for (const invoice of invoices) {
    await upsertDocRefAndLines(invoice.id);
    await createAuditLog({ userId: (req as any).user?.id, entityType: 'invoice', entityId: invoice.id,
      action: 'create', changes: { sourceType: 'billing_group', invoiceNumber: invoice.invoiceNumber,
        billingProfileId: invoice.billingProfileId, approvalSplit: invoices.length > 1, sourceTicketIds: ticketIds }, ipAddress: req.ip });
  }
  res.status(201).json(invoices.length === 1 ? invoices[0] : { invoices, split: true });
});

// ============================================================
// GET /uninvoiced/training-tickets — Training tickets ready for invoicing
// ============================================================

invoicesRouter.get('/uninvoiced/training-tickets', async (req: Request, res: Response) => {
  // Find training tickets in billing_queue that have roster records
  const tickets = await prisma.serviceTicket.findMany({
    where: {
      status: 'billing_queue',
      ticketType: 'training',
      trainingRosterRecords: { some: {} },
    },
    include: {
      ...billingLocationSelect,
      trainingRosterRecords: {
        select: {
          id: true,
          employeeName: true,
          employerName: true,
          employerCompanyId: true,
          courseName: true,
          passed: true,
        },
        orderBy: { employeeName: 'asc' },
      },
      company: { select: { id: true, name: true } },
      assignedTech: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
    },
    orderBy: { serviceDate: 'desc' },
  });

  // Shape each ticket with employer breakdown
  const result = tickets.map(t => {
    // Group roster by employer
    const byEmployer: Record<string, {
      employerName: string;
      employerCompanyId: string | null;
      count: number;
      passedCount: number;
      names: string[];
    }> = {};

    for (const r of t.trainingRosterRecords) {
      const key = r.employerCompanyId || r.employerName || '_unspecified';
      if (!byEmployer[key]) {
        byEmployer[key] = {
          employerName: r.employerName || 'Unspecified',
          employerCompanyId: r.employerCompanyId,
          count: 0,
          passedCount: 0,
          names: [],
        };
      }
      byEmployer[key].count++;
      if (r.passed) byEmployer[key].passedCount++;
      byEmployer[key].names.push(r.employeeName);
    }

    return {
      ticketId: t.id,
      ticketNumber: t.ticketNumber,
      serviceDate: t.serviceDate,
      courseName: t.trainingRosterRecords[0]?.courseName || 'Unknown',
      bookingCompany: t.company?.name || 'Unknown',
      locationName: billingCardLocation(t),
      bookingCompanyId: t.company?.id || null,
      billingBasis: trainingBillingBasis(t.trainingRosterRecords[0]?.courseName || ''),
      rosterCount: t.trainingRosterRecords.length,
      technicianName: t.assignedTech?.name || null,
      createdByName: t.createdBy?.name || null,
      employers: Object.values(byEmployer),
    };
  });

  res.json({ data: result });
});

// ============================================================
// POST /generate/from-training-ticket — Per-employer training invoices
// ============================================================

invoicesRouter.post('/generate/from-training-ticket', async (req: Request, res: Response) => {
  const { ticketId } = req.body;
  if (!ticketId) throw new AppError(400, 'ticketId is required');

  const batch = await prisma.$transaction(async tx => {
    // Serialize all employers as one billing operation, including retries.
    await tx.$queryRaw(Prisma.sql`SELECT id FROM service_tickets WHERE id = ${ticketId} FOR UPDATE`);
    const ticket = await tx.serviceTicket.findUnique({
      where: { id: ticketId },
      include: {
        trainingRosterRecords: {
          select: {
            id: true,
            employeeName: true,
            employerName: true,
            employerCompanyId: true,
            courseName: true,
            passed: true,
          },
          orderBy: { employeeName: 'asc' },
        },
        company: { select: { id: true, name: true } },
      },
    });

    if (!ticket) throw new AppError(404, 'Ticket not found');
    if (ticket.ticketType !== 'training') throw new AppError(400, 'This operation requires a training ticket');
    const existing = await tx.invoice.findMany({
      where: { status: { not: 'void' }, lineItems: { some: { sourceTicketId: ticketId } } },
      include: { lineItems: true },
      orderBy: { invoiceNumber: 'asc' },
    });
    if (ticket.status === 'invoiced' && existing.length) {
      return { created: false, invoices: existing, ticket, courseName: ticket.trainingRosterRecords[0]?.courseName || 'other' };
    }
    if (existing.length) throw new AppError(409, 'This class has existing invoices — review or void them before regenerating');
    if (ticket.status !== 'billing_queue') {
      throw new AppError(400, `Ticket ${ticket.ticketNumber} is not in billing_queue (current: ${ticket.status})`);
    }
    if (!ticket.trainingRosterRecords.length) {
      throw new AppError(400, `Ticket ${ticket.ticketNumber} has no roster records`);
    }

    // Group roster by employer
    const byEmployer: Record<string, {
      employerName: string;
      employerCompanyId: string | null;
      records: typeof ticket.trainingRosterRecords;
    }> = {};

    for (const r of ticket.trainingRosterRecords) {
      const key = r.employerCompanyId || r.employerName || '_booking_company';
      if (!byEmployer[key]) {
        byEmployer[key] = {
          employerName: r.employerName || ticket.company?.name || 'Unknown',
          employerCompanyId: r.employerCompanyId,
          records: [],
        };
      }
      byEmployer[key].records.push(r);
    }

    const courseName = ticket.trainingRosterRecords[0]?.courseName || 'other';
    const courseProduct = await getProductForCourse(courseName);
    const courseLabel = getCourseLabel(courseName);

    const perClass = courseProduct.billingBasis === 'per_class';
    const billingCompanyId = req.body.billingCompanyId;
    if (perClass) {
      const eligible = new Set([ticket.company?.id, ...ticket.trainingRosterRecords.map(r => r.employerCompanyId)].filter(Boolean));
      if (typeof billingCompanyId !== 'string' || !eligible.has(billingCompanyId)) throw new AppError(400, 'Select the customer paying the class fee from the booking customer or roster employers');
      const payer = await tx.company.findUnique({ where: { id: billingCompanyId }, select: { id: true, name: true } });
      if (!payer) throw new AppError(400, 'The selected class billing customer was not found');
      if (!byEmployer[payer.id]) byEmployer[payer.id] = { employerName: payer.name, employerCompanyId: payer.id, records: [] };
    }

    // Look up Misc product for the $0 attendees line
    const miscProduct = await tx.product.findFirst({
      where: { partNumber: 'Misc' },
      select: { id: true, partNumber: true, qbItemFullName: true, qbItemListId: true },
    });

    const createdInvoices: any[] = [];

    for (const group of Object.values(byEmployer)) {
      const passedRecords = group.records.filter(r => r.passed);
      const passedCount = passedRecords.length;
      const allNames = group.records.map(r => r.employeeName);
      const passedNames = passedRecords.map(r => r.employeeName);

      // Determine billing company
      let companyId: string | null = null;
      let companyName = group.employerName;
      if (group.employerCompanyId) {
        const employer = await tx.company.findUnique({
          where: { id: group.employerCompanyId },
          select: { id: true, name: true },
        });
        if (employer) {
          companyId = employer.id;
          companyName = employer.name;
        }
      }

      const invoiceNumber = await generateInvoiceNumber();
      const lineItems: any[] = [];
      let lineNum = 1;

      // A class fee is charged once to the designated payer, regardless of
      // attendance count. Seat-priced courses continue to bill passed students.
      const billableQuantity = perClass ? (companyId === billingCompanyId ? 1 : 0) : passedCount;
      if (billableQuantity > 0 && courseProduct.price > 0) {
        const amount = Math.round(billableQuantity * courseProduct.price * 100) / 100;
        lineItems.push({
          lineNumber: lineNum++,
          description: perClass ? `${courseLabel} — class fee` : courseLabel,
          productId: courseProduct.productId,
          partNumber: courseProduct.partNumber,
          quantity: billableQuantity,
          unitOfMeasure: perClass ? 'CLASS' : 'EA',
          rate: courseProduct.price,
          amount,
          isTaxable: false,
          sourceTicketId: ticket.id,
          sourceTicketNumber: ticket.ticketNumber,
          qbItemListId: courseProduct.qbItemListId,
          qbItemFullName: courseProduct.qbItemFullName,
          sortOrder: lineNum - 1,
        });
      }

      // Line 2: $0 notes — attendee names
      lineItems.push({
        lineNumber: lineNum++,
        description: `Attendees (${allNames.length}): ${allNames.join(', ')}`,
        productId: miscProduct?.id || null,
        partNumber: miscProduct?.partNumber || 'Misc',
        quantity: 0,
        unitOfMeasure: 'EA',
        rate: 0,
        amount: 0,
        isTaxable: false,
        sourceTicketId: ticket.id,
        sourceTicketNumber: ticket.ticketNumber,
        qbItemListId: miscProduct?.qbItemListId || null,
        qbItemFullName: miscProduct?.qbItemFullName || null,
        sortOrder: lineNum - 1,
        notes: `${courseLabel} — ${ticket.ticketNumber}`,
      });

      const subtotal = lineItems.reduce((sum: number, li: any) => sum + li.amount, 0);

      await applyCustomerDescriptions(tx, companyId, lineItems);
      const invoiceData: any = {
        invoiceNumber,
        status: 'draft',
        sourceType: 'billing_group',
        companyName,
        division: ticket.division ?? defaultDivisionForWork(ticket),
        isDickinson: ticket.isDickinson,
        invoiceDate: ticket.serviceDate,
        periodStart: ticket.serviceDate,
        periodEnd: ticket.serviceDate,
        subtotal,
        taxAmount: 0,
        total: subtotal,
        createdById: req.user?.userId || null,
        lineItems: { create: lineItems },
      };
      if (companyId) invoiceData.companyId = companyId;

      const invoice = await tx.invoice.create({
        data: invoiceData,
        include: { lineItems: true },
      });

      createdInvoices.push(invoice);
    }

    // Move ticket to 'invoiced' status
    await tx.serviceTicket.update({
      where: { id: ticketId },
      data: { status: 'invoiced' },
    });

    return { created: true, invoices: createdInvoices, ticket, courseName };
  }, { maxWait: 10000, timeout: 30000 });
  const { invoices: createdInvoices, ticket, courseName } = batch;
  // Idempotent projections can be retried after commit without billing twice.
  await Promise.all(createdInvoices.map((inv) => upsertDocRefAndLines(inv.id)));
  if (batch.created) await createAuditLog({
    userId: req.user?.userId,
    entityType: 'invoice',
    entityId: createdInvoices[0]?.id || ticketId,
    action: 'create',
    changes: {
      sourceType: 'training',
      ticketNumber: ticket.ticketNumber,
      courseName,
      invoiceCount: createdInvoices.length,
      invoiceNumbers: createdInvoices.map(i => i.invoiceNumber),
    },
    ipAddress: req.ip,
  });

  res.status(batch.created ? 201 : 200).json({
    invoices: createdInvoices,
    count: createdInvoices.length,
  });
});

// ============================================================
// POST /generate/from-rental — Generate invoice from a rental agreement
// ============================================================

/** Today as a UTC-midnight instant, matching how the date-only columns
 * (deployedDate, returnedDate, periodStart/End) read back out of Postgres.
 * Used to stop the clock on gear that is still out: a rental deployed today
 * and billed against the August period should charge one day, not every day
 * left on the calendar. */
function billableThroughToday(): Date {
  return rentalToday();
}

function formatRentalDeployedItem(item: {
  product?: { name?: string | null; category?: string | null } | null;
  serializedEquipment?: { serialNumber?: string | null; safeCoreSerial?: string | null } | null;
}): string | null {
  const name = item.product?.name?.trim() || 'Equipment';
  const category = item.product?.category || '';
  const serial = item.serializedEquipment?.serialNumber?.trim() || '';
  const safeCore = item.serializedEquipment?.safeCoreSerial?.trim() || '';
  const serialLabel = serial && safeCore && serial !== safeCore
    ? `${serial} / SafeCore #${safeCore}`
    : (serial || safeCore);
  if (!serialLabel) return null;

  if (category === 'air_trailer' || /trailer/i.test(name)) {
    return `Trailer #${serialLabel.replace(/^#/, '')}`;
  }
  return `${name} #${serialLabel.replace(/^#/, '')}`;
}

function rentalDeployedItemsDetail(
  items: Array<{
    deployedDate: Date;
    returnedDate: Date | null;
    product?: { name?: string | null; category?: string | null } | null;
    serializedEquipment?: { serialNumber?: string | null; safeCoreSerial?: string | null } | null;
  }>,
  periodStart: Date,
  periodEnd: Date,
): string | null {
  const listed = items
    .filter(item => {
      const out = new Date(item.deployedDate);
      const back = item.returnedDate ? new Date(item.returnedDate) : null;
      return out <= periodEnd && (!back || back >= periodStart);
    })
    .map(formatRentalDeployedItem)
    .filter((s): s is string => !!s)
    .sort((a, b) => a.localeCompare(b));

  return listed.length ? `Items deployed:\n${listed.map(s => `- ${s}`).join('\n')}` : null;
}

invoicesRouter.post('/generate/from-rental', async (req: Request, res: Response) => {
  const { rentalAgreementId, periodStart, periodEnd } = req.body;
  const previewOnly = req.body.preview === true;
  if (!rentalAgreementId) throw new AppError(400, 'rentalAgreementId is required');
  if (!periodStart || !periodEnd) throw new AppError(400, 'periodStart and periodEnd are required');

  const pStart = rentalDate(periodStart, 'periodStart');
  let pEnd = rentalDate(periodEnd, 'periodEnd');
  if (!Number.isFinite(pStart.getTime()) || !Number.isFinite(pEnd.getTime())) throw new AppError(400, 'Invalid billing period');
  if (pEnd < pStart) throw new AppError(400, 'periodEnd must be on or after periodStart');

  const result = await prisma.$transaction(async (tx) => {
  await lockRental(tx, rentalAgreementId);
  const rental = await tx.rentalAgreement.findUnique({
    where: { id: rentalAgreementId },
    include: {
      company: { select: { id: true, name: true, taxExempt: true } },
      pad: { select: { county: true, wells: { select: { county: true } }, costCenter: true, facilityCode: true, buyerSiteUuid: true, buyerDepartment: true } },
      well: { select: { county: true, costCenter: true, facilityCode: true, buyerSiteUuid: true, buyerDepartment: true } },
      field: { select: { county: true } },
      facility: { select: { county: true } },
      items: {
        include: {
          product: {
            select: { id: true, partNumber: true, name: true, category: true, defaultRentalRateDaily: true, defaultRentalRateWeekly: true, defaultRentalRateMonthly: true, qbItemListId: true, qbItemFullName: true },
          },
          serializedEquipment: { select: { serialNumber: true, safeCoreSerial: true } },
        },
      },
    },
  });

  if (!rental) throw new AppError(404, 'Rental agreement not found');
  if (!['active', 'completed'].includes(rental.status)) throw new AppError(400, 'Rental agreement is not active or completed');
  const cutoff = rental.status === 'completed' && rental.endDate && rental.endDate < rentalToday() ? rental.endDate : rentalToday();
  if (rental.status === 'completed') pEnd = cutoff;
  else if (pEnd > cutoff) pEnd = cutoff;
  if (pStart > pEnd) throw new AppError(400, 'No billable items in this period');
  const policy = parseRentalBillingPolicy(rental.billingPolicy);

  // The send-for-billing gate (rentalBillingRelease.ts), enforced here and not
  // only by the Ready queue's filter — otherwise it is a UI suggestion. An
  // active rental must have been sent for a span that reaches this period; a
  // closed one must have its tickets approved (or have been forced). Preview
  // is exempt: looking is not billing.
  if (!previewOnly) {
    if (rental.status === 'active') {
      const sent = rentalReleaseState(rental, { lastBilledThrough: new Date(+pStart - 86400000), isFullyBilled: false }, 0) === 'released';
      if (!sent) throw new AppError(409, 'This rental has not been sent for billing for this period. A field supervisor sends it from the dashboard Rental Billing tab; an AR Supervisor can force it.');
    } else {
      const unapproved = await tx.serviceTicket.count({
        where: { linkedRentalAgreementId: rentalAgreementId, status: { in: [...RELEASE_BLOCKING_STATUSES] } },
      });
      if (rentalReleaseState(rental, { lastBilledThrough: null, isFullyBilled: false }, unapproved) === 'closed_blocked') {
        throw new AppError(409, `${unapproved} ticket${unapproved === 1 ? '' : 's'} on this rental still need${unapproved === 1 ? 's' : ''} supervisor approval before the final bill. An AR Supervisor can force it.`);
      }
    }
  }

  // Do not bill any rental day twice, including partially overlapping periods.
  const existing = await tx.invoice.findFirst({
    where: {
      rentalAgreementId,
      status: { not: 'void' },
      periodStart: { lte: pEnd },
      periodEnd: { gte: pStart },
    },
  });
  if (existing) throw new AppError(400, `Invoice ${existing.invoiceNumber} overlaps this period`);

  // --- Detect first/last invoice for delivery/pickup template lines ---
  const priorInvoiceCount = await tx.invoice.count({
    where: { rentalAgreementId, status: { not: 'void' } },
  });
  const isFirstInvoice = priorInvoiceCount === 0;
  const isLastInvoice = rental.status === 'completed' && !!rental.endDate && pStart <= rental.endDate && pEnd >= rental.endDate;
  // ...but only when Basin actually drove. A walk-in was carried off the
  // counter, so there is no trip to bill either way (rentalBilling.ts).
  const wantsDeliveryPickup = seedsDeliveryPickupLines(rental);

  // Delivery/pickup template lines. Rentals are D4, so these bill 0400001
  // mileage and 0400002 labor. Both lookups hit the catalog, so a walk-in
  // (which seeds no such lines) skips them rather than paying for the answer.
  const [mileageProduct, laborProduct] = wantsDeliveryPickup
    ? await Promise.all([
        getMileageProduct(RENTAL_DEFAULT_DIVISION),
        getLaborProduct(RENTAL_DEFAULT_DIVISION),
      ])
    : [null, null];

  // Fetch linked service tickets (cal visits, etc.) not yet billed, back to the
  // START OF THE JOB — deliberately no lower bound at periodStart. A ticket a
  // tech syncs or finishes after its own day was invoiced is dated before every
  // later period, so a period-bounded sweep never picks it up; and because
  // rental-linked tickets are excluded from the standalone ticket queue (the
  // double-invoice guard), it would then sit unbilled in no queue at all. The
  // status filter below plus assertTicketsNotOnLiveInvoice are what stop a
  // re-bill, not the date.
  const linkedTickets = await tx.serviceTicket.findMany({
    where: {
      linkedRentalAgreementId: rentalAgreementId,
      serviceDate: { lte: pEnd },
      // APPROVED and not yet billed only. `invoiced` / `closed` / `void` are
      // already accounted for (ADR-0014 mechanism #2). Everything earlier than
      // `billing_queue` is not approved yet: a ticket still being worked, one
      // waiting on a supervisor, one waiting on a customer signature. Nothing
      // unapproved rides onto an invoice — it is picked up by a later one,
      // which the job-start sweep above makes safe.
      status: 'billing_queue' as const,
    },
    include: {
      well: { select: { costCenter: true, facilityCode: true, buyerSiteUuid: true, buyerDepartment: true } },
      pad: { select: { costCenter: true, facilityCode: true, buyerSiteUuid: true, buyerDepartment: true } },
      lineItems: {
        include: {
          product: {
            select: { id: true, partNumber: true, name: true, qbItemListId: true, qbItemFullName: true },
          },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });
  // One live invoice per ticket — a rider ticket whose charges already sit on
  // another live invoice must not be billed again here.
  await assertTicketsNotOnLiveInvoice(tx, linkedTickets.filter(t => t.lineItems.length).map(t => t.id));

  // Classification is independent of charge eligibility: even a previously
  // invoiced daily ticket records attendance. Other field visits do not.
  // Same job-start reach as the charge sweep above: days before periodStart are
  // never iterated by the day-rate loop, so the extra dates are inert there and
  // exist only to catch late manned dailies (below).
  const attendanceTickets = policy.ticketRates ? await tx.serviceTicket.findMany({
    where: { linkedRentalAgreementId: rentalAgreementId, serviceDate: { lte: pEnd }, status: { not: 'void' } },
    select: { id: true, ticketNumber: true, serviceDate: true, status: true, customData: true },
  }) : [];
  const mannedDates = new Set(attendanceTickets.filter(isMannedDailyTicket).map(t => t.serviceDate.toISOString().slice(0, 10)));

  // Late manned dailies: a manned-trailer daily that arrives after its day was
  // already invoiced. That day went out at the UNMANNED rate (no ticket existed
  // to say otherwise), and sweeping the ticket's own line items does not fix
  // the day rate. We do not auto-bill the difference — AR decides — so each such
  // day gets a quantity-0 adjustment line carrying the manned-minus-unmanned
  // rate (same idea as the $0 delivery/pickup template rows: a place to put the
  // number), and the preview names it. The ticket is consumed either way so it
  // flags once, not on every later invoice.
  const lateMannedAdjustments: { date: string; ticketNumbers: string[]; billedOn: string; difference: number }[] = [];
  const lateMannedTicketIds: string[] = [];
  const lateManned = attendanceTickets.filter(t => t.serviceDate < pStart && isMannedDailyTicket(t)
    && !['invoiced', 'closed'].includes(t.status) && !isBillingPaused(t.serviceDate, policy.pauses));
  if (lateManned.length) {
    const priorInvoices = await tx.invoice.findMany({
      where: { rentalAgreementId, status: { not: 'void' } },
      select: { invoiceNumber: true, periodStart: true, periodEnd: true },
    });
    const byDate = new Map<string, typeof lateManned>();
    for (const t of lateManned) {
      const key = t.serviceDate.toISOString().slice(0, 10);
      byDate.set(key, [...(byDate.get(key) ?? []), t]);
    }
    for (const [date, tickets] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
      const day = tickets[0].serviceDate;
      const covering = priorInvoices.find(inv => inv.periodStart && inv.periodEnd && inv.periodStart <= day && inv.periodEnd >= day);
      // Never invoiced (a gap AR skipped): nothing to correct — the day bills
      // manned on its own when its period is finally invoiced.
      if (!covering) continue;
      lateMannedTicketIds.push(...tickets.map(t => t.id));
      // Another shift's ticket for the same date was already consumed, so the
      // day already billed manned. Multiple shifts are still one manned day.
      const alreadyManned = attendanceTickets.some(t => ['invoiced', 'closed'].includes(t.status)
        && isMannedDailyTicket(t) && t.serviceDate.toISOString().slice(0, 10) === date);
      const rates = ticketRatesOn(day, policy);
      const difference = rates ? Math.round((rates.manned - rates.unmanned) * 100) / 100 : 0;
      if (alreadyManned || difference <= 0) continue;
      lateMannedAdjustments.push({ date, ticketNumbers: tickets.map(t => t.ticketNumber), billedOn: covering.invoiceNumber, difference });
    }
  }
  const linkedPoNumber = linkedTickets
    .map(t => t.poNumber?.trim())
    .find((v): v is string => !!v);
  const linkedAfeNumber = linkedTickets
    .map(t => t.afeNumber?.trim())
    .find((v): v is string => !!v);
  // Location codes follow the profile rentals bill under; the rental's own site stands in when no visit carries one.
  const rentalProfile = profileForBillingWork(
    await tx.customerBillingProfile.findMany({ where: { companyId: rental.companyId, isActive: true } }),
    linkedTickets[0] ?? { division: RENTAL_DEFAULT_DIVISION, serviceDate: pEnd });
  const linkedCodes = invoiceBillingCodes(rentalProfile, linkedTickets);
  const siteCodes = invoiceBillingCodes(rentalProfile, [{ well: rental.well, pad: rental.pad }]);

  // Build line items from rental items active during the billing period
  const lineItems: Array<{
    lineNumber: number;
    description: string;
    productId: string | null;
    partNumber: string | null;
    quantity: number;
    unitOfMeasure: string;
    rate: number;
    amount: number;
    isTaxable: boolean;
    sourceRentalItemId: string | null;
    sourceTicketId: string | null;
    sourceTicketNumber: string | null;
    qbItemListId: string | null;
    qbItemFullName: string | null;
    // Only the equipment-used note sets this today. QBWC drops qbSkip lines
    // (routes/qbwc.ts), which is what keeps a qty-0 note out of QuickBooks.
    qbSkip?: boolean;
    sortOrder: number;
  }> = [];

  let lineNum = 1;

  const billedDailyTicketIds = new Set<string>(lateMannedTicketIds);

  // #5 Composition billing: when the rental carries a priced composition, bill
  // per composition LINE (rate × qty × periods) — "priced to the job, not the
  // item". Deployed serials are inventory/tracking only. Legacy rentals and
  // walk-ins (no priced composition) fall through to the per-item loop below.
  const compositionWindows = (policy.compositionHistory?.length ? policy.compositionHistory : [{effectiveDate:'0001-01-01',composition:rental.composition}])
    .map((c, i, all) => ({composition:c.composition as RentalComposition | null,
      start: new Date(Math.max(+pStart, +new Date(c.effectiveDate))),
      end: new Date(Math.min(+pEnd, i + 1 < all.length ? +new Date(all[i+1].effectiveDate) - 86400000 : +pEnd))}))
    .filter(w => w.start <= w.end);
  const useCompositionBilling = !!policy.ticketRates || compositionWindows.some(w => hasRatedComposition(w.composition));
  for (const window of useCompositionBilling ? compositionWindows : []) {
  const composition = window.composition;
  if (useCompositionBilling) {
    const unpriced = unpricedCompositionLines(policy.ticketRates && composition
      ? { ...composition, trailer: null, bomPackage: null } : composition);
    if (unpriced.length) {
      throw new AppError(400,
        `Cannot generate invoice: ${unpriced.length} ordered line(s) have no rate set — ${unpriced.join(', ')}. ` +
        `Set a rate on the rental agreement before invoicing.`);
    }
  }

  if (useCompositionBilling) {
    // Job window: from when gear first deployed (fallback: agreement start)
    // through return/completion (or the period end while still active).
    const deployTimes = rental.items
      .map(i => new Date(i.deployedDate).getTime())
      .filter(t => !Number.isNaN(t));
    const agreementStart = deployTimes.length ? new Date(Math.min(...deployTimes)) : new Date(rental.startDate);
    const returnTimes = rental.items
      .map(i => (i.returnedDate ? new Date(i.returnedDate).getTime() : NaN))
      .filter(t => !Number.isNaN(t));
    const agreementEnd = rental.status === 'completed'
      ? (rental.endDate ? new Date(rental.endDate) : (returnTimes.length ? new Date(Math.max(...returnTimes)) : null))
      : null;

    // Only bill if the job window overlaps this billing period.
    if (agreementStart <= pEnd && (!agreementEnd || agreementEnd >= pStart)) {
      const effectiveStart = agreementStart > window.start ? agreementStart : window.start;
      // Still on rent? Stop at today, not at the end of the requested period —
      // otherwise a job deployed on the 27th bills through the 31st.
      const billThrough = agreementEnd ?? billableThroughToday();
      const effectiveEnd = billThrough < window.end ? billThrough : window.end;
      if (effectiveStart > effectiveEnd) continue;
      const { qty: periodQty, uom } = billableRentalPeriods(effectiveStart, effectiveEnd, rental.billingRateType, policy.pauses);
      for (const ticket of attendanceTickets) {
        if (isMannedDailyTicket(ticket) && ticket.serviceDate >= effectiveStart && ticket.serviceDate <= effectiveEnd
            && !isBillingPaused(ticket.serviceDate, policy.pauses)
            && !['invoiced', 'closed'].includes(ticket.status)) billedDailyTicketIds.add(ticket.id);
      }

      // Resolve QB mapping for every product-backed line: gas monitors, the
      // rental package itself, and any over-baseline extras. Carrying
      // qbItemListId through is what lets the customer's price level adjust
      // these to the MSA rate downstream (resolveInvoiceRules matches on it) —
      // a productless line would quietly bill at list.
      const linkedProductIds = [
        ...(composition?.gasMonitors || []).map(g => g.productId),
        ...(composition?.other || []).map(o => o.productId),
        composition?.bomPackage?.productId,
        ...(composition?.bomExtras || []).map(e => e.productId),
      ].filter(Boolean) as string[];
      const linkedProducts = linkedProductIds.length
        ? await tx.product.findMany({
            where: { id: { in: Array.from(new Set(linkedProductIds)) } },
            select: { id: true, partNumber: true, name: true, isSerialized: true, qbItemListId: true, qbItemFullName: true },
          })
        : [];
      const prodById = new Map(linkedProducts.map(p => [p.id, p]));

      const pushCompLine = (o: {
        label: string; unitRate: number; units: number;
        productId?: string | null; partNumber?: string | null;
        qbItemListId?: string | null; qbItemFullName?: string | null;
        periods?: number; periodUom?: string; equipmentProductId?: string | null;
      }) => {
        // Bill UNIT-PERIODS: 3 monitors for 3 days is 9 monitor-days at the
        // monitor's own rate, the same way labor bills man-hours. The older
        // shape multiplied the count INTO the rate (3 days @ $150) which put a
        // number on the invoice that exists nowhere in the pricebook and can't
        // be reconciled against the catalog.
        //
        // It also silently under-billed: a price level's customPrice is "per
        // monitor per day", but resolveInvoiceRules REPLACES `rate` outright,
        // so a rate carrying a baked-in ×3 lost the count and billed a third of
        // what it should. With the count in `quantity` instead, customPrice
        // lands on the unit it was always describing, and percentage
        // adjustments scale identically either way.
        //
        // Amount is unchanged for every line that wasn't already wrong:
        // unitRate × units × periods, however it's grouped.
        const units = Math.max(1, o.units);
        // A QB billing SKU is an ordered charge, not a serialized equipment
        // model. Only serialized products use deployment-slot occupancy.
        const trackedItems = o.equipmentProductId ? rental.items.filter(i => i.productId === o.equipmentProductId) : [];
        const tracksEquipment = o.equipmentProductId && (trackedItems.length > 0
          || prodById.get(o.equipmentProductId)?.isSerialized !== false);
        if (rental.billingRateType !== 'daily' && !o.periodUom) {
          for (const charge of proratedRentalCharges(effectiveStart, effectiveEnd, rental.billingRateType, o.unitRate,
            policy.pauses, units, tracksEquipment ? trackedItems : undefined)) {
            pushCompLine({ ...o, label: `${o.label} (prorated from $${o.unitRate}/${rental.billingRateType})`,
              equipmentProductId: null, unitRate: charge.rate, units: 1, periods: charge.quantity, periodUom: 'DAY' });
          }
          return;
        }
        const quantity = tracksEquipment
          ? occupiedRentalPeriods(effectiveStart, effectiveEnd, rental.billingRateType, policy.pauses, trackedItems, units)
          : units * (o.periods ?? periodQty);
        if (quantity === 0) return;
        const lineUom = o.periodUom ?? uom;
        const amount = Math.round(o.unitRate * quantity * 100) / 100;
        lineItems.push({
          lineNumber: lineNum,
          description: `Rental — ${o.label}${units > 1 ? ` × ${units}` : ''} @ $${o.unitRate}/${lineUom.toLowerCase()}`,
          productId: o.productId ?? null,
          partNumber: o.partNumber ?? null,
          quantity,
          unitOfMeasure: lineUom,
          rate: o.unitRate,
          amount,
          isTaxable: !rental.company.taxExempt, // rental of TPP is taxable in ND
          sourceRentalItemId: null,
          sourceTicketId: null,
          sourceTicketNumber: null,
          qbItemListId: o.qbItemListId ?? null,
          qbItemFullName: o.qbItemFullName ?? null,
          sortOrder: lineNum - 1,
        });
        lineNum++;
      };

      // A rate of 0 is a real (free/included) line; only null/absent is skipped
      // (shared hasRate). Trailer/monitor/other and the package line + overages
      // are all guaranteed set by the guard above; the `bom` roster is the one
      // thing that may legitimately be unrated — it lists contents, not charges.
      // The trailer is inside the package when one exists — dispatch zeroes its
      // rate so it can't double-bill. Printing that $0 row too just invites
      // "why is this free?" on an invoice that already charges for it once.
      if (policy.ticketRates) {
        // Explicit job rates replace the base trailer/package charge, once per
        // date (multiple shifts still represent one manned rental day).
        const pkg = composition?.bomPackage;
        const p = pkg?.productId ? prodById.get(pkg.productId) : undefined;
        for (const charge of dailyRentalCharges(effectiveStart, effectiveEnd, policy, mannedDates)) {
          const mode = charge.mode;
          pushCompLine({ label: `${pkg?.label || 'Job'} (${mode === 'manned' ? 'Manned' : 'Unmanned'})`,
            unitRate: charge.rate, units: 1, periods: charge.days, periodUom: 'DAY',
            productId: pkg?.productId, partNumber: p?.partNumber,
            qbItemListId: p?.qbItemListId, qbItemFullName: p?.qbItemFullName });
        }
      }
      if (!policy.ticketRates && composition?.trailer && hasRate(composition.trailer.rate)
          && !(composition.bomPackage && composition.trailer.rate === 0)) {
        pushCompLine({
          label: `Trailer (${composition.trailer.manned ? 'Manned' : 'Unmanned'})`,
          unitRate: composition.trailer.rate, units: 1,
        });
      }
      for (const g of composition?.gasMonitors || []) {
        if (!hasRate(g.rate)) continue;
        const p = prodById.get(g.productId);
        pushCompLine({
          label: g.productName || p?.name || 'Gas Monitor',
          unitRate: g.rate, units: g.qty || 1,
          equipmentProductId: g.productId, productId: g.productId, partNumber: p?.partNumber ?? null,
          qbItemListId: p?.qbItemListId ?? null, qbItemFullName: p?.qbItemFullName ?? null,
        });
      }
      for (const o of composition?.other || []) {
        if (!hasRate(o.rate)) continue;
        const p = o.productId ? prodById.get(o.productId) : undefined;
        pushCompLine({ label: o.label, unitRate: o.rate, units: o.qty || 1,
          equipmentProductId: o.productId, productId: o.productId ?? null, partNumber: p?.partNumber,
          qbItemListId: p?.qbItemListId, qbItemFullName: p?.qbItemFullName });
      }
      // The package bills as a SINGLE line at the package rate — the `bom` rows
      // are its contents, not charges, so they're never pushed individually.
      if (!policy.ticketRates && composition?.bomPackage && hasRate(composition.bomPackage.rate)) {
        const pkg = composition.bomPackage;
        const p = pkg.productId ? prodById.get(pkg.productId) : undefined;
        pushCompLine({
          label: pkg.label || 'Rental Package',
          unitRate: pkg.rate as number, units: pkg.qty || 1,
          productId: pkg.productId ?? null, partNumber: p?.partNumber ?? null,
          qbItemListId: p?.qbItemListId ?? null, qbItemFullName: p?.qbItemFullName ?? null,
        });
      }
      // Gear deployed above the baseline — one line per category over, at that
      // row's own rate. This is the only place the 5th-of-4 monitor shows up.
      for (const e of composition?.bomExtras || []) {
        if (!hasRate(e.rate)) continue;
        const p = e.productId ? prodById.get(e.productId) : undefined;
        pushCompLine({
          label: e.label, unitRate: e.rate, units: e.qty || 1,
          productId: e.productId ?? null, partNumber: p?.partNumber ?? null,
          qbItemListId: p?.qbItemListId ?? null, qbItemFullName: p?.qbItemFullName ?? null,
        });
      }
      // Legacy: pre-package agreements that put rates directly on baseline rows.
      // Only fires when no package line exists, so nothing double-bills.
      if (!policy.ticketRates && !composition?.bomPackage) {
        for (const b of composition?.bom || []) {
          if (!hasRate(b.rate)) continue;
          pushCompLine({ label: b.label, unitRate: b.rate, units: b.qty || 1 });
        }
      }
    }
  }
  }
  if (!useCompositionBilling)
  for (const item of rental.items) {
    // Skip items not yet deployed or returned before period started
    const deployedDate = new Date(item.deployedDate);
    const returnedDate = item.returnedDate ? new Date(item.returnedDate) : null;

    // Item must overlap with the billing period
    if (deployedDate > pEnd) continue;                    // deployed after period ends
    if (returnedDate && returnedDate < pStart) continue;  // returned before period starts

    // Billable window within the period
    const effectiveStart = deployedDate > pStart ? deployedDate : pStart;
    // Same stop-the-clock rule as composition billing above: an item still in
    // the field bills through today, not through the end of the period.
    const billThrough = returnedDate ?? billableThroughToday();
    let effectiveEnd = billThrough < pEnd ? billThrough : pEnd;
    const replacement = rental.items.find(i => i.replacesItemId === item.id);
    if (replacement) {
      const outgoingThrough = new Date(+replacement.deployedDate - 86400000);
      if (outgoingThrough < effectiveEnd) effectiveEnd = outgoingThrough;
    }

    // Get the rate — item-level rate, or fall back to product default
    const rateType = item.rateType || rental.billingRateType;
    const fallback = rateType === 'weekly' ? item.product?.defaultRentalRateWeekly
      : rateType === 'monthly' ? item.product?.defaultRentalRateMonthly : item.product?.defaultRentalRateDaily;
    const selectedRate = item.rate ?? fallback;
    if (selectedRate == null) throw new AppError(400, 'Set a rental rate before invoicing');
    const baseRate = Number(selectedRate);

    // Period quantity + UoM via the shared helper, so per-item and composition
    // billing can't drift on rounding (especially the monthly calc).
    const { qty: quantity, uom } = billableRentalPeriods(effectiveStart, effectiveEnd, rateType, policy.pauses);
    if (quantity === 0) continue;

    const charges = rateType === 'daily'
      ? [{ quantity, rate: baseRate, amount: Math.round(baseRate * quantity * 100) / 100 }]
      : proratedRentalCharges(effectiveStart, effectiveEnd, rateType, baseRate, policy.pauses);
    for (const charge of charges) {
    const lineUom = rateType === 'daily' ? uom : 'DAY';
    const serial = item.serializedEquipment?.serialNumber || '';
    const productName = item.product?.name || 'Equipment';

    lineItems.push({
      lineNumber: lineNum,
      description: `Rental — ${productName}${serial ? ` (S/N: ${serial})` : ''} × ${quantity} ${uom.toLowerCase()}${quantity > 1 ? 's' : ''}${rateType === 'daily' ? '' : ` (prorated from $${baseRate}/${rateType})`}`,
      productId: item.productId,
      partNumber: item.product?.partNumber || null,
      quantity: charge.quantity,
      unitOfMeasure: lineUom,
      rate: charge.rate,
      amount: charge.amount,
      isTaxable: !rental.company.taxExempt, // rental of TPP is taxable in ND
      sourceRentalItemId: item.id,
      sourceTicketId: null,
      sourceTicketNumber: null,
      qbItemListId: item.product?.qbItemListId || null,
      qbItemFullName: item.product?.qbItemFullName || null,
      sortOrder: lineNum - 1,
    });
    lineNum++;
    }
  }

  if (!lineItems.length && !linkedTickets.some(t => t.lineItems.length)) throw new AppError(400, 'No billable items in this period');

  // --- Late manned-day adjustments (see lateMannedAdjustments above) ---
  // Quantity 0 on purpose: AR sets it to 1 to bill the difference, or deletes
  // the row. Hung on the package product so it maps to the same QB item as the
  // day-rate lines it corrects.
  if (lateMannedAdjustments.length) {
    const pkgProductId = (rental.composition as RentalComposition | null)?.bomPackage?.productId ?? null;
    const pkgProduct = pkgProductId ? await tx.product.findUnique({
      where: { id: pkgProductId },
      select: { id: true, partNumber: true, qbItemListId: true, qbItemFullName: true },
    }) : null;
    for (const adj of lateMannedAdjustments) {
      lineItems.push({
        lineNumber: lineNum++,
        description: `Manned day adjustment — ${adj.date} (${adj.ticketNumbers.join(', ')}), billed unmanned on ${adj.billedOn}`,
        productId: pkgProduct?.id ?? null,
        partNumber: pkgProduct?.partNumber ?? null,
        quantity: 0,
        unitOfMeasure: 'DAY',
        rate: adj.difference,
        amount: 0,
        isTaxable: !rental.company.taxExempt,
        sourceRentalItemId: null,
        sourceTicketId: null,
        sourceTicketNumber: null,
        qbItemListId: pkgProduct?.qbItemListId ?? null,
        qbItemFullName: pkgProduct?.qbItemFullName ?? null,
        sortOrder: lineNum - 2,
      });
    }
  }

  // --- Delivery template lines (first invoice, dispatch only) ---
  if (isFirstInvoice && wantsDeliveryPickup && mileageProduct && laborProduct) {
    lineItems.push({
      lineNumber: lineNum++,
      description: `Delivery — Mileage`,
      productId: mileageProduct.id,
      partNumber: mileageProduct.partNumber,
      quantity: 0,
      unitOfMeasure: 'MI',
      rate: 0,
      amount: 0,
      isTaxable: false,
      sourceRentalItemId: null,
      sourceTicketId: null,
      sourceTicketNumber: null,
      qbItemListId: mileageProduct.qbItemListId || null,
      qbItemFullName: mileageProduct.qbItemFullName || null,
      sortOrder: lineNum - 2,
    });
    lineItems.push({
      lineNumber: lineNum++,
      description: `Delivery — Labor`,
      productId: laborProduct.id,
      partNumber: laborProduct.partNumber,
      quantity: 0,
      unitOfMeasure: 'HR',
      rate: 0,
      amount: 0,
      isTaxable: false,
      sourceRentalItemId: null,
      sourceTicketId: null,
      sourceTicketNumber: null,
      qbItemListId: laborProduct.qbItemListId || null,
      qbItemFullName: laborProduct.qbItemFullName || null,
      sortOrder: lineNum - 2,
    });
  }

  // --- Pickup template lines (last invoice, dispatch only) ---
  if (isLastInvoice && wantsDeliveryPickup && mileageProduct && laborProduct) {
    lineItems.push({
      lineNumber: lineNum++,
      description: `Pickup — Mileage`,
      productId: mileageProduct.id,
      partNumber: mileageProduct.partNumber,
      quantity: 0,
      unitOfMeasure: 'MI',
      rate: 0,
      amount: 0,
      isTaxable: false,
      sourceRentalItemId: null,
      sourceTicketId: null,
      sourceTicketNumber: null,
      qbItemListId: mileageProduct.qbItemListId || null,
      qbItemFullName: mileageProduct.qbItemFullName || null,
      sortOrder: lineNum - 2,
    });
    lineItems.push({
      lineNumber: lineNum++,
      description: `Pickup — Labor`,
      productId: laborProduct.id,
      partNumber: laborProduct.partNumber,
      quantity: 0,
      unitOfMeasure: 'HR',
      rate: 0,
      amount: 0,
      isTaxable: false,
      sourceRentalItemId: null,
      sourceTicketId: null,
      sourceTicketNumber: null,
      qbItemListId: laborProduct.qbItemListId || null,
      qbItemFullName: laborProduct.qbItemFullName || null,
      sortOrder: lineNum - 2,
    });
  }

  // --- Linked ticket charges (cal visits, field service tied to this rental) ---
  for (const ticket of linkedTickets) {
    for (const tli of ticket.lineItems) {
      const tliRate = tli.rate ? parseFloat(tli.rate.toString()) : 0;
      const tliQty = parseFloat(tli.quantity.toString());
      const tliAmount = tli.total ? parseFloat(tli.total.toString()) : tliRate * tliQty;

      lineItems.push({
        lineNumber: lineNum++,
        description: `${ticket.ticketNumber} — ${tli.description || tli.product?.name || 'Service charge'}`,
        productId: tli.productId,
        partNumber: tli.product?.partNumber || tli.partNumber || null,
        quantity: tliQty,
        unitOfMeasure: tli.unitOfMeasure || 'EA',
        rate: tliRate,
        amount: tliAmount,
        isTaxable: rental.company.taxExempt ? false : defaultTaxableForLineType(tli.lineType),
        sourceRentalItemId: null,
        sourceTicketId: ticket.id,
        sourceTicketNumber: ticket.ticketNumber,
        qbItemListId: tli.product?.qbItemListId || null,
        qbItemFullName: tli.product?.qbItemFullName || null,
        sortOrder: lineNum - 2,
      });
    }
  }

  // What physically went out. Composition billing prices the job (a package, a
  // monitor line), so without this QB only sees what was ordered, not the
  // actual trailer / monitor serials deployed. Build it from rental.items (the
  // scanned units), not from the composition. Legacy per-item rental billing
  // already carries each serial on its own line, so this only enriches the
  // composition path.
  if (useCompositionBilling) {
    const detail = rentalDeployedItemsDetail(rental.items, pStart, pEnd);
    if (detail) {
      const target = lineItems.find(li => li.description.startsWith('Rental —') && li.amount !== 0)
        || lineItems.find(li => li.description.startsWith('Rental —'));
      if (target) target.description = `${target.description}\n${detail}`;
    }
  }

  if (lineItems.length === 0) {
    throw new AppError(400, 'No billable items in this period');
  }

  const subtotal = lineItems.reduce((sum, li) => sum + li.amount, 0);

  // ND sales tax — destination-based on the rental's delivery location county.
  const taxCounty = countyFromTicketLocations(rental);
  const jurisdiction = rental.company.taxExempt ? null : await resolveJurisdictionForCounty(taxCounty);
  const taxRate = jurisdiction?.rate ?? 0;
  await applyInvoiceProductTax(tx, lineItems, rental.company.taxExempt);
  const taxAmount = computeTaxAmount(lineItems, taxRate);

  await applyCustomerDescriptions(tx, rental.companyId, lineItems);
  if (previewOnly) return { preview: {
    periodStart: pStart.toISOString().slice(0, 10), periodEnd: pEnd.toISOString().slice(0, 10),
    days: rentalBillingDays(pStart, pEnd, policy.pauses, mannedDates),
    attendanceBased: !!policy.ticketRates, lineItems: rentalSweepLines(lineItems), subtotal, taxAmount, total: subtotal + taxAmount,
    lateMannedDays: lateMannedAdjustments,
    rateChanges: policy.rateChanges ?? [], compositionChanges: compositionWindows.map(w => ({ start: w.start.toISOString().slice(0, 10), end: w.end.toISOString().slice(0, 10) })),
    equipment: rental.items.map(i => ({ serial: i.serializedEquipment?.serialNumber ?? 'Unserialized', deployed: i.deployedDate, returned: i.returnedDate, replacesItemId: i.replacesItemId })),
  } };
  const invoiceNumber = await generateInvoiceNumber();
  const invoice = await tx.invoice.create({
    data: {
      invoiceNumber,
      status: 'draft',
      sourceType: 'rental_agreement',
      companyId: rental.companyId,
      companyName: rental.company.name,
      rentalAgreementId: rental.id,
      poNumber: rental.poNumber || linkedPoNumber || null,
      afeNumber: rental.afeNumber || linkedCodes.afeNumber || siteCodes.afeNumber || linkedAfeNumber || null,
      costCenter: linkedCodes.costCenter ?? siteCodes.costCenter,
      // QB Class — rentals are D4 (same default the rental tickets carry).
      division: RENTAL_DEFAULT_DIVISION,
      invoiceDate: pEnd,
      periodStart: pStart,
      periodEnd: pEnd,
      subtotal,
      taxAmount,
      total: subtotal + taxAmount,
      taxJurisdictionId: jurisdiction?.id ?? null,
      taxRate,
      createdById: req.user?.userId || null,
      lineItems: {
        create: lineItems,
      },
    },
    include: { lineItems: true },
  });


  // Hand the consumed tickets off out of the billing pipeline. Without this
  // they stay in `billing_queue` forever after their charges have already been
  // billed — and because `GET /uninvoiced/tickets` excludes every rental-linked
  // ticket (the double-invoice guard), nothing renders them, so nobody notices.
  // Daily attendance tickets also contribute to the configured manned rate,
  // even when their own line-item list is empty.
  const consumedTicketIds = [...new Set(
    [...lineItems.map(li => li.sourceTicketId).filter((id): id is string => !!id), ...billedDailyTicketIds],
  )];
  if (consumedTicketIds.length > 0) {
    await tx.serviceTicket.updateMany({
      where: { id: { in: consumedTicketIds } },
      data: { status: 'invoiced' },
    });
  }

  return { invoice, consumedTicketIds, policy };
  }, { maxWait: 10000, timeout: 30000 });
  if ('preview' in result) { res.json(result.preview); return; }
  const { invoice, consumedTicketIds, policy } = result;
  await upsertDocRefAndLines(invoice.id);
  await createAuditLog({
    userId: req.user?.userId,
    entityType: 'invoice',
    entityId: invoice.id,
    action: 'create',
    changes: {
      sourceType: 'rental_agreement',
      rentalAgreementId,
      invoiceNumber: invoice.invoiceNumber,
      periodStart,
      periodEnd,
      consumedTicketIds,
      billingPolicy: policy,
    },
    ipAddress: req.ip,
  });

  res.status(201).json(invoice);
});

// ============================================================
// GET /uninvoiced/rentals — Rentals ready for billing
// Includes both active rentals (recurring billing periods) and
// completed rentals that haven't been billed through their endDate
// (the "final bill" case — completing a rental must not hide it
// from billing until the last period is invoiced).
// ============================================================

invoicesRouter.get('/uninvoiced/rentals', async (req: Request, res: Response) => {
  // AR Supervisor's escape hatch: also list rentals the field has not sent, so
  // they can be forced. Silently ignored for anyone without the capability.
  const includeUnreleased = req.query.includeUnreleased === '1'
    && roleHasCapability(req.user?.role, 'rentals:force_billing_release');
  const candidates = await prisma.rentalAgreement.findMany({
    where: { status: { in: ['active', 'completed'] } },
    include: {
      ...billingLocationSelect,
      company: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      billingReleasedBy: { select: { id: true, name: true } },
      _count: { select: { items: true } },
      items: {
        where: { status: 'deployed' },
        select: { id: true, rate: true, rateType: true, deployedDate: true },
      },
      // Tickets waiting to roll onto this rental's invoice. They are excluded
      // from GET /uninvoiced/tickets on purpose (the double-invoice guard,
      // ADR-0014 mechanism #3), which meant a rental-linked ticket sitting in
      // `billing_queue` rendered in NO queue at all — it read "Billing Queue"
      // on the ticket and was absent from the billing queue. Surfacing them
      // here, on the rental that will actually bill them, is what closes that
      // hole without reopening the standalone double-bill path.
      linkedServiceTickets: {
        // `completed` is fetched only to count release blockers; the card's
        // pending-ticket list below still shows review + approved, as before.
        where: { status: { in: ['completed', 'supervisor_review', 'billing_queue'] } },
        select: {
          id: true,
          ticketNumber: true,
          status: true,
          serviceDate: true,
          lineItems: { select: { total: true } },
        },
        orderBy: { serviceDate: 'asc' },
      },
    },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
  });

  // For each rental, gather its non-void invoices — computeRentalBillingState
  // finds the latest periodEnd itself, so both this route and the billing
  // watcher/linked-invoices badge agree on one definition (rentalBilling.ts).
  const rentalIds = candidates.map(r => r.id);
  const invoicesByAgreement = await prisma.invoice.findMany({
    where: {
      rentalAgreementId: { in: rentalIds },
      status: { not: 'void' },
    },
    select: { id: true, invoiceNumber: true, rentalAgreementId: true, periodEnd: true },
  });
  const invoicesFor = new Map<string, { id: string; invoiceNumber: string; periodEnd: Date | null }[]>();
  for (const inv of invoicesByAgreement) {
    if (!inv.rentalAgreementId) continue;
    const list = invoicesFor.get(inv.rentalAgreementId) ?? [];
    list.push({ id: inv.id, invoiceNumber: inv.invoiceNumber, periodEnd: inv.periodEnd });
    invoicesFor.set(inv.rentalAgreementId, list);
  }

  // Filter completed rentals that have already been fully billed.
  const result = candidates
    .map(r => {
      const { lastBilledThrough, isFullyBilled } = computeRentalBillingState(r, invoicesFor.get(r.id) ?? []);
      const blockers = blockersFor(r.linkedServiceTickets, r.status === 'completed' ? null : rentalToday());
      const releaseState = rentalReleaseState(r, { lastBilledThrough, isFullyBilled }, blockers.length);
      // Flatten each waiting ticket to its billable total so the card can show
      // "2 tickets waiting · $1,200" without shipping every line item. A
      // zero-dollar linked ticket is a daily-log/record-only artifact, not
      // something AR can bill through the rental, so it must not keep a fully
      // billed completed rental in this queue or wear the "after final invoice"
      // warning just because the log was worked on the last day.
      const billablePendingTickets = r.linkedServiceTickets.filter(t => t.status !== 'completed').map(t => ({
        id: t.id,
        ticketNumber: t.ticketNumber,
        status: t.status,
        serviceDate: t.serviceDate,
        total: t.lineItems.reduce((sum, li) => sum + (li.total ? parseFloat(li.total.toString()) : 0), 0),
      })).filter(t => t.total > 0);
      const { linkedServiceTickets: _lt, ...rest } = r;
      return {
        ...rest,
        lastBilledThrough,
        releaseState,
        releaseBlockers: blockers.map(({ lineItems: _li, ...t }) => t),
        locationName: billingCardLocation(r),
        deployedItemCount: r.items.length,
        needsFinalBill: r.status === 'completed' && !isFullyBilled,
        finalInvoice: isFullyBilled ? [...(invoicesFor.get(r.id) || [])].sort((a, b) => +(b.periodEnd || 0) - +(a.periodEnd || 0))[0] || null : null,
        pendingTickets: billablePendingTickets,
        pendingTicketTotal: billablePendingTickets.reduce((sum, t) => sum + t.total, 0),
      };
    })
    .filter(r => {
      // Sent by the field (or closed with its tickets approved) — or, for an
      // AR Supervisor who asked, anything that owes billing at all.
      if (isReadyForBilling(r.releaseState) || (includeUnreleased && r.releaseState)) return true;
      if (r.status !== 'completed' || r.needsFinalBill) return false;
      // A completed rental billed through its endDate normally drops off. It
      // must NOT drop off while it still carries an unbilled ticket, though —
      // a tech syncing a shift after AR cut the final invoice would otherwise
      // put that ticket right back in the invisible state this whole change
      // exists to remove (it can't appear in the standalone ticket queue, and
      // its rental would be gone from here).
      return r.pendingTickets.length > 0;
    });

  res.json({ data: result });
});

// ============================================================
// PATCH /:id/approve — Approve invoice for QB push
// ============================================================

invoicesRouter.patch('/:id/approve', async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    include: {
      lineItems: {
        orderBy: { sortOrder: 'asc' },
        include: { product: { select: { qbItemListId: true, qbItemFullName: true } } },
      },
      company: { select: { qbCustomerListId: true, qbCustomerFullName: true, name: true } },
    },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status !== 'draft') {
    throw new AppError(400, `Cannot approve invoice in status '${invoice.status}'`);
  }

  // Missing QB mapping is a billing blocker, not evidence of a walk-in sale.
  // Only genuine no-charge records may close locally without a customer mapping.
  const recordOnly = invoice.lineItems.length > 0 && Number(invoice.total) === 0
    && invoice.lineItems.every(li => Number(li.amount) === 0);
  // ── QB mapping validation — block approval if QB can't handle it ──
  const validationErrors: { customer?: string; unmappedLines: string[] } = { unmappedLines: [] };

  // 1) Customer must have QB mapping
  if (!recordOnly && !invoice.company?.qbCustomerListId && !invoice.company?.qbCustomerFullName) {
    validationErrors.customer = `Company "${invoice.company?.name || invoice.companyName}" has no QuickBooks customer mapping`;
  }

  // 2) All billable lines (amount > 0) must map to a known QB item
  for (const li of invoice.lineItems) {
    const amt = parseFloat(li.amount.toString());
    if (amt > 0) {
      const hasMapping = li.qbItemFullName || li.product?.qbItemFullName;
      if (!hasMapping) {
        validationErrors.unmappedLines.push(
          `Line ${li.lineNumber}: "${li.description.split(/\r?\n/, 1)[0]}" (Part# ${li.partNumber || 'none'}) — no QB item mapping`
        );
      }
    }
  }

  // Attendee/inspection-only records use the existing local $0 closeout path.
  // Empty invoices and negative-only documents are not no-charge records.
  const billableCount = invoice.lineItems.filter(li => parseFloat(li.amount.toString()) > 0).length;
  if (billableCount === 0 && !recordOnly) {
    validationErrors.unmappedLines.push('No billable line items (all lines are $0)');
  }

  if (validationErrors.customer || validationErrors.unmappedLines.length > 0) {
    // Build a human-readable error message (shown in alert on client)
    const parts: string[] = ['Cannot approve — QB mapping issues:'];
    if (validationErrors.customer) parts.push(`• ${validationErrors.customer}`);
    for (const line of validationErrors.unmappedLines) parts.push(`• ${line}`);
    return res.status(400).json({
      error: parts.join('\n'),
      validationErrors,
    });
  }

  const updated = await prisma.invoice.update({
    where: { id: invoice.id, status: invoice.status },
    data: {
      status: 'approved',
      approvedById: (req as any).user?.id,
      approvedAt: new Date(),
      // Clear rejection if it was previously rejected
      rejectedById: null,
      rejectedAt: null,
      rejectionReason: null,
    },
  });

  await createAuditLog({
    userId: (req as any).user?.id,
    entityType: 'invoice',
    entityId: invoice.id,
    action: 'approve',
    changes: { from: 'draft', to: 'approved' },
    ipAddress: req.ip,
  });

  res.json(updated);
});

// ============================================================
// Shared pieces: one live invoice per ticket, and kick back to Approvals
// ============================================================

/**
 * One live invoice per ticket: a ticket's lines may sit on at most one invoice
 * that is not void. Call inside the transaction that attaches tickets to an
 * invoice. `exceptInvoiceId` is the invoice being edited. Training is the one
 * exception (one invoice per employer for the same class ticket) and has its
 * own guard in the training generator, so it does not call this.
 */
async function assertTicketsNotOnLiveInvoice(tx: Prisma.TransactionClient, ticketIds: string[], exceptInvoiceId?: string) {
  if (!ticketIds.length) return;
  const held = await tx.invoiceLineItem.findFirst({
    where: {
      sourceTicketId: { in: ticketIds },
      invoice: { status: { not: 'void' }, ...(exceptInvoiceId ? { id: { not: exceptInvoiceId } } : {}) },
    },
    select: { sourceTicketNumber: true, invoice: { select: { invoiceNumber: true, status: true } } },
  });
  if (held) {
    throw new AppError(409, `Ticket ${held.sourceTicketNumber || ''} is already on invoice ${held.invoice?.invoiceNumber} (${held.invoice?.status}). A ticket can only be on one live invoice.`.replace('  ', ' '));
  }
}

type KickBackTicket = { id: string; ticketNumber: string; status: string; customData: unknown };

/** In-transaction half of a billing kick back: tickets → supervisor_review with the note. */
async function kickTicketsToApprovals(tx: Prisma.TransactionClient, tickets: KickBackTicket[], note: string, userId: string, byName: string | null) {
  for (const t of tickets) {
    await tx.serviceTicket.update({
      where: { id: t.id },
      data: {
        status: 'supervisor_review',
        // Same shape the Ready-queue kick back writes (routes/tickets.ts),
        // so the Approvals dashboard shows the note.
        customData: {
          ...((t.customData as Record<string, any> | null) || {}),
          returnedForReview: { note, byId: userId, byName, at: new Date().toISOString() },
        },
      },
    });
  }
}

/** Post-commit half: audit trail, review signal and event for each kicked-back ticket. */
async function afterKickBack(tickets: KickBackTicket[], note: string, userId: string, invoiceNumber: string, ipAddress?: string) {
  for (const t of tickets) {
    await createAuditLog({
      userId, entityType: 'service_ticket', entityId: t.id, action: 'status_change',
      changes: { from: t.status, to: 'supervisor_review', reason: note, rejectedInvoice: invoiceNumber },
      ipAddress,
    });
    try {
      await runAndCacheReviewSignal(t.id);
    } catch (err) {
      console.error(`[invoices/kick-back] review rules failed for ${t.id}:`, err instanceof Error ? err.message : err);
    }
    void emitEvent('ticket.transitioned', {
      ticketId: t.id, fromStatus: t.status, toStatus: 'supervisor_review', actorUserId: userId, reason: note,
    });
  }
}

// ============================================================
// PATCH /:id/kick-back-ticket — take ONE ticket off a draft and send it back
// to the Approvals dashboard with a note. The draft keeps its other tickets
// and its totals recalculate. Done here in one transaction rather than through
// /tickets/:id/transition: a ticket on a draft is 'invoiced', and its lines
// have to leave the draft in the same step as the status change.
// If no ticket is left on a ticket-built draft, the draft is voided — the same
// outcome as rejecting it.
// ============================================================

invoicesRouter.patch('/:id/kick-back-ticket', requirePermission('invoices:cancel'), async (req: Request, res: Response) => {
  const ticketId = req.body?.ticketId;
  const note = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (typeof ticketId !== 'string' || !ticketId) throw new AppError(400, 'ticketId is required');
  if (!note) throw new AppError(400, 'A note for the reviewer is required to kick a ticket back to Approvals');

  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    select: { id: true, status: true, invoiceNumber: true, sourceType: true, internalNotes: true, taxRate: true },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status !== 'draft') throw new AppError(400, 'A ticket can only be kicked back from a draft invoice');

  const userId = req.user!.userId;
  const actor = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });

  const { inv, ticket, voided } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM service_tickets WHERE id = ${ticketId} FOR UPDATE`;
    const lines = await tx.invoiceLineItem.findMany({
      where: { invoiceId: invoice.id },
      orderBy: [{ sortOrder: 'asc' }, { lineNumber: 'asc' }],
      select: { id: true, sourceTicketId: true, amount: true, isTaxable: true },
    });
    if (!lines.some(l => l.sourceTicketId)) {
      throw new AppError(400, 'This draft was not built from tickets, so there is no ticket to kick back.');
    }
    if (!lines.some(l => l.sourceTicketId === ticketId)) throw new AppError(400, 'That ticket is not on this draft');
    // A training class ticket can sit on one draft per employer; it cannot go
    // back for review underneath another live invoice.
    await assertTicketsNotOnLiveInvoice(tx, [ticketId], invoice.id);
    const ticket = await tx.serviceTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, ticketNumber: true, status: true, customData: true },
    });
    // 'billing_queue' too: un-approve used to release tickets while the draft kept their lines.
    if (!ticket || !['invoiced', 'billing_queue'].includes(ticket.status)) {
      throw new AppError(409, `Ticket is ${ticket?.status.replace(/_/g, ' ') ?? 'missing'} and cannot be kicked back from this draft`);
    }

    const remaining = lines.filter(l => l.sourceTicketId !== ticketId);
    // billing_group = built from tickets (training included). A rental or shop
    // draft that merely carried a rider ticket keeps its own lines.
    const voided = invoice.sourceType === 'billing_group' && !remaining.some(l => l.sourceTicketId);
    let inv;
    if (voided) {
      // Last ticket: keep the lines as the record of what the draft was.
      const voidNote = `Rejected to Approvals: ${note}`;
      inv = await tx.invoice.update({
        where: { id: invoice.id, status: 'draft' },
        data: {
          status: 'void', rejectedById: userId, rejectedAt: new Date(), rejectionReason: note,
          internalNotes: invoice.internalNotes ? `${invoice.internalNotes}\n\n${voidNote}` : voidNote,
        },
      });
    } else {
      await tx.invoiceLineItem.deleteMany({ where: { invoiceId: invoice.id, sourceTicketId: ticketId } });
      for (const [i, line] of remaining.entries()) {
        await tx.invoiceLineItem.update({ where: { id: line.id }, data: { lineNumber: i + 1, sortOrder: i } });
      }
      const subtotal = remaining.reduce((sum, l) => sum + Number(l.amount), 0);
      const taxAmount = computeTaxAmount(
        remaining.map(l => ({ amount: Number(l.amount), isTaxable: l.isTaxable })),
        Number(invoice.taxRate),
      );
      inv = await tx.invoice.update({
        where: { id: invoice.id, status: 'draft' },
        data: { subtotal, taxAmount, total: subtotal + taxAmount },
      });
    }
    await kickTicketsToApprovals(tx, [ticket], note, userId, actor?.name || null);
    return { inv, ticket, voided };
  });

  await createAuditLog({
    userId, entityType: 'invoice', entityId: invoice.id,
    action: voided ? 'status_change' : 'update',
    changes: { ...(voided ? { from: 'draft', to: 'void' } : {}), reason: note, kickedBackTickets: [ticket.id] },
    ipAddress: req.ip,
  });
  await afterKickBack([ticket], note, userId, invoice.invoiceNumber, req.ip);

  res.json({ ...inv, kickedBackTickets: [ticket.ticketNumber], voided });
});

// ============================================================
// PATCH /:id/reject — two meanings, by current status:
//   approved → un-approve back to draft for editing (reason optional).
//   draft    → the billing itself is wrong: void the draft and kick its source
//              tickets back to the Approvals dashboard (supervisor_review) with
//              the reason as the reviewer's note. Draft → draft used to be the
//              behaviour here, which changed nothing the user could see and
//              left the tickets invoiceable a second time off the Ready queue.
// ============================================================

invoicesRouter.patch('/:id/reject', async (req: Request, res: Response) => {
  const { reason } = req.body;
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    select: {
      id: true, status: true, invoiceNumber: true, internalNotes: true,
      lineItems: { select: { sourceTicketId: true }, distinct: ['sourceTicketId'] },
    },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status !== 'draft' && invoice.status !== 'approved') {
    throw new AppError(400, `Cannot reject invoice in status '${invoice.status}'`);
  }

  if (invoice.status === 'draft') {
    const note = typeof reason === 'string' ? reason.trim() : '';
    if (!note) throw new AppError(400, 'A note for the reviewer is required to kick a draft back to Approvals');
    // This voids the draft, so it needs the same capability as PATCH /:id/void.
    if (!roleHasCapability(req.user?.role, 'invoices:cancel')) {
      throw new AppError(403, 'Rejecting a draft voids it — your role cannot void invoices');
    }
    const ticketIds = invoice.lineItems.map(li => li.sourceTicketId).filter((id): id is string => !!id);
    if (!ticketIds.length) {
      throw new AppError(400, 'This draft was not built from tickets, so there is nothing to send to Approvals. Void it instead.');
    }
    const userId = req.user!.userId;
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });

    const { inv, kicked, stillBilled } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM service_tickets WHERE id IN (${Prisma.join(ticketIds)}) ORDER BY id FOR UPDATE`);
      const voidNote = `Rejected to Approvals: ${note}`;
      const inv = await tx.invoice.update({
        where: { id: invoice.id, status: 'draft' },
        data: {
          status: 'void',
          rejectedById: userId,
          rejectedAt: new Date(),
          rejectionReason: note,
          internalNotes: invoice.internalNotes ? `${invoice.internalNotes}\n\n${voidNote}` : voidNote,
        },
      });
      // A training class has one invoice per employer: a ticket still carried
      // by another live invoice can't go back for review underneath it.
      const surviving = await tx.invoice.findMany({
        where: { status: { not: 'void' }, lineItems: { some: { sourceTicketId: { in: ticketIds } } } },
        select: { lineItems: { select: { sourceTicketId: true } } },
      });
      const billed = new Set(surviving.flatMap(i => i.lineItems.map(li => li.sourceTicketId)));
      // 'billing_queue' too: an earlier un-approve may already have released them.
      const tickets = await tx.serviceTicket.findMany({
        where: { id: { in: ticketIds }, status: { in: ['invoiced', 'billing_queue'] } },
        select: { id: true, ticketNumber: true, status: true, customData: true },
      });
      const kicked = tickets.filter(t => !billed.has(t.id));
      await kickTicketsToApprovals(tx, kicked, note, userId, actor?.name || null);
      return { inv, kicked, stillBilled: tickets.filter(t => billed.has(t.id)) };
    });

    await createAuditLog({
      userId, entityType: 'invoice', entityId: invoice.id, action: 'status_change',
      changes: { from: 'draft', to: 'void', reason: note, kickedBackTickets: kicked.map(t => t.id) },
      ipAddress: req.ip,
    });
    await afterKickBack(kicked, note, userId, invoice.invoiceNumber, req.ip);

    const warnings = stillBilled.length
      ? [`Not kicked back — still on another live invoice: ${stillBilled.map(t => t.ticketNumber).join(', ')}`]
      : [];
    return res.json({ ...inv, kickedBackTickets: kicked.map(t => t.ticketNumber), warnings });
  }

  // Approved → draft. The source tickets stay 'invoiced' and stay on this
  // draft: it still holds their lines, so releasing them to Ready (as this
  // used to) let the same tickets be invoiced a second time. To send tickets
  // back, reject the draft or kick back a single ticket from it.
  const updated = await prisma.invoice.update({
    where: { id: invoice.id, status: invoice.status },
    data: {
      status: 'draft',
      rejectedById: req.user?.userId,
      rejectedAt: new Date(),
      rejectionReason: reason || null,
      // Clear approval if it was approved
      approvedById: null,
      approvedAt: null,
    },
  });

  await createAuditLog({
    userId: req.user?.userId,
    entityType: 'invoice',
    entityId: invoice.id,
    action: 'status_change',
    changes: { from: invoice.status, to: 'draft', reason },
    ipAddress: req.ip,
  });

  res.json(updated);
});

// ============================================================
// PATCH /:id/queue — Queue approved invoice for QBWC push
// ============================================================

invoicesRouter.patch('/:id/queue', async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    include: {
      lineItems: {
        orderBy: { sortOrder: 'asc' },
        include: { product: { select: { qbItemListId: true, qbItemFullName: true } } },
      },
      company: { select: { qbCustomerListId: true, qbCustomerFullName: true } },
    },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status !== 'approved') {
    throw new AppError(400, `Invoice must be approved before queuing (current: ${invoice.status})`);
  }

  // Product policy: retain no-charge records locally (including training
  // attendees and inspection serials) without creating an accounting job.
  const billableTotal = invoice.lineItems.reduce((s, li) => s + parseFloat(li.amount.toString()), 0);
  if (billableTotal <= 0) {
    console.log(`[Invoice] $0 total — recording ${invoice.invoiceNumber} without QB push (inspection/visual only)`);
    const note = 'Recorded — $0 total (no-charge record), QB push skipped';
    const updated = await prisma.invoice.update({
      where: { id: invoice.id, status: invoice.status },
      data: {
        status: 'invoiced',
        internalNotes: invoice.internalNotes ? `${invoice.internalNotes}\n\n${note}` : note,
      },
    });
    await createAuditLog({
      userId: (req as any).user?.id,
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'status_change',
      changes: { from: 'approved', to: 'invoiced', zeroTotal: true, qbSkipped: true },
      ipAddress: req.ip,
    });
    return res.json(updated);
  }

  // ── Pre-queue validation: ensure QB mappings exist ──
  const validationErrors: { customer?: string; unmappedLines: string[] } = { unmappedLines: [] };

  // 1) Customer must have QB mapping
  if (!invoice.company?.qbCustomerListId && !invoice.company?.qbCustomerFullName) {
    validationErrors.customer = `Company "${invoice.companyName}" has no QuickBooks customer mapping`;
  }

  // 2) All billable lines (amount > 0) must have QB item mapping
  for (const li of invoice.lineItems) {
    const amt = parseFloat(li.amount.toString());
    if (amt > 0) {
      const hasMapping = li.qbItemFullName || li.product?.qbItemFullName;
      if (!hasMapping) {
        validationErrors.unmappedLines.push(
          `Line ${li.lineNumber}: "${li.description.split(/\r?\n/, 1)[0]}" (Part# ${li.partNumber || 'none'}) — no QB item mapping`
        );
      }
    }
  }

  // 3) Must have at least one billable line
  const billableCount = invoice.lineItems.filter(li => parseFloat(li.amount.toString()) > 0).length;
  if (billableCount === 0) {
    validationErrors.unmappedLines.push('No billable line items (all lines are $0)');
  }

  if (validationErrors.customer || validationErrors.unmappedLines.length > 0) {
    return res.status(400).json({
      error: 'QB mapping validation failed',
      validationErrors,
    });
  }

  // Create QB sync queue entry. All invoices post a real QB Invoice directly
  // (InvoiceAdd). The legacy per-customer SalesOrder opt-in has been retired —
  // qbUsesSalesOrder is no longer consulted (kept on the model only so any
  // in-flight so_created invoices can still complete their conversion poll).
  const updated = await prisma.$transaction(async tx => {
    // Claim the approved invoice before publishing the job; a concurrent waiver
    // changes it to void, so this transaction must fail rather than resurrect it.
    const claimed = await tx.invoice.updateMany({ where: { id: invoice.id, status: 'approved' }, data: { status: 'queued' } });
    if (claimed.count !== 1) throw new AppError(409, 'Invoice changed; refresh before queuing');
    await tx.qbSyncQueue.create({ data: { entityType: 'invoice', entityId: invoice.id, action: 'add', status: 'pending', priority: 3 } });
    return tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  });

  await createAuditLog({
    userId: (req as any).user?.id,
    entityType: 'invoice',
    entityId: invoice.id,
    action: 'status_change',
    changes: { from: 'approved', to: 'queued', queuedForQB: true },
    ipAddress: req.ip,
  });

  res.json(updated);
});

// ============================================================
// PATCH /:id/so-created — Record that QB Sales Order was created
// (Called by QBWC response handler)
// ============================================================

invoicesRouter.patch('/:id/so-created', async (req: Request, res: Response) => {
  const { qbSalesOrderTxnId, qbSalesOrderNumber } = req.body;
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status === 'void') throw new AppError(409, 'A void invoice cannot enter billing');

  const updated = await prisma.invoice.update({
    where: { id: invoice.id, status: invoice.status },
    data: {
      status: 'so_created',
      qbSalesOrderTxnId: qbSalesOrderTxnId || null,
      qbSalesOrderNumber: qbSalesOrderNumber || null,
      qbSalesOrderPushedAt: new Date(),
    },
  });

  await createAuditLog({
    userId: (req as any).user?.id,
    entityType: 'invoice',
    entityId: invoice.id,
    action: 'status_change',
    changes: { from: invoice.status, to: 'so_created', qbSalesOrderNumber },
    ipAddress: req.ip,
  });

  res.json(updated);
});

// ============================================================
// PATCH /:id/invoiced — Record that SO was converted to Invoice in QB
// (Called by QBWC query handler or manual entry)
// ============================================================

invoicesRouter.patch('/:id/invoiced', async (req: Request, res: Response) => {
  const { qbInvoiceTxnId, qbInvoiceNumber } = req.body;
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status === 'void') throw new AppError(409, 'A void invoice cannot enter billing');

  const updated = await prisma.invoice.update({
    where: { id: invoice.id, status: invoice.status },
    data: {
      status: 'invoiced',
      qbInvoiceTxnId: qbInvoiceTxnId || null,
      qbInvoiceNumber: qbInvoiceNumber || null,
      qbInvoiceCreatedAt: new Date(),
    },
  });

  await createAuditLog({
    userId: (req as any).user?.id,
    entityType: 'invoice',
    entityId: invoice.id,
    action: 'status_change',
    changes: { from: invoice.status, to: 'invoiced', qbInvoiceNumber },
    ipAddress: req.ip,
  });

  res.json(updated);
});

// ============================================================
// PATCH /:id/void — Void an invoice (billing/AR + platform_admin only)
//
// Mirrors the ticket-void retraction in routes/tickets.ts POST /:id/void: if
// the invoice is still PRE-QuickBooks (draft/approved/awaiting_signature, or
// queued whose QBWC sync entry hasn't transmitted yet) we also (a) skip any
// un-sent QbSyncQueue entry so it can't still be pushed, and (b) reset the
// invoice's source tickets back to billing_queue so their billing isn't lost.
// Once the invoice has crossed into QB (qb txn ids set, so_created/invoiced/
// sent/paid, or a queued entry QBWC already transmitted) we can't pull it back
// over QBWC — the void still goes through, but cleanup is a manual QB concern.
// ============================================================

// Invoice statuses that mean "already in QuickBooks" — never auto-retract these.
const INVOICE_IN_QB_STATUSES = ['so_created', 'invoiced', 'sent', 'paid'];

invoicesRouter.patch('/:id/void',
  requirePermission('invoices:cancel'),
  async (req: Request, res: Response) => {
    const { reason, override } = req.body as { reason?: string; override?: boolean };
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id as string },
      select: {
        id: true, invoiceNumber: true, status: true, internalNotes: true,
        qbSalesOrderTxnId: true, qbInvoiceTxnId: true,
        lineItems: { select: { sourceTicketId: true }, distinct: ['sourceTicketId'] },
      },
    });
    if (!invoice) throw new AppError(404, 'Invoice not found');
    if (invoice.status === 'void') throw new AppError(400, 'Already voided');
    // A paid invoice is normally locked; the override flag lets a permitted role
    // void it anyway (QuickBooks/payment cleanup then becomes a manual concern).
    if (invoice.status === 'paid' && !override) {
      throw new AppError(409, 'Cannot void a paid invoice without override');
    }

    const warnings: string[] = [];

    const hitQb =
      !!invoice.qbSalesOrderTxnId ||
      !!invoice.qbInvoiceTxnId ||
      INVOICE_IN_QB_STATUSES.includes(invoice.status);
    if (hitQb) warnings.push('Invoice has reached QuickBooks — reverse it there manually.');
    if (invoice.status === 'paid') warnings.push('Invoice was paid — reconcile the payment manually.');

    // A `queued` invoice has a QBWC sync entry — only safe to pull back if QBWC
    // hasn't transmitted it yet (entry still pending/error).
    let qbwcInFlight = false;
    if (!hitQb && invoice.status === 'queued') {
      const transmitted = await prisma.qbSyncQueue.count({
        where: { entityId: invoice.id, status: { in: ['sent', 'success'] } },
      });
      qbwcInFlight = transmitted > 0;
    }
    const retract = !hitQb && !qbwcInFlight;

    const sourceTicketIds = invoice.lineItems
      .map(li => li.sourceTicketId)
      .filter((id): id is string => !!id);

    let releasedTickets: string[] = [];
    const updated = await prisma.$transaction(async (tx) => {
      if (retract && sourceTicketIds.length) {
        // Match the training generator's lock before changing invoice state.
        await tx.$queryRaw(Prisma.sql`SELECT id FROM service_tickets WHERE id IN (${Prisma.join(sourceTicketIds)}) ORDER BY id FOR UPDATE`);
      }
      const inv = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          status: 'void',
          internalNotes: invoice.internalNotes
            ? `${invoice.internalNotes}\n\nVoided: ${reason || 'No reason given'}`
            : `Voided: ${reason || 'No reason given'}`,
        },
      });

      if (retract) {
        // Skip any un-sent QBWC queue entry so it can't still be transmitted.
        await tx.qbSyncQueue.updateMany({
          where: { entityId: invoice.id, status: { in: ['pending', 'error'] } },
          data: { status: 'skipped' },
        });
        // A class can have one invoice per employer. Voiding one must not
        // offer the whole class for billing while other invoices remain live.
        if (sourceTicketIds.length) {
          const surviving = await tx.invoice.findMany({
            where: { status: { not: 'void' }, lineItems: { some: { sourceTicketId: { in: sourceTicketIds } } } },
            select: { lineItems: { select: { sourceTicketId: true } } },
          });
          const stillBilled = new Set(surviving.flatMap(i => i.lineItems.map(li => li.sourceTicketId)));
          releasedTickets = sourceTicketIds.filter(id => !stillBilled.has(id));
          if (releasedTickets.length) {
            await tx.serviceTicket.updateMany({
              where: { id: { in: releasedTickets }, status: 'invoiced' },
              data: { status: 'billing_queue' },
            });
          }
        }
      }

      return inv;
    });

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'status_change',
      changes: {
        from: invoice.status,
        to: 'void',
        reason,
        retracted: retract,
        releasedTickets,
      },
      ipAddress: req.ip,
    });

    res.json({ ...updated, warnings });
  });

// ============================================================
// PATCH /:id/unqueue — Pull a queued invoice back out of the QBWC queue
// (queued → approved). The undo for /:id/queue: skips the un-sent sync entry
// and reverts status so the invoice can be re-queued (or rejected to draft for
// edits). Refuses once QB has seen the invoice — a 'sent' entry may have
// posted even if no response was processed, so only pending/error entries are
// safe to retract. Tickets stay on the invoice (unlike reject/void).
// ============================================================

invoicesRouter.patch('/:id/unqueue', async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    select: {
      id: true, invoiceNumber: true, status: true,
      qbSalesOrderTxnId: true, qbInvoiceTxnId: true,
    },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status !== 'queued') {
    throw new AppError(400, `Only queued invoices can be pulled back (current: ${invoice.status})`);
  }
  if (invoice.qbSalesOrderTxnId || invoice.qbInvoiceTxnId) {
    throw new AppError(409, 'Invoice has already reached QuickBooks — reverse it there instead');
  }
  const inFlight = await prisma.qbSyncQueue.count({
    where: { entityId: invoice.id, entityType: 'invoice', status: { in: ['sent', 'success'] } },
  });
  if (inFlight > 0) {
    throw new AppError(409, 'QBWC has already transmitted this invoice — check QuickBooks before retrying');
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.qbSyncQueue.updateMany({
      where: { entityId: invoice.id, entityType: 'invoice', status: { in: ['pending', 'error'] } },
      data: { status: 'skipped' },
    });
    return tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'approved' },
    });
  });

  await createAuditLog({
    userId: (req as any).user?.id,
    entityType: 'invoice',
    entityId: invoice.id,
    action: 'status_change',
    changes: { from: 'queued', to: 'approved', unqueued: true },
    ipAddress: req.ip,
  });

  res.json(updated);
});

// ============================================================
// DELETE /:id — Permanently delete an invoice + its line items.
// Hard delete (unrecoverable); use PATCH /:id/void for the recoverable path.
// Requires a reason. A QB-synced invoice is normally locked; { override: true }
// lets a permitted role delete it anyway, with a cleanup warning.
// ============================================================
invoicesRouter.delete('/:id',
  requirePermission('invoices:delete'),
  async (req: Request, res: Response) => {
    const reason = (req.body?.reason || '').trim();
    const override = !!req.body?.override;
    if (!reason) throw new AppError(400, 'A reason is required to delete an invoice');

    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id as string },
      select: {
        id: true, invoiceNumber: true, status: true,
        qbSalesOrderTxnId: true, qbInvoiceTxnId: true,
        lineItems: { select: { sourceTicketId: true }, distinct: ['sourceTicketId'] },
      },
    });
    if (!invoice) throw new AppError(404, 'Invoice not found');

    const hitQb =
      !!invoice.qbSalesOrderTxnId ||
      !!invoice.qbInvoiceTxnId ||
      INVOICE_IN_QB_STATUSES.includes(invoice.status);
    if (hitQb && !override) {
      throw new AppError(409, 'Invoice has reached QuickBooks — deletion requires override');
    }

    const warnings: string[] = [];
    if (hitQb) warnings.push('Invoice had reached QuickBooks — reverse it there manually.');

    const sourceTicketIds = invoice.lineItems
      .map(li => li.sourceTicketId)
      .filter((id): id is string => !!id);

    await prisma.$transaction(async (tx) => {
      // Skip any un-sent QBWC queue entry so a deleted invoice can't be pushed.
      await tx.qbSyncQueue.updateMany({
        where: { entityId: invoice.id, status: { in: ['pending', 'error'] } },
        data: { status: 'skipped' },
      });
      // Release source tickets back into the Ready queue so their billing isn't lost.
      if (sourceTicketIds.length) {
        await tx.serviceTicket.updateMany({
          where: { id: { in: sourceTicketIds }, status: 'invoiced' },
          data: { status: 'billing_queue' },
        });
      }
      await tx.invoiceLineItem.deleteMany({ where: { invoiceId: invoice.id } });
      await tx.invoice.delete({ where: { id: invoice.id } });
    });

    await createAuditLog({
      userId: req.user?.userId,
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'delete',
      changes: { invoiceNumber: invoice.invoiceNumber, status: invoice.status, reason, override, releasedTickets: sourceTicketIds },
      ipAddress: req.ip,
    });

    res.json({ ok: true, invoiceNumber: invoice.invoiceNumber, warnings });
  });

// ============================================================
// PUT /:id — Update invoice (only drafts)
// ============================================================

invoicesRouter.put('/:id', async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status !== 'draft') {
    throw new AppError(400, 'Only draft invoices can be edited');
  }

  const { poNumber, afeNumber, costCenter, notes, internalNotes, dueDate } = req.body;

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      poNumber: poNumber !== undefined ? poNumber : invoice.poNumber,
      afeNumber: afeNumber !== undefined ? afeNumber : invoice.afeNumber,
      costCenter: costCenter !== undefined ? costCenter : invoice.costCenter,
      notes: notes !== undefined ? notes : invoice.notes,
      internalNotes: internalNotes !== undefined ? internalNotes : invoice.internalNotes,
      dueDate: dueDate ? new Date(dueDate) : invoice.dueDate,
    },
  });

  res.json(updated);
});

// ============================================================
// PUT /:id/line-items — Replace all line items (only drafts)
// ============================================================

invoicesRouter.put('/:id/line-items', async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    include: { lineItems: { select: { id: true, productId: true, qbItemListId: true, originalDescription: true, sourceTicketId: true } } },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status !== 'draft') {
    throw new AppError(400, 'Only draft invoices can have line items edited');
  }

  const { lineItems } = req.body;
  if (!lineItems || !Array.isArray(lineItems)) {
    throw new AppError(400, 'lineItems array is required');
  }

  // Validate new catalog selections before replacing any saved lines. Keep
  // existing inactive references so staff can still correct historical lines.
  const newProductIds = [...new Set<string>(lineItems.filter((li: any) => li.productId &&
    !invoice.lineItems.some(old => old.id === li.id && old.productId === li.productId)
  ).map((li: any) => li.productId))];
  if (newProductIds.length) {
    const activeProducts = await prisma.product.findMany({
      where: { id: { in: newProductIds }, isActive: true }, select: { id: true },
    });
    if (activeProducts.length !== newProductIds.length) {
      throw new AppError(400, 'Inactive or missing parts cannot be added to invoices; choose an active part');
    }
  }

  // One live invoice per ticket: a ticket this edit newly attaches must not
  // already be on another live invoice. Tickets the draft already carries are
  // not re-checked (a training class is legitimately on one draft per employer).
  const alreadyHere = new Set(invoice.lineItems.map(old => old.sourceTicketId).filter(Boolean));
  const addedTicketIds = [...new Set<string>(lineItems.map((li: any) => li.sourceTicketId)
    .filter((id: unknown): id is string => typeof id === 'string' && !!id && !alreadyHere.has(id)))];
  await assertTicketsNotOnLiveInvoice(prisma, addedTicketIds, invoice.id);

  // Delete existing and re-create
  await prisma.invoiceLineItem.deleteMany({ where: { invoiceId: invoice.id } });

  const created = await Promise.all(
    lineItems.map((li: any, idx: number) =>
      prisma.invoiceLineItem.create({
        data: {
          invoiceId: invoice.id,
          lineNumber: idx + 1,
          description: li.description || '',
          originalDescription: invoice.lineItems.find(old => old.id === li.id && old.qbItemListId === li.qbItemListId)?.originalDescription ?? null,
          productId: li.productId || null,
          partNumber: li.partNumber || null,
          quantity: li.quantity || 1,
          unitOfMeasure: li.unitOfMeasure || 'EA',
          rate: li.rate || 0,
          amount: li.amount || (li.quantity || 1) * (li.rate || 0),
          isTaxable: li.isTaxable || false,
          sourceTicketId: li.sourceTicketId || null,
          sourceTicketNumber: li.sourceTicketNumber || null,
          sourceShopItemId: li.sourceShopItemId || null,
          sourceRentalItemId: li.sourceRentalItemId || null,
          qbItemListId: li.qbItemListId || null,
          qbItemFullName: li.qbItemFullName || null,
          sortOrder: idx,
          notes: li.notes || null,
        },
      })
    )
  );

  // Recalculate totals — tax recomputes from the invoice's frozen rate against
  // whichever lines are now flagged taxable.
  const subtotal = created.reduce((sum, li) => sum + parseFloat(li.amount.toString()), 0);
  const taxRate = Number(invoice.taxRate);
  const taxAmount = computeTaxAmount(
    created.map(li => ({ amount: Number(li.amount), isTaxable: li.isTaxable })),
    taxRate,
  );
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { subtotal, taxAmount, total: subtotal + taxAmount },
  });

  res.json({ lineItems: created });
});

// PATCH /:id/tax-jurisdiction — change the jurisdiction on a draft invoice.
// Re-snapshots the rate and recomputes tax + total from the current lines.
invoicesRouter.patch('/:id/tax-jurisdiction', async (req: Request, res: Response) => {
  const { taxJurisdictionId } = req.body as { taxJurisdictionId: string | null };

  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id as string },
    include: { lineItems: { select: { amount: true, isTaxable: true } } },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status !== 'draft') {
    throw new AppError(400, 'Only draft invoices can change tax jurisdiction');
  }

  const jurisdiction = await getJurisdictionRate(taxJurisdictionId);
  if (taxJurisdictionId && !jurisdiction) {
    throw new AppError(400, `Unknown tax jurisdiction: ${taxJurisdictionId}`);
  }
  const taxRate = jurisdiction?.rate ?? 0;
  const taxAmount = computeTaxAmount(
    invoice.lineItems.map(li => ({ amount: Number(li.amount), isTaxable: li.isTaxable })),
    taxRate,
  );
  const subtotal = Number(invoice.subtotal);

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      taxJurisdictionId: jurisdiction?.id ?? null,
      taxRate,
      taxAmount,
      total: subtotal + taxAmount,
    },
  });

  res.json(updated);
});

// DEV ONLY: Override invoice status — skips all validation. Gated by NODE_ENV + platform_admin.
invoicesRouter.patch('/:id/dev-override-status', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Dev override not available in production' });
  }
  if (req.user?.role !== 'platform_admin') {
    return res.status(403).json({ error: 'Dev override requires platform_admin' });
  }

  const { id } = req.params;
  const { status } = req.body as { status: InvoiceStatus };

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const invoice = await prisma.invoice.findUnique({ where: { id: id as string } });
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  const updated = await prisma.invoice.update({
    where: { id: id as string },
    data: { status },
  });

  await createAuditLog({
    userId: req.user!.userId,
    entityType: 'invoice',
    entityId: id as string,
    action: 'update',
    changes: { devOverride: true, from: invoice.status, to: status },
    ipAddress: req.ip,
  });

  res.json(updated);
});
