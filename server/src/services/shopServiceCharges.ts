import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import type { Prisma } from '../db.js';
import { canEditUnit } from './shopSoftClose.js';

/** Explicit QB mappings. Do not infer a service from an arbitrary name or seed SKU. */
export function serviceQaMapping(partNumber: string): { category: string; actions: string[] } | null {
  if (/^06110(0[1-5]|0[7-9]|1[0-2])$/.test(partNumber)) return { category: 'fire_extinguisher', actions: ['annual'] };
  if (['0612001', '0612002', '0612003', '0612004', '0612007', '0612008', '0612009', '0612010'].includes(partNumber)) return { category: 'fire_extinguisher', actions: ['six_year'] };
  if (['0612005', '0612006', '0612011', '0612012', '0612013'].includes(partNumber)) return { category: 'fire_extinguisher', actions: ['recharge_annual'] };
  if (/^061300[2-6]$/.test(partNumber)) return { category: 'fire_extinguisher', actions: ['twelve_year_hydro'] };
  if (partNumber === '0614002') return { category: 'fire_extinguisher', actions: ['condemn'] };
  if (partNumber === '0624002') return { category: 'ue_cylinder', actions: ['condemn'] };
  if (/^062300[3-7]$/.test(partNumber)) return { category: 'ue_cylinder', actions: ['ue_test'] };
  if (['0631001', '0631004'].includes(partNumber)) return { category: 'gas_detection', actions: ['calibration'] };
  return null;
}

export type ServiceCharge = { productId: string; partNumber: string; name: string; unitOfMeasure: string; quantity: number; rate: number; serviceActions: string[]; qaCategory: string | null };

export async function normalizeServiceCharges(raw: unknown): Promise<ServiceCharge[]> {
  if (!Array.isArray(raw) || raw.length > 100) throw new AppError(400, 'Services must be a list of at most 100 charges');
  if (raw.some(s => !s || typeof s.productId !== 'string' || !Number.isFinite(Number(s.quantity)) || Number(s.quantity) <= 0 || s.rate == null || s.rate === '' || !Number.isFinite(Number(s.rate)) || Number(s.rate) < 0)) {
    throw new AppError(400, 'Each service needs a catalog item, positive quantity, and a non-negative rate');
  }
  if (new Set(raw.map(s => s.productId)).size !== raw.length) throw new AppError(400, 'Combine duplicate services using quantity');
  const products = await prisma.product.findMany({ where: { id: { in: raw.map(s => s.productId) }, productType: 'service', isActive: true } });
  const byId = new Map(products.map(p => [p.id, p]));
  return raw.map(s => {
    const p = byId.get(s.productId);
    if (!p) throw new AppError(400, 'Choose an active service from the catalog');
    const mapping = serviceQaMapping(p.partNumber);
    return { productId: p.id, partNumber: p.partNumber, name: p.name, unitOfMeasure: p.unitOfMeasure || 'EA',
      quantity: Number(s.quantity), rate: Number(s.rate), serviceActions: mapping?.actions ?? ['other'], qaCategory: mapping?.category ?? null };
  });
}

export function servicesFromBilling(billing: unknown): ServiceCharge[] {
  const b = billing as { services?: ServiceCharge[] } | null;
  return Array.isArray(b?.services) ? b.services : [];
}

export function validateVendorServiceLink(billing: unknown): void {
  const b = billing as { vendor?: { mode?: string; serviceProductId?: string }; services?: ServiceCharge[] } | null;
  if (b?.vendor?.mode && !['passthrough', 'catalog_service'].includes(b.vendor.mode)) throw new AppError(400, 'Unknown vendor billing method');
  if (b?.vendor?.mode === 'catalog_service' && !b.services?.some(s => s.productId === b.vendor!.serviceProductId)) {
    throw new AppError(400, 'Vendor work is billed through a catalog service. Select that service, or switch vendor billing to pass-through before removing it.');
  }
}

export function linkedQaActions(actions: string[], services: ServiceCharge[], category: string): string[] {
  return [...new Set([...actions, ...services.flatMap(s => {
    const m = serviceQaMapping(s.partNumber);
    return m ? (m.category === category ? m.actions : []) : ['other'];
  })])];
}

/** QA and its charges commit together. The normal shop edit lock still applies. */
export async function saveQaServices(tx: Prisma.TransactionClient, itemId: string, services: ServiceCharge[], actor: { userId: string; role: string }) {
  const item = await tx.shopWorkOrderItem.findUnique({ where: { id: itemId } });
  if (!item) throw new AppError(404, 'Shop unit not found');
  const amounts = (rows: ServiceCharge[]) => JSON.stringify(rows.map(s => [s.productId, s.quantity, s.rate]));
  // Filing a QA correction without changing charges must not require reopening
  // an already closed billing record.
  if (amounts(servicesFromBilling(item.billing)) === amounts(services)) return;
  const verdict = canEditUnit(item, actor);
  if (!verdict.allowed) throw new AppError(409, verdict.reason!);
  const billing = item.billing && typeof item.billing === 'object' && !Array.isArray(item.billing) ? item.billing : {};
  validateVendorServiceLink({ ...billing, services });
  await tx.shopWorkOrderItem.update({ where: { id: itemId }, data: { billing: { ...billing, services } } });
}
