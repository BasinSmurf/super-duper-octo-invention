import { prisma } from '../db.js';
import { buildShopBillingLines, buildWoExtraLines, toBillingItem, type ShopBillingItem, type WoBillingExtras } from './shopBillingLines.js';
import { getLaborProduct, getMileageProduct } from '../utils/servicePartMap.js';
import { SHOP_DIVISION } from '../utils/qbClass.js';
import { jsonObject } from './shopBillingQueue.js';

type RetailProduct = { id: string; defaultSellPrice: unknown };
/** Report-only copies. Never mutate billing data or create accounting artifacts. */
export function retailShopItems(items: ShopBillingItem[], products: RetailProduct[], laborRate: unknown) {
  const prices = new Map(products.map(p => [p.id, p.defaultSellPrice]));
  let fallbackRates = 0;
  const price = (id: string | undefined, recorded: unknown) => {
    const catalog = id ? prices.get(id) : undefined;
    if (catalog != null && Number.isFinite(Number(catalog))) return Number(catalog);
    fallbackRates++;
    return Number(recorded) || 0;
  };
  const projected = items.filter(i => !i.parentItemId).map(item => {
    const billing = jsonObject(item.billing);
    return { ...item, isWarranty: false, vendorDisposition: null,
      partsUsed: Array.isArray(item.partsUsed) ? item.partsUsed.map(p => ({ ...p, unitCost: price(p.productId, p.unitCost) })) : [],
      billing: { ...billing,
        ...(Array.isArray(billing.services) ? { services: billing.services.map((s: any) => ({ ...s, rate: price(s.productId, s.rate) })) } : {}),
        ...(billing.labor ? { labor: { ...billing.labor, rate: laborRate != null ? Number(laborRate) : price(undefined, billing.labor.rate) } } : {}),
        ...(billing.rollup?.enabled ? { rollup: { ...billing.rollup, rate: price(billing.rollup.productId ?? item.productId, billing.rollup.rate ?? item.product?.defaultSellPrice) } } : {}),
      },
    };
  });
  return { items: projected, fallbackRates };
}

export async function internalShopValue(from: Date, until: Date) {
  const [orders, labor, travel] = await Promise.all([
    prisma.shopWorkOrder.findMany({ where: { isInternal: true, status: { in: ['complete', 'closed'] }, OR: [
      { completedDate: { gte: from, lt: until } },
      { completedDate: null, returnedDate: { gte: from, lt: until } },
      { completedDate: null, returnedDate: null, updatedAt: { gte: from, lt: until } },
    ] }, include: { company: { select: { name: true } }, items: { include: { product: { select: { id: true, partNumber: true, name: true, defaultSellPrice: true } } } } }, orderBy: { completedDate: 'desc' } }),
    getLaborProduct(SHOP_DIVISION), getMileageProduct(SHOP_DIVISION),
  ]);
  const nonvoid = orders.filter(o => jsonObject(o.customData).voided !== true);
  const productIds = new Set<string>();
  for (const wo of nonvoid) for (const item of wo.items) {
    if (item.productId) productIds.add(item.productId);
    const billing = jsonObject(item.billing);
    if (billing.rollup?.productId) productIds.add(billing.rollup.productId);
    for (const s of billing.services ?? []) if (s.productId) productIds.add(s.productId);
    if (Array.isArray(item.partsUsed)) for (const p of item.partsUsed) {
      const id = jsonObject(p).productId;
      if (typeof id === 'string') productIds.add(id);
    }
  }
  const products = await prisma.product.findMany({ where: { id: { in: [...productIds] } }, select: { id: true, defaultSellPrice: true } });
  const rows = nonvoid.map(wo => {
    const retail = retailShopItems(wo.items.map(i => toBillingItem(i as unknown as Record<string, unknown>)), products, labor?.defaultSellPrice);
    const built = buildShopBillingLines(retail.items);
    const lines = [...built, ...buildWoExtraLines(wo.billingExtras as WoBillingExtras, built.length + 1, travel, labor)];
    const byCategory: Record<string, number> = {};
    for (const line of lines) {
      const kind = line.chargeKind ?? line.lineType;
      byCategory[kind] = Math.round(((byCategory[kind] ?? 0) + line.total) * 100) / 100;
    }
    return { id: wo.id, workOrderNumber: wo.workOrderNumber, companyName: wo.company.name,
      completedDate: (wo.completedDate ?? wo.returnedDate ?? wo.updatedAt).toISOString().slice(0, 10),
      estimatedDate: wo.completedDate === null && wo.returnedDate === null,
      itemCount: retail.items.length, retailValue: Math.round(lines.reduce((s, l) => s + l.total, 0) * 100) / 100,
      fallbackRates: retail.fallbackRates, unpricedLines: lines.filter(l => l.rate === 0 && l.quantity > 0).length,
      byCategory,
    };
  });
  const byCategory: Record<string, number> = {};
  for (const row of rows) for (const [kind, amount] of Object.entries(row.byCategory)) byCategory[kind] = Math.round(((byCategory[kind] ?? 0) + amount) * 100) / 100;
  return { rows, byCategory, total: Math.round(rows.reduce((s, r) => s + r.retailValue, 0) * 100) / 100,
    workorders: rows.length, items: rows.reduce((s, r) => s + r.itemCount, 0),
    fallbackRates: rows.reduce((s, r) => s + r.fallbackRates, 0), unpricedLines: rows.reduce((s, r) => s + r.unpricedLines, 0) };
}
