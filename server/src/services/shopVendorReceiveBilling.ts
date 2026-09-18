import type { Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import type { ReceivePayload } from './shopVendorReceive.js';
import { linkedQaActions, normalizeServiceCharges, servicesFromBilling, serviceQaMapping } from './shopServiceCharges.js';

/** Commit the receiving choice with the status change and draft QA. */
export async function applyReceiveBilling(tx: Prisma.TransactionClient, itemId: string, payload: ReceivePayload) {
  if (payload.disposition !== 'pass_thru_repair') return;
  const item = await tx.shopWorkOrderItem.findUnique({ where: { id: itemId }, select: { billing: true } });
  if (!item) throw new AppError(404, 'Shop unit not found');
  const billing = (item.billing && typeof item.billing === 'object' && !Array.isArray(item.billing) ? item.billing : {}) as Record<string, any>;
  const oldServices = servicesFromBilling(billing);
  let services = oldServices.filter(s => billing.vendor?.mode !== 'catalog_service' || s.productId !== billing.vendor.serviceProductId);
  const vendor = { ...billing.vendor, mode: 'passthrough', cost: payload.invoiceTotal, markupPct: 0, freight: 0 };
  delete vendor.serviceProductId;
  if (payload.billingMode === 'catalog_service') {
    const [service] = await normalizeServiceCharges([payload.service]);
    services = [...services.filter(s => s.productId !== service.productId), service];
    vendor.mode = 'catalog_service';
    vendor.serviceProductId = service.productId;
  }
  await tx.shopWorkOrderItem.update({ where: { id: itemId }, data: { billing: { ...billing, vendor, services } as Prisma.InputJsonValue } });
  const draft = await tx.equipmentInspection.findFirst({ where: { shopItemId: itemId, lockedAt: null }, orderBy: { inspectedAt: 'desc' } });
  if (draft) {
    const actions = Array.isArray(draft.serviceActions) ? draft.serviceActions.filter((a): a is string => typeof a === 'string') : [];
    await tx.equipmentInspection.update({ where: { id: draft.id }, data: {
      serviceActions: linkedQaActions(actions.filter(a => !oldServices.some(s => serviceQaMapping(s.partNumber)?.actions.includes(a))), services, draft.category),
    } });
  }
}
