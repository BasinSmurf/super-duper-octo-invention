import { Router, Request, Response } from 'express';
import { resolvePriceLevelRate } from '../services/billingRules.js';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';

export const companiesRouter = Router();

// GET /api/companies — list companies (with search)
companiesRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const { search, type, active, parent, limit = '50', offset = '0' } = req.query;

    const where: any = {};
    if (search) {
      where.name = { contains: search as string, mode: 'insensitive' };
    }
    if (type) {
      where.companyType = type as string;
    }
    if (active !== undefined) {
      where.isActive = active === 'true';
    }
    if (parent === 'null') {
      where.parentCompanyId = null;
    } else if (parent) {
      where.parentCompanyId = parent as string;
    }

    const [companies, total] = await Promise.all([
      prisma.company.findMany({
        where,
        include: {
          parentCompany: { select: { id: true, name: true } },
          childCompanies: { select: { id: true, name: true, companyType: true, isActive: true } },
          _count: { select: { billingProfiles: true, contacts: true } },
        },
        orderBy: { name: 'asc' },
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.company.count({ where }),
    ]);

    // Enrich each company with the names of oilfields where it operates pads.
    // Drives the field-names pills on customer lookup cards.
    const companyIds = companies.map(c => c.id);
    const fieldNamesByCompany = new Map<string, string[]>();
    if (companyIds.length > 0) {
      const rows = await prisma.pad.findMany({
        where: { currentOperatorId: { in: companyIds } },
        select: { currentOperatorId: true, field: { select: { name: true } } },
      });
      for (const row of rows) {
        if (!row.currentOperatorId || !row.field) continue;
        const list = fieldNamesByCompany.get(row.currentOperatorId) ?? [];
        if (!list.includes(row.field.name)) list.push(row.field.name);
        fieldNamesByCompany.set(row.currentOperatorId, list);
      }
    }
    const enriched = companies.map(c => ({
      ...c,
      assignedFieldNames: (fieldNamesByCompany.get(c.id) ?? []).sort(),
    }));

    res.json({ data: enriched, total, limit: parseInt(limit as string, 10), offset: parseInt(offset as string, 10) });
  } catch (err) {
    next(err);
  }
});

// GET /api/companies/:id
// GET /api/companies/price-levels — list active QB price levels for the
// dropdown on CompanyDetailPage. Defined BEFORE /:id so the literal path
// matches first. Open to anyone authenticated; mutating happens via
// PUT /:id which requires customers:manage.
companiesRouter.get('/price-levels', async (_req: Request, res: Response, next) => {
  try {
    const levels = await prisma.priceLevel.findMany({
      where: { isActive: true },
      include: { _count: { select: { items: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({
      data: levels.map(pl => ({
        id: pl.id,
        name: pl.name,
        qbListId: pl.qbListId,
        qbCustomerName: pl.qbCustomerName,
        itemCount: pl._count.items,
        lastSyncedAt: pl.lastSyncedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/companies/:id/price-level — the ONE pricebook that applies to this
// customer, item rules and all, in the shape the client resolver takes.
//
// Field-mobile roles read this out of their offline catalog instead (the
// `priceLevels` sync table). Office and shop roles never get a Dexie hydrate at
// all (ADR-0005 keys offline on role mobility), and they are precisely the
// people keying shop labor rates — so they need it over the wire, or the shop
// screens would quote list to a contract customer while the field screens
// didn't. Also defined BEFORE /:id so the literal segment matches first.
companiesRouter.get('/:id/price-level', async (req: Request, res: Response, next) => {
  try {
    const company = await prisma.company.findUnique({
      where: { id: req.params.id as string },
      select: { qbPriceLevelId: true },
    });
    if (!company) throw new AppError(404, 'Company not found');
    if (!company.qbPriceLevelId) return res.json({ data: null });

    const level = await prisma.priceLevel.findFirst({
      where: { id: company.qbPriceLevelId, isActive: true },
      include: { items: true },
    });
    if (!level) return res.json({ data: null });

    res.json({
      data: {
        id: level.id,
        name: level.name,
        isActive: level.isActive,
        qbCustomerListId: level.qbCustomerListId,
        qbCustomerName: level.qbCustomerName,
        updatedAt: level.updatedAt,
        items: level.items.map(it => ({
          qbItemListId: it.qbItemListId,
          qbItemFullName: it.qbItemFullName,
          customPrice: it.customPrice == null ? null : Number(it.customPrice),
          adjustPercent: it.adjustPercent == null ? null : Number(it.adjustPercent),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

companiesRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const company = await prisma.company.findUnique({
      where: { id: req.params.id as string },
      include: {
        parentCompany: { select: { id: true, name: true } },
        childCompanies: { select: { id: true, name: true, companyType: true, isActive: true } },
        operatorAliases: true,
        billingProfiles: { where: { isActive: true }, orderBy: { effectiveFrom: 'desc' } },
        contacts: { where: { isActive: true }, orderBy: { isPrimary: 'desc' } },
        assignedPriceLevel: {
          select: { id: true, name: true, qbListId: true, isActive: true, _count: { select: { items: true } } },
        },
        rentalBoms: {
          where: { isActive: true },
          include: BOM_INCLUDE,
          orderBy: { bomType: 'asc' },
        },
      },
    });
    if (!company) throw new AppError(404, 'Company not found');

    // Roll up child operator assets so parent customer pages can show
    // "Petro Hunt LLC has 0 direct, but 14 across Dakota + Little Knife".
    // Skips the second query when there are no children.
    let enrichedChildCompanies = company.childCompanies as Array<{
      id: string;
      name: string;
      companyType: string;
      isActive: boolean;
      padCount?: number;
      wellCount?: number;
      assignedFieldNames?: string[];
    }>;
    if (enrichedChildCompanies.length > 0) {
      const childIds = enrichedChildCompanies.map(c => c.id);
      const [padRows, wellCounts] = await Promise.all([
        prisma.pad.findMany({
          where: { currentOperatorId: { in: childIds } },
          select: { currentOperatorId: true, field: { select: { name: true } } },
        }),
        prisma.well.groupBy({
          by: ['currentOperatorId'],
          where: { currentOperatorId: { in: childIds } },
          _count: { _all: true },
        }),
      ]);

      const padCountByChild = new Map<string, number>();
      const fieldsByChild = new Map<string, Set<string>>();
      for (const row of padRows) {
        if (!row.currentOperatorId) continue;
        padCountByChild.set(row.currentOperatorId, (padCountByChild.get(row.currentOperatorId) ?? 0) + 1);
        if (row.field?.name) {
          const set = fieldsByChild.get(row.currentOperatorId) ?? new Set<string>();
          set.add(row.field.name);
          fieldsByChild.set(row.currentOperatorId, set);
        }
      }
      const wellCountByChild = new Map<string, number>();
      for (const w of wellCounts) {
        if (w.currentOperatorId) wellCountByChild.set(w.currentOperatorId, w._count._all);
      }

      enrichedChildCompanies = enrichedChildCompanies.map(c => ({
        ...c,
        padCount: padCountByChild.get(c.id) ?? 0,
        wellCount: wellCountByChild.get(c.id) ?? 0,
        assignedFieldNames: Array.from(fieldsByChild.get(c.id) ?? []).sort(),
      }));
    }

    res.json({ ...company, childCompanies: enrichedChildCompanies });
  } catch (err) {
    next(err);
  }
});

// POST /api/companies
companiesRouter.post('/', requirePermission('customers:manage'), async (req: Request, res: Response, next) => {
  try {
    const company = await prisma.company.create({ data: req.body });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'company',
      entityId: company.id,
      action: 'create',
      changes: req.body,
      ipAddress: req.ip,
    });

    res.status(201).json(company);
  } catch (err) {
    next(err);
  }
});

// PUT /api/companies/:id
companiesRouter.put('/:id', requirePermission('customers:manage'), async (req: Request, res: Response, next) => {
  try {
    const existing = await prisma.company.findUnique({ where: { id: req.params.id as string } });
    if (!existing) throw new AppError(404, 'Company not found');

    const company = await prisma.company.update({
      where: { id: req.params.id as string },
      data: req.body,
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'company',
      entityId: company.id,
      action: 'update',
      changes: { before: existing, after: company },
      ipAddress: req.ip,
    });

    res.json(company);
  } catch (err) {
    next(err);
  }
});

// POST /api/companies/quick-create — create a minimal walk-in customer
companiesRouter.post('/quick-create', async (req: Request, res: Response, next) => {
  try {
    const { name, phone, email, contactName } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new AppError(400, 'Company name is required');
    }

    const company = await prisma.company.create({
      data: {
        name: name.trim(),
        companyType: 'customer',
        isActive: true,
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        customData: { sourceType: 'walk_in', createdVia: 'shop_intake' },
      },
    });

    // If a contact name was provided, create a primary contact record
    if (contactName?.trim()) {
      await prisma.customerContact.create({
        data: {
          companyId: company.id,
          name: contactName.trim(),
          phone: phone?.trim() || null,
          email: email?.trim() || null,
          role: 'ordering',
          isPrimary: true,
        },
      });
    }

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'company',
      entityId: company.id,
      action: 'create',
      changes: { ...req.body, sourceType: 'walk_in' },
      ipAddress: req.ip,
    });

    res.status(201).json(company);
  } catch (err) {
    next(err);
  }
});

// --- Operator Aliases ---

// POST /api/companies/:id/aliases
companiesRouter.post('/:id/aliases', requirePermission('customers:manage'), async (req: Request, res: Response, next) => {
  try {
    const alias = await prisma.operatorAlias.create({
      data: { ...req.body, companyId: req.params.id as string },
    });
    res.status(201).json(alias);
  } catch (err) {
    next(err);
  }
});

// --- Billing Profiles ---

// GET /api/companies/:id/billing-profiles
companiesRouter.get('/:id/billing-profiles', async (req: Request, res: Response, next) => {
  try {
    const profiles = await prisma.customerBillingProfile.findMany({
      where: { companyId: req.params.id as string },
      orderBy: { effectiveFrom: 'desc' },
    });
    res.json(profiles);
  } catch (err) {
    next(err);
  }
});

// POST /api/companies/:id/billing-profiles
companiesRouter.post('/:id/billing-profiles', requirePermission('billing:profiles'), async (req: Request, res: Response, next) => {
  try {
    // signatureMethod is a vestige of the reverted BlueInk eSign feature; it has
    // no column on CustomerBillingProfile, so passing it to Prisma 500s. Strip it.
    const { signatureMethod: _ignoredSignatureMethod, ...body } = req.body ?? {};
    const profile = await prisma.customerBillingProfile.create({
      data: {
        ...body,
        companyId: req.params.id as string,
        createdById: req.user!.userId,
      },
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'customer_billing_profile',
      entityId: profile.id,
      action: 'create',
      changes: req.body,
      ipAddress: req.ip,
    });

    res.status(201).json(profile);
  } catch (err) {
    next(err);
  }
});

// PUT /api/companies/:companyId/billing-profiles/:id
companiesRouter.put('/:companyId/billing-profiles/:id', requirePermission('billing:profiles'), async (req: Request, res: Response, next) => {
  try {
    // See POST above — strip the orphaned signatureMethod field before Prisma.
    const { signatureMethod: _ignoredSignatureMethod, ...body } = req.body ?? {};
    const profile = await prisma.customerBillingProfile.update({
      where: { id: req.params.id as string },
      data: body,
    });
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

// --- Rental BOMs (per-customer Bill of Materials) ---
// The baseline gear a customer's flat rig-up + daily rate covers. GET is open to any authenticated user — field supers need to see
// what a job must deploy — but mutations require billing:profiles, since AR
// files the agreements. Change history lands in audit_log; owner = createdBy.

// Both the customer-profile editor and dispatch read BOMs, and dispatch needs
// enough of the bound Products to seed a rate without a second round-trip:
// the rental rates by unit, plus the QB mapping the price level keys on.
const BOM_PRODUCT_SELECT = {
  id: true, name: true, partNumber: true, category: true,
  qbItemListId: true, qbItemFullName: true,
  defaultRentalRateDaily: true, defaultRentalRateWeekly: true, defaultRentalRateMonthly: true,
  // The QB price — what the real catalog actually prices rentals with.
  defaultSellPrice: true,
} as const;

const BOM_INCLUDE = {
  packageProduct: { select: BOM_PRODUCT_SELECT },
  items: { orderBy: { sortOrder: 'asc' as const }, include: { product: { select: BOM_PRODUCT_SELECT } } },
};

/**
 * Attach what THIS customer pays for each package item.
 *
 * The package part is generic — its contents are defined per customer by the
 * BOM, its price by the customer's QuickBooks price level. Without this,
 * dispatch would quote list price to everyone and the invoice would later bill
 * the negotiated rate, so the quote and the bill would disagree. Resolved
 * through the same helper the invoice uses, so they can't drift.
 *
 * Null `packageRate` means no level touches the item — list price stands.
 */
async function attachPackagePricing<T extends { packageProductId: string | null; packageProduct?: { qbItemListId: string | null; defaultSellPrice: unknown } | null }>(
  companyId: string,
  boms: T[],
): Promise<(T & { packageRate: number | null; packagePriceLevel: string | null })[]> {
  const needsPricing = boms.some(b => b.packageProductId);
  const company = needsPricing
    ? await prisma.company.findUnique({ where: { id: companyId }, select: { qbPriceLevelId: true } })
    : null;
  const levels = company?.qbPriceLevelId
    ? await prisma.priceLevel.findMany({
        where: { id: company.qbPriceLevelId, isActive: true },
        include: { items: true },
      })
    : [];
  const ctxLevels = levels.map(pl => ({
    id: pl.id,
    name: pl.name,
    items: pl.items.map(i => ({
      qbItemListId: i.qbItemListId,
      customPrice: i.customPrice == null ? null : Number(i.customPrice),
      adjustPercent: i.adjustPercent == null ? null : Number(i.adjustPercent),
    })),
  }));

  return boms.map(b => {
    const list = Number(b.packageProduct?.defaultSellPrice ?? 0);
    const hit = resolvePriceLevelRate(ctxLevels, b.packageProduct?.qbItemListId, list);
    return { ...b, packageRate: hit?.rate ?? null, packagePriceLevel: hit?.priceLevelName ?? null };
  });
}

// GET /api/companies/:id/rental-boms
companiesRouter.get('/:id/rental-boms', async (req: Request, res: Response, next) => {
  try {
    const raw = await prisma.customerRentalBom.findMany({
      where: { companyId: req.params.id as string, isActive: true },
      include: BOM_INCLUDE,
      orderBy: { bomType: 'asc' },
    });
    const boms = await attachPackagePricing(req.params.id as string, raw);
    res.json(boms);
  } catch (err) {
    next(err);
  }
});

function normalizeBomItems(items: unknown): { equipmentCategory: string; label: string | null; qty: number; sortOrder: number; productId: string | null }[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it: any) => it && typeof it.equipmentCategory === 'string' && it.equipmentCategory.trim())
    .map((it: any, i: number) => ({
      equipmentCategory: String(it.equipmentCategory).trim(),
      label: it.label ? String(it.label) : null,
      qty: Number.isFinite(it.qty) && it.qty > 0 ? Math.trunc(it.qty) : 1,
      sortOrder: Number.isFinite(it.sortOrder) ? Math.trunc(it.sortOrder) : i,
      // Optional — prices an overage of this row. Blank string means "unbound",
      // not "product with an empty id", so normalize it to null.
      productId: typeof it.productId === 'string' && it.productId.trim() ? it.productId.trim() : null,
    }));
}

/** Normalize an optional product binding: '' / undefined → null. */
const normalizeProductId = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const RENTAL_BOM_TYPES = new Set(['standard', 'manned', 'unmanned', 'other', 'rig', 'drilling']);
const normalizeBomType = (v: unknown): any =>
  typeof v === 'string' && RENTAL_BOM_TYPES.has(v) ? v : 'standard';

// POST /api/companies/:id/rental-boms — one BOM per (customer, type).
companiesRouter.post('/:id/rental-boms', requirePermission('billing:profiles'), async (req: Request, res: Response, next) => {
  try {
    const { bomType, manned, includedTechs, notes, packageProductId } = req.body ?? {};
    const bom = await prisma.customerRentalBom.create({
      data: {
        companyId: req.params.id as string,
        bomType: normalizeBomType(bomType),
        manned: typeof manned === 'boolean' ? manned : true,
        includedTechs: Number.isFinite(includedTechs) && includedTechs >= 0 ? Math.trunc(includedTechs) : 0,
        notes: notes || null,
        packageProductId: normalizeProductId(packageProductId),
        createdById: req.user!.userId,
        items: { create: normalizeBomItems(req.body?.items) },
      },
      include: BOM_INCLUDE,
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'customer_rental_bom',
      entityId: bom.id,
      action: 'create',
      changes: req.body,
      ipAddress: req.ip,
    });

    res.status(201).json(bom);
  } catch (err) {
    next(err);
  }
});

// PUT /api/companies/:companyId/rental-boms/:id — updates fields and, when an
// `items` array is present, replaces the item set wholesale (simplest for a
// small edited list). bomType is immutable (it's the unique key).
companiesRouter.put('/:companyId/rental-boms/:id', requirePermission('billing:profiles'), async (req: Request, res: Response, next) => {
  try {
    const id = req.params.id as string;
    const { manned, includedTechs, notes, isActive, items, packageProductId } = req.body ?? {};

    const existing = await prisma.customerRentalBom.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'Rental BOM not found');

    const bom = await prisma.$transaction(async (tx) => {
      await tx.customerRentalBom.update({
        where: { id },
        data: {
          ...(typeof manned === 'boolean' ? { manned } : {}),
          ...(Number.isFinite(includedTechs) ? { includedTechs: Math.max(0, Math.trunc(includedTechs)) } : {}),
          ...(notes !== undefined ? { notes: notes || null } : {}),
          ...(typeof isActive === 'boolean' ? { isActive } : {}),
          ...(packageProductId !== undefined ? { packageProductId: normalizeProductId(packageProductId) } : {}),
        },
      });
      if (Array.isArray(items)) {
        await tx.customerRentalBomItem.deleteMany({ where: { bomId: id } });
        const rows = normalizeBomItems(items).map((it) => ({ ...it, bomId: id }));
        if (rows.length) await tx.customerRentalBomItem.createMany({ data: rows });
      }
      return tx.customerRentalBom.findUnique({ where: { id }, include: BOM_INCLUDE });
    });

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'customer_rental_bom',
      entityId: id,
      action: 'update',
      changes: req.body,
      ipAddress: req.ip,
    });

    res.json(bom);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/companies/:companyId/rental-boms/:id — hard delete (cascades to
// items). Hard, not soft: the (company, type) unique index would otherwise
// block re-creating the same type while a deactivated row lingered.
companiesRouter.delete('/:companyId/rental-boms/:id', requirePermission('billing:profiles'), async (req: Request, res: Response, next) => {
  try {
    const id = req.params.id as string;
    await prisma.customerRentalBom.delete({ where: { id } });
    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'customer_rental_bom',
      entityId: id,
      action: 'delete',
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Contacts ---

// GET /api/companies/:id/contacts
companiesRouter.get('/:id/contacts', async (req: Request, res: Response, next) => {
  try {
    const contacts = await prisma.customerContact.findMany({
      where: { companyId: req.params.id as string },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    });
    res.json(contacts);
  } catch (err) {
    next(err);
  }
});

// POST /api/companies/:id/contacts
companiesRouter.post('/:id/contacts', requirePermission('customers:manage'), async (req: Request, res: Response, next) => {
  try {
    const contact = await prisma.customerContact.create({
      data: { ...req.body, companyId: req.params.id as string },
    });
    res.status(201).json(contact);
  } catch (err) {
    next(err);
  }
});

// PUT /api/companies/:companyId/contacts/:id
companiesRouter.put('/:companyId/contacts/:id', requirePermission('customers:manage'), async (req: Request, res: Response, next) => {
  try {
    const contact = await prisma.customerContact.update({
      where: { id: req.params.id as string },
      data: req.body,
    });
    res.json(contact);
  } catch (err) {
    next(err);
  }
});
