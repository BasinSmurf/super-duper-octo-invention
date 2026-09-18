import { Router, Request, Response } from 'express';
import { Prisma } from '../db.js';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import { sendZpl } from '../services/printing.js';
import { equipmentLabelZpl, generateEquipmentBadgePdf } from '../services/equipmentLabel.js';

export const equipmentRouter = Router();

// ProductCategory is an enum, so it can't be `contains`-searched like free text.
// Instead we match the enum *values* whose name contains the search term
// (e.g. "monitor" → monitor_personal, monitor_area) and filter with `in`.
const PRODUCT_CATEGORIES = [
  'monitor_personal', 'monitor_area', 'supplied_air_component', 'sensor',
  'calibration_gas', 'accessory', 'consumable', 'assembly', 'labor', 'misc',
] as const;

function matchingCategories(term: string): string[] {
  const t = term.toLowerCase();
  return PRODUCT_CATEGORIES.filter(c => c.includes(t));
}

// ============================================================
// SERIALIZED EQUIPMENT
// ============================================================

// GET /api/equipment
equipmentRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const { search, status, productId, customerId, limit = '50', offset = '0' } = req.query;
    const where: any = {};
    if (search) {
      const s = search as string;
      where.OR = [
        { serialNumber: { contains: s, mode: 'insensitive' } },
        { safeCoreSerial: { contains: s, mode: 'insensitive' } },
        { product: { name: { contains: s, mode: 'insensitive' } } },
        { product: { partNumber: { contains: s, mode: 'insensitive' } } },
        { product: { description: { contains: s, mode: 'insensitive' } } },
      ];
      const cats = matchingCategories(s);
      if (cats.length) where.OR.push({ product: { category: { in: cats } } });
    }
    if (status) where.status = status as string;
    if (productId) where.productId = productId as string;
    if (customerId) where.currentCustomerId = customerId as string;

    const [equipment, total] = await Promise.all([
      prisma.serializedEquipment.findMany({
        where,
        include: {
          product: { select: { id: true, partNumber: true, name: true, category: true, isAssembly: true } },
          currentPad: { select: { id: true, name: true } },
          currentWell: { select: { id: true, wellName: true } },
          currentCustomer: { select: { id: true, name: true } },
          // Which rental a unit is out on. Filtering this list to `rented` or
          // `deployed` was already the "what gear is in use" view; without the
          // agreement it could only say THAT a unit was out, never on what —
          // which is the one thing you need in order to go get it back.
          currentRental: { select: { id: true, agreementNumber: true, status: true } },
          _count: { select: { childEquipment: true } },
        },
        orderBy: { serialNumber: 'asc' },
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.serializedEquipment.count({ where }),
    ]);
    res.json({ data: equipment, total });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ROUTES WITH FIXED PATHS — must be before /:id or Express
// matches the path segment as an :id parameter
// ============================================================

// GET /api/equipment/search-available — search equipment available for assignment
equipmentRouter.get('/search-available', async (req: Request, res: Response, next) => {
  try {
    const { q, excludeParentId, limit = '20' } = req.query;
    if (!q || (q as string).length < 1) return res.json({ data: [] });

    const qs = q as string;
    const where: any = {
      parentEquipmentId: null,
      status: 'available',
      OR: [
        { serialNumber: { contains: qs, mode: 'insensitive' } },
        { safeCoreSerial: { contains: qs, mode: 'insensitive' } },
        { product: { name: { contains: qs, mode: 'insensitive' } } },
        { product: { partNumber: { contains: qs, mode: 'insensitive' } } },
        { product: { description: { contains: qs, mode: 'insensitive' } } },
      ],
    };
    const availCats = matchingCategories(qs);
    if (availCats.length) where.OR.push({ product: { category: { in: availCats } } });

    if (excludeParentId) {
      where.id = { not: excludeParentId as string };
    }

    const results = await prisma.serializedEquipment.findMany({
      where,
      include: {
        product: { select: { id: true, partNumber: true, name: true, category: true, isAssembly: true } },
      },
      orderBy: { serialNumber: 'asc' },
      take: parseInt(limit as string, 10),
    });
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PARAMETERIZED ROUTES — /:id and below
// ============================================================

// GET /api/equipment/:id
equipmentRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const equipment = await prisma.serializedEquipment.findUnique({
      where: { id: req.params.id as string },
      include: {
        product: true,
        currentPad: true,
        currentWell: true,
        currentFacility: true,
        currentCustomer: true,
        currentRental: { select: { id: true, agreementNumber: true, status: true } },
        parentEquipment: {
          select: { id: true, serialNumber: true, product: { select: { name: true } } },
        },
        _count: {
          select: {
            childEquipment: true,
            lineItemsInstalled: true,
            lineItemsRemoved: true,
            rentalAgreementItems: true,
            repairOrders: true,
            shopWorkOrderItems: true,
          },
        },
      },
    });
    if (!equipment) throw new AppError(404, 'Equipment not found');
    res.json(equipment);
  } catch (err) {
    next(err);
  }
});

// GET /api/equipment/:id/badge.pdf — downloadable QR badge (any printer / laminate)
equipmentRouter.get('/:id/badge.pdf', async (req: Request, res: Response, next) => {
  try {
    const equipment = await prisma.serializedEquipment.findUnique({
      where: { id: req.params.id as string },
      select: { serialNumber: true, product: { select: { name: true } } },
    });
    if (!equipment) throw new AppError(404, 'Equipment not found');

    const doc = await generateEquipmentBadgePdf(equipment.serialNumber, equipment.product?.name ?? '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="badge-${equipment.serialNumber}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    next(err);
  }
});

// POST /api/equipment/:id/print-label — print the QR badge to a Zebra (ZD411)
equipmentRouter.post('/:id/print-label', async (req: Request, res: Response, next) => {
  try {
    const { printerId, copies } = req.body as { printerId?: string; copies?: number };
    if (!printerId) throw new AppError(400, 'printerId is required');

    const [equipment, printer] = await Promise.all([
      prisma.serializedEquipment.findUnique({
        where: { id: req.params.id as string },
        select: { serialNumber: true, product: { select: { name: true } } },
      }),
      prisma.printer.findUnique({ where: { id: printerId } }),
    ]);
    if (!equipment) throw new AppError(404, 'Equipment not found');
    if (!printer) throw new AppError(404, 'Printer not found');
    if (!printer.active) throw new AppError(400, 'Printer is inactive');

    const zpl = await equipmentLabelZpl(equipment.serialNumber, equipment.product?.name ?? '');
    const n = Math.min(Math.max(Number(copies) || 1, 1), 10);
    try {
      await sendZpl({ ipAddress: printer.ipAddress, port: printer.port }, zpl, n);
    } catch (e: any) {
      throw new AppError(502, e?.message || 'Printer unreachable');
    }

    console.log(`[equipment] badge for ${equipment.serialNumber} printed to ${printer.name} (x${n}) by ${req.user!.userId}`);
    res.json({ ok: true, printer: printer.name, copies: n });
  } catch (err) {
    next(err);
  }
});

// GET /api/equipment/:id/history — service history for detail page
equipmentRouter.get('/:id/history', async (req: Request, res: Response, next) => {
  try {
    const id = req.params.id as string;
    const [tickets, shopOrders, rentals, repairs] = await Promise.all([
      prisma.ticketLineItem.findMany({
        where: {
          OR: [
            { equipmentIdInstalled: id },
            { equipmentIdRemoved: id },
          ],
        },
        select: {
          id: true,
          lineType: true,
          description: true,
          createdAt: true,
          equipmentIdInstalled: true,
          equipmentIdRemoved: true,
          ticket: { select: { id: true, ticketNumber: true, serviceDate: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.shopWorkOrderItem.findMany({
        where: { serializedEquipmentId: id },
        select: {
          id: true,
          status: true,
          serviceType: true,
          createdAt: true,
          workOrder: { select: { id: true, workOrderNumber: true, status: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.rentalAgreementItem.findMany({
        where: { serializedEquipmentId: id },
        select: {
          id: true,
          status: true,
          deployedDate: true,
          returnedDate: true,
          rentalAgreement: { select: { id: true, agreementNumber: true, status: true } },
        },
        orderBy: { deployedDate: 'desc' },
        take: 50,
      }),
      prisma.repairOrder.findMany({
        where: { serializedEquipmentId: id },
        select: {
          id: true,
          repairNumber: true,
          status: true,
          reportedIssue: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    res.json({ tickets, shopOrders, rentals, repairs });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// TRAILER BUILD-OUT (parent/child assembly management)
// ============================================================

// GET /api/equipment/:id/children — list child equipment for an assembly
equipmentRouter.get('/:id/children', async (req: Request, res: Response, next) => {
  try {
    const children = await prisma.serializedEquipment.findMany({
      where: { parentEquipmentId: req.params.id as string },
      include: {
        product: { select: { id: true, partNumber: true, name: true, category: true, isAssembly: true } },
        _count: { select: { childEquipment: true } },
      },
      orderBy: { serialNumber: 'asc' },
    });
    res.json({ data: children });
  } catch (err) {
    next(err);
  }
});

// POST /api/equipment/:id/children/assign — assign child serials to a parent trailer
equipmentRouter.post('/:id/children/assign', requirePermission('inventory:manage'), async (req: Request, res: Response, next) => {
  try {
    const parentId = req.params.id as string;
    const { childIds } = req.body as { childIds: string[] };
    if (!childIds?.length) throw new AppError(400, 'childIds required');

    // Validate parent exists and is an assembly product
    const parent = await prisma.serializedEquipment.findUnique({
      where: { id: parentId },
      include: { product: { select: { id: true, isAssembly: true, name: true } } },
    });
    if (!parent) throw new AppError(404, 'Parent equipment not found');
    if (!parent.product.isAssembly) throw new AppError(400, 'Parent product is not an assembly');

    // Validate all children exist
    const children = await prisma.serializedEquipment.findMany({
      where: { id: { in: childIds } },
      select: { id: true, serialNumber: true, parentEquipmentId: true },
    });
    if (children.length !== childIds.length) {
      throw new AppError(400, `Some child IDs not found (expected ${childIds.length}, found ${children.length})`);
    }

    // Check none are assigned to a different parent
    const conflicting = children.filter(c => c.parentEquipmentId && c.parentEquipmentId !== parentId);
    if (conflicting.length > 0) {
      throw new AppError(400, `Equipment already assigned to another trailer: ${conflicting.map(c => c.serialNumber).join(', ')}`);
    }

    await prisma.serializedEquipment.updateMany({
      where: { id: { in: childIds } },
      data: { parentEquipmentId: parentId },
    });

    await createAuditLog({
      userId: req.user!.userId, entityType: 'serialized_equipment', entityId: parentId,
      action: 'update', changes: { action: 'assign_children', childIds },
      ipAddress: req.ip,
    });

    res.json({ success: true, assignedCount: childIds.length });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/equipment/:id/children/:childId — unlink a child from its parent trailer
equipmentRouter.delete('/:id/children/:childId', requirePermission('inventory:manage'), async (req: Request, res: Response, next) => {
  try {
    const parentId = req.params.id as string;
    const childId = req.params.childId as string;

    const child = await prisma.serializedEquipment.findUnique({
      where: { id: childId },
      select: { id: true, parentEquipmentId: true },
    });
    if (!child) throw new AppError(404, 'Child equipment not found');
    if (child.parentEquipmentId !== parentId) throw new AppError(400, 'Equipment is not assigned to this parent');

    await prisma.serializedEquipment.update({
      where: { id: childId },
      data: { parentEquipmentId: null },
    });

    await createAuditLog({
      userId: req.user!.userId, entityType: 'serialized_equipment', entityId: parentId,
      action: 'update', changes: { action: 'remove_child', childId },
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/equipment
equipmentRouter.post('/', requirePermission('inventory:manage'), async (req: Request, res: Response, next) => {
  try {
    const equipment = await prisma.serializedEquipment.create({ data: req.body });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'serialized_equipment', entityId: equipment.id,
      action: 'create', changes: req.body, ipAddress: req.ip,
    });
    res.status(201).json(equipment);
  } catch (err) {
    next(err);
  }
});

// POST /api/equipment/quick-create
//
// Counter-floor stop-gap until proper inventory tooling lands. Lets the walk-in
// rental flow (and anywhere else that opts in via the scanner's allowCreate
// prop) mint a SerializedEquipment for a serial that isn't in the system yet —
// caller types manufacturer + model, we find-or-create the Product behind the
// scenes so duplicate models converge on a single Product row.
equipmentRouter.post('/quick-create', async (req: Request, res: Response, next) => {
  try {
    const { manufacturer, model, serialNumber, category, purchaseDate } = req.body as {
      manufacturer?: string; model?: string; serialNumber?: string; category?: string; purchaseDate?: string;
    };

    const mfr = (manufacturer || '').trim();
    const mdl = (model || '').trim();
    const serial = (serialNumber || '').trim();
    if (!mfr || !mdl || !serial) {
      throw new AppError(400, 'manufacturer, model, and serialNumber are required');
    }

    // Reject upfront if this serial is already in the system — quick-create is
    // for unknown gear; if the serial exists the caller should use it directly.
    const existing = await prisma.serializedEquipment.findUnique({ where: { serialNumber: serial } });
    if (existing) {
      throw new AppError(409, `Serial ${serial} already exists`);
    }

    const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const partNumber = `WI-${slug(mfr)}-${slug(mdl)}`;
    const productName = `${mfr} ${mdl}`;
    const resolvedCategory = (category && /^(monitor_personal|monitor_area|supplied_air_component|sensor|calibration_gas|accessory|consumable|assembly|labor|misc)$/.test(category))
      ? category as 'monitor_personal'
      : 'monitor_personal';

    const product = await prisma.product.upsert({
      where: { partNumber },
      update: {},
      create: {
        partNumber,
        name: productName,
        description: `Walk-in quick-create — ${mfr}`,
        category: resolvedCategory,
        productType: 'rental',
        isSerialized: true,
        isActive: true,
      },
    });

    const resolvedPurchaseDate = purchaseDate && !isNaN(new Date(purchaseDate).getTime())
      ? new Date(purchaseDate)
      : undefined;

    const equipment = await prisma.serializedEquipment.create({
      data: {
        productId: product.id,
        serialNumber: serial,
        ownership: 'basin_safety',
        status: 'available',
        purchaseDate: resolvedPurchaseDate,
        // #21 field-added gear is usable immediately but flagged for office
        // review — the future equipment-approvals queue keys on this.
        customData: {
          quickAdded: {
            needsReview: true,
            byUserId: req.user!.userId,
            at: new Date().toISOString(),
          },
        },
      },
    });

    await createAuditLog({
      userId: req.user!.userId, entityType: 'serialized_equipment', entityId: equipment.id,
      action: 'create',
      changes: { quickCreate: true, manufacturer: mfr, model: mdl, serialNumber: serial, productId: product.id },
      ipAddress: req.ip,
    });

    // Match the shape the scanner consumes (equipment + product join)
    res.status(201).json({
      ...equipment,
      product: {
        id: product.id,
        partNumber: product.partNumber,
        name: product.name,
        category: product.category,
        productType: product.productType,
        isSerialized: product.isSerialized,
        isAssembly: product.isAssembly,
        defaultRentalRateDaily: product.defaultRentalRateDaily,
        defaultRentalRateWeekly: product.defaultRentalRateWeekly,
        defaultRentalRateMonthly: product.defaultRentalRateMonthly,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/equipment/:id
equipmentRouter.put('/:id', requirePermission('inventory:manage'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.serializedEquipment.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Equipment not found');

    const equipment = await prisma.serializedEquipment.update({
      where: { id: req.params.id as string },
      data: req.body,
    });

    // Track all editable fields that changed
    const trackFields = [
      'serialNumber', 'safeCoreSerial', 'ownership', 'status', 'currentCustomerId', 'currentPadId',
      'currentWellId', 'currentFacilityId', 'calibrationDueDate', 'lastCalibrationDate',
      'bumpTestDueDate', 'purchaseDate', 'warrantyExpiry', 'conditionNotes',
    ];
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const f of trackFields) {
      const oldVal = (existing as any)[f];
      const newVal = (equipment as any)[f];
      if (String(oldVal ?? '') !== String(newVal ?? '')) {
        changes[f] = { from: oldVal != null ? String(oldVal) : null, to: newVal != null ? String(newVal) : null };
      }
    }

    await createAuditLog({
      userId: req.user!.userId, entityType: 'serialized_equipment', entityId: equipment.id,
      action: 'update', changes: changes as unknown as Prisma.InputJsonValue, ipAddress: req.ip,
    });

    res.json(equipment);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/equipment/:id — soft-retire (sets status to 'retired')
equipmentRouter.delete('/:id', requirePermission('inventory:manage'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.serializedEquipment.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Equipment not found');
    if (existing.status === 'retired') throw new AppError(400, 'Equipment is already retired');

    const equipment = await prisma.serializedEquipment.update({
      where: { id: req.params.id as string },
      data: {
        status: 'retired',
        currentPadId: null,
        currentWellId: null,
        currentFacilityId: null,
        currentRentalId: null,
      },
    });

    await createAuditLog({
      userId: req.user!.userId, entityType: 'serialized_equipment', entityId: equipment.id,
      action: 'update',
      changes: { action: 'retire', previousStatus: existing.status },
      ipAddress: req.ip,
    });

    res.json(equipment);
  } catch (err) {
    next(err);
  }
});

