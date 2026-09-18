import { Router, Request, Response } from 'express';
import multer from 'multer';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import { getAllDefaults } from '../utils/servicePartMap.js';
import { partNumberFacetColumns } from '../utils/partNumber.js';
import { guessProductCategory, normalizeUoM } from '../services/qbItemMapping.js';
import { decodeHtmlEntities } from '../utils/htmlEntities.js';

export const productsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── QB CSV Import helpers (shared with prisma/import-qb-products.ts) ──

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

type ProductType = 'sale' | 'rental' | 'both' | 'service';
type QbItemType = 'inventory' | 'non_inventory' | 'service' | 'inventory_assembly' | 'other_charge';

const QB_TYPE_MAP: Record<string, { productType: ProductType; qbItemType: QbItemType }> = {
  'Service':            { productType: 'service',  qbItemType: 'service' },
  'Inventory Part':     { productType: 'sale',     qbItemType: 'inventory' },
  'Non-inventory Part': { productType: 'sale',     qbItemType: 'non_inventory' },
  'Inventory Assembly': { productType: 'sale',     qbItemType: 'inventory_assembly' },
  'Other Charge':       { productType: 'service',  qbItemType: 'other_charge' },
};

const SKIP_TYPES = new Set(['Discount', 'Group', 'Subtotal', 'Sales Tax Item', 'Sales Tax Group']);

// POST /api/products/import-qb-csv — upload QB item list CSV
productsRouter.post('/import-qb-csv', requirePermission('products:manage'), upload.single('file'), async (req: Request, res: Response, next) => {
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded');

    const raw = req.file.buffer.toString('utf-8');
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    const dataLines = lines.slice(1); // skip header

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    const errorSamples: string[] = [];

    for (const line of dataLines) {
      const cols = parseCSVLine(line);
      // Columns: [0]=empty, [1]=Active Status, [2]=Type, [3]=Item, [4]=Description,
      //          [5]=Sales Tax Code, [6]=Account, ..., [12]=U/M, [13]=Cost, ..., [16]=Price
      const activeStatus = cols[1] || '';
      const qbType = cols[2] || '';
      const partNumber = cols[3] || '';
      // QB encodes punctuation as HTML entities ("&#151;" em dash, "&amp;").
      // Decode before anything reads it: this string becomes the product name
      // that ends up on invoices, and guessProductCategory matches against it.
      const description = decodeHtmlEntities(cols[4] || '');
      const taxCode = cols[5] || '';
      const account = cols[6] || '';
      const uom = cols[12] || '';
      const costStr = cols[13] || '0';
      const priceStr = cols[16] || '0';
      const cost = parseFloat(costStr) || 0;
      const price = parseFloat(priceStr.replace('%', '')) || 0;

      if (activeStatus !== 'Active') { skipped++; continue; }
      if (SKIP_TYPES.has(qbType)) { skipped++; continue; }
      if (!partNumber) { skipped++; continue; }

      const typeMapping = QB_TYPE_MAP[qbType];
      if (!typeMapping) { skipped++; continue; }

      const category = guessProductCategory({
        description,
        account,
        isAssembly: qbType === 'Inventory Assembly',
        isPart: qbType === 'Inventory Part' || qbType === 'Non-inventory Part',
      });
      const isTaxable = taxCode === 'Tax';
      const isSerialized = category === 'monitor_personal' || category === 'monitor_area' || category === 'supplied_air_component';

      try {
        await prisma.product.upsert({
          where: { partNumber },
          update: {
            name: description || partNumber,
            category,
            productType: typeMapping.productType,
            unitOfMeasure: normalizeUoM(uom),
            defaultSellPrice: price,
            cost,
            isTaxable,
            isSerialized,
            isAssembly: qbType === 'Inventory Assembly',
            qbItemFullName: partNumber,
            qbItemType: typeMapping.qbItemType,
            isActive: true,
          },
          create: {
            partNumber,
            name: description || partNumber,
            category,
            productType: typeMapping.productType,
            unitOfMeasure: normalizeUoM(uom),
            defaultSellPrice: price,
            cost,
            isTaxable,
            isSerialized,
            isAssembly: qbType === 'Inventory Assembly',
            qbItemFullName: partNumber,
            qbItemType: typeMapping.qbItemType,
            isActive: true,
          },
        });
        imported++;
      } catch (err) {
        errors++;
        if (errorSamples.length < 5) {
          errorSamples.push(`${partNumber}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    await createAuditLog({
      userId: req.user!.userId,
      entityType: 'product',
      entityId: 'bulk-import',
      action: 'create',
      changes: { imported, skipped, errors, totalRows: dataLines.length },
      ipAddress: req.ip,
    });

    res.json({ imported, skipped, errors, errorSamples, totalRows: dataLines.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/defaults?division=3 — resolved default products per line
// type. With a division, labor/mileage resolve to the division's fixed part
// numbers ([DIV]00002 / [DIV]00001) when those products exist.
productsRouter.get('/defaults', async (req: Request, res: Response, next) => {
  try {
    const divisionRaw = req.query.division;
    const division = divisionRaw !== undefined ? parseInt(divisionRaw as string, 10) : null;
    const defaults = await getAllDefaults(Number.isNaN(division as number) ? null : division);
    res.json({ defaults });
  } catch (err) {
    next(err);
  }
});

// GET /api/products
productsRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const { search, category, type, active, division, limit = '50', offset = '0' } = req.query;
    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { partNumber: { contains: search as string, mode: 'insensitive' } },
      ];
    }
    if (category) where.category = category as string;
    if (type) where.productType = type as string;
    if (active !== undefined) where.isActive = active === 'true';
    if (division !== undefined) {
      const d = parseInt(division as string, 10);
      if (!Number.isNaN(d)) {
        // Scope to the requested division, plus Division 00 (cross-business
        // admin items: freight, discounts, fees) and unscoped legacy part
        // numbers — so the picker degrades gracefully until the QB renumber
        // reaches every item. Uses AND so it composes with the search OR.
        where.AND = [{ OR: [{ division: d }, { division: 0 }, { division: null }] }];
      }
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        take: parseInt(limit as string, 10),
        skip: parseInt(offset as string, 10),
      }),
      prisma.product.count({ where }),
    ]);
    res.json({ data: products, total });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id
productsRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id as string },
      include: {
        assemblyComponents: {
          include: { componentProduct: { select: { id: true, partNumber: true, name: true } } },
          orderBy: { sortOrder: 'asc' },
        },
        componentOf: {
          include: { assemblyProduct: { select: { id: true, partNumber: true, name: true } } },
        },
      },
    });
    if (!product) throw new AppError(404, 'Product not found');
    res.json(product);
  } catch (err) {
    next(err);
  }
});

// POST /api/products
productsRouter.post('/', requirePermission('products:manage'), async (req: Request, res: Response, next) => {
  try {
    // Division facets are derived from the part number, never hand-set.
    const data = { ...req.body, ...partNumberFacetColumns(req.body.partNumber) };
    const product = await prisma.product.create({ data });
    await createAuditLog({
      userId: req.user!.userId, entityType: 'product', entityId: product.id,
      action: 'create', changes: req.body, ipAddress: req.ip,
    });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
});

// PUT /api/products/:id
productsRouter.put('/:id', requirePermission('products:manage'), async (req: Request, res: Response, next) => {
  try {
    const data = { ...req.body };
    // Re-derive division facets whenever the part number changes.
    if ('partNumber' in data) Object.assign(data, partNumberFacetColumns(data.partNumber));
    const product = await prisma.product.update({ where: { id: req.params.id as string }, data });
    res.json(product);
  } catch (err) {
    next(err);
  }
});

// --- Assembly Components ---

// POST /api/products/:id/components
productsRouter.post('/:id/components', requirePermission('products:manage'), async (req: Request, res: Response, next) => {
  try {
    const component = await prisma.assemblyComponent.create({
      data: { ...req.body, assemblyProductId: req.params.id },
    });
    res.status(201).json(component);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/products/:productId/components/:id
productsRouter.delete('/:productId/components/:id', requirePermission('products:manage'), async (req: Request, res: Response, next) => {
  try {
    await prisma.assemblyComponent.delete({ where: { id: req.params.id as string } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
