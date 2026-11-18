import { prisma } from '../db.js';
import type { Prisma } from '../db.js';
import { priceShopCharges } from './shopChargePreview.js';
import { billingRoute } from './paidAtDrop.js';
import { isBillableShopItem, toBillingItem } from './shopBillingLines.js';
export type ShopBillingDb = Prisma.TransactionClient;
export function jsonObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function shopBillingExcluded(wo: { isInternal: boolean; customData: unknown }): boolean {
  const data = jsonObject(wo.customData);
  return wo.isInternal || data.voided === true || data.billingWaiver != null;
}

export async function excludedShopTicketIds(db: ShopBillingDb = prisma): Promise<string[]> {
  const [orders, tickets] = await Promise.all([
    db.shopWorkOrder.findMany({ select: { id: true, isInternal: true, customData: true } }),
    db.serviceTicket.findMany({ where: { sourceType: 'shop_work_order', status: 'billing_queue' }, select: { id: true, customData: true } }),
  ]);
  const excluded = new Set(orders.filter(shopBillingExcluded).map(w => w.id));
  return tickets.filter(t => excluded.has(jsonObject(t.customData).shopWorkOrderId)).map(t => t.id);
}

/**
 * Shop WOs whose billing is already handled, so they must NOT surface again as a
 * WO-direct billable option. A WO counts as handled when EITHER:
 *   - a shop-WO invoice exists (the /generate/from-shop-wo path — the current model), OR
 *   - a legacy per-unit-sweep repair (RP) ticket was spawned from it (pre-2026-07;
 *     shop billing no longer creates these, but in-flight ones must stay hidden
 *     so their WO doesn't ALSO appear as WO-direct-billable → double bill), OR
 *   - WI-08: it was PAID AT DROP and the payment still covers the work. The QB
 *     SalesReceipt is the accounting record; raising a ServicePRO invoice on top
 *     would be a second document for one payment.
 *
 * Returns the set of shopWorkOrder ids to hide from "ready to bill".
 *
 * ONE function, because both the summary count and the /uninvoiced/shop-wos list
 * call it. Two copies of "what counts as already billed" is how a work order
 * ends up counted in one place and invoiceable in the other.
 */
export async function getBilledShopWorkOrderIds(db: ShopBillingDb = prisma): Promise<Set<string>> {
  const [directInvoices, repairTickets] = await Promise.all([
    db.invoice.findMany({
      where: { status: { not: 'void' }, shopWorkOrderId: { not: null } },
      select: { shopWorkOrderId: true },
    }),
    db.serviceTicket.findMany({
      where: { sourceType: 'shop_work_order', ticketType: 'repair' },
      select: { customData: true },
    }),
  ]);
  const ids = new Set<string>();
  for (const inv of directInvoices) if (inv.shopWorkOrderId) ids.add(inv.shopWorkOrderId);
  for (const t of repairTickets) {
    const woId = (t.customData as any)?.shopWorkOrderId;
    if (typeof woId === 'string') ids.add(woId);
  }
  for (const id of await paidAtDropExemptWorkOrderIds(db)) ids.add(id);
  const excluded = await db.shopWorkOrder.findMany({ select: { id: true, isInternal: true, customData: true } });
  for (const wo of excluded) if (shopBillingExcluded(wo)) ids.add(wo.id);
  return ids;
}

/**
 * WI-08 — work orders settled at the counter, where the payment still covers it.
 *
 * NOT simply "has paidAtDropVia set". The exemption is recomputed against the
 * money and the current work every time this is asked, so a monitor that was
 * paid for at 9am and needed a sensor at 11 comes BACK onto the billable list
 * for the difference, with nobody having to notice or clear a flag.
 *
 * Only closed, non-internal orders are considered — the same population the
 * caller is filtering — so this stays a small query on a list of tens.
 */
export async function paidAtDropExemptWorkOrderIds(db: ShopBillingDb = prisma): Promise<Set<string>> {
  const orders = await db.shopWorkOrder.findMany({
    where: { status: 'closed', isInternal: false, paidAtDropVia: { not: null } },
    select: {
      id: true, workOrderNumber: true, companyId: true, tier1: true, company: true, billingExtras: true,
      paidAtDropVia: true,
      lightspeedTxnNumber: true,
      payments: {
        select: {
          amount: true, ccFeeAmount: true, status: true, paymentMethod: true, stripeChargeId: true,
          stripeReceiptUrl: true, cardLast4: true, cardBrand: true, createdAt: true,
        },
      },
      items: { include: { product: { select: { id: true, partNumber: true, name: true, defaultSellPrice: true } } } },
    },
  });

  const exempt = new Set<string>();
  const now = new Date();
  for (const order of orders) {
    // A shop WO has no stored total — billing is derived from its units. Derive
    // the same figure the invoice would have used, so "does the payment cover
    // it?" is asked against the real number rather than an estimate.
    const projected = order.items.map((i) => toBillingItem(i as unknown as Record<string, unknown>));
    const { lines } = await priceShopCharges(order, projected.filter((i) => isBillableShopItem(i, now)));
    const total = lines.reduce((sum, l) => sum + l.total, 0);

    if (billingRoute({ ...order, total }, order.payments).route === 'exempt') {
      exempt.add(order.id);
    }
  }
  return exempt;
}
