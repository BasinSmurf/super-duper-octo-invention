import { prisma } from '../db.js';
import { getLaborProduct, getMileageProduct } from '../utils/servicePartMap.js';
import { SHOP_DIVISION } from '../utils/qbClass.js';
import { resolveInvoiceRules } from './billingRules.js';
import { buildShopBillingLines, buildWoExtraLines, hydrateShopPartCatalogPrices, type ShopBillingItem, type WoBillingExtras } from './shopBillingLines.js';

/** Shared by the pre-close review and invoice generation. Eligibility is chosen
 * by the caller: preview includes work in progress; invoices require hard close. */
export async function priceShopCharges(order: {
  id: string; workOrderNumber: string; companyId: string; tier1: boolean;
  company: { name: string; taxExempt: boolean; qbPriceLevelId: string | null };
  billingExtras: unknown;
}, items: ShopBillingItem[]) {
  const partIds = [...new Set(items.flatMap(i => Array.isArray(i.partsUsed)
    ? i.partsUsed.map(p => p.productId).filter((id): id is string => typeof id === 'string') : []))];
  const [parts, labor, travel, levels] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: partIds } }, select: { id: true, partNumber: true, name: true, defaultSellPrice: true, unitOfMeasure: true } }),
    getLaborProduct(SHOP_DIVISION), getMileageProduct(SHOP_DIVISION),
    order.company.qbPriceLevelId ? prisma.priceLevel.findMany({ where: { id: order.company.qbPriceLevelId, isActive: true }, include: { items: true } }) : Promise.resolve([]),
  ]);
  const built = buildShopBillingLines(hydrateShopPartCatalogPrices(items, parts));
  for (const line of built) {
    if (line.chargeKind === 'labor' && line.unitOfMeasure === 'HR' && labor) {
      line.productId = labor.id;
      line.partNumber = labor.partNumber;
    }
  }
  const all = [...built, ...buildWoExtraLines(order.billingExtras as WoBillingExtras, built.length + 1, travel, labor)];
  const ids = [...new Set(all.map(l => l.productId).filter((id): id is string => !!id))];
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, qbItemListId: true, qbItemFullName: true } });
  const byId = new Map(products.map(p => [p.id, p]));
  const lines = all.map(l => ({
    ...l, amount: l.total, isTaxable: l.lineType === 'part' && !order.company.taxExempt,
    sourceShopItemId: l.sourceShopItemId ?? null,
    serialNumber: l.serialNumber ?? null,
    chargeKind: l.chargeKind ?? (l.lineType === 'labor' ? 'service' : l.lineType === 'travel' ? 'travel' : 'misc'),
    qbItemListId: l.productId ? byId.get(l.productId)?.qbItemListId ?? null : null,
    qbItemFullName: l.productId ? (byId.get(l.productId)?.qbItemFullName ?? null) : null,
    notes: null as string | null,
  }));
  const ruleResult = resolveInvoiceRules({
    invoiceCompanyId: order.companyId, invoiceCompanyName: order.company.name,
    tickets: [{ id: order.id, ticketNumber: order.workOrderNumber, pad: order.tier1 ? { id: order.id, tier1: true } : null }],
    lineItems: lines.map(l => ({ ...l, qbSkip: false })),
    priceLevels: levels.map(pl => ({ id: pl.id, name: pl.name, items: pl.items.map(i => ({
      qbItemListId: i.qbItemListId,
      customPrice: i.customPrice == null ? null : Number(i.customPrice),
      adjustPercent: i.adjustPercent == null ? null : Number(i.adjustPercent),
    })) })),
  });
  for (const adj of ruleResult.lineAdjustments) {
    Object.assign(lines[adj.index], { rate: adj.newRate, amount: adj.newAmount, total: adj.newAmount, notes: adj.source });
  }
  for (const extra of ruleResult.extraLines) {
    lines.push({ ...extra, lineType: 'misc_charge', chargeKind: 'misc', sourceShopItemId: null,
      serialNumber: null, total: extra.amount, lineNumber: lines.length + 1, sortOrder: lines.length + 1 });
  }
  return { lines, ruleResult };
}
