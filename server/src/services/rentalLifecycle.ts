import { prisma } from '../db.js';
import type { Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';

export type RentalTx = Prisma.TransactionClient;
export function rentalDate(raw: unknown, label: string): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(raw)) throw new AppError(400, `Invalid ${label}`);
  const date = new Date(raw);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== raw.slice(0, 10)) throw new AppError(400, `Invalid ${label}`);
  return new Date(date.toISOString().slice(0, 10));
}
// Rental dates belong to Basin's business calendar, independent of the server
// host timezone. At 01:00 UTC the current rental day is still the prior day.
export const rentalToday = () => new Date(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()));

export async function lockRental(tx: RentalTx, id: string) {
  await tx.$queryRaw`SELECT id FROM rental_agreements WHERE id = ${id} FOR UPDATE`;
  const rental = await tx.rentalAgreement.findUnique({ where: { id } });
  if (!rental) throw new AppError(404, 'Rental agreement not found');
  return rental;
}
export async function withRental<T>(id: string, action: (tx: RentalTx, rental: Awaited<ReturnType<typeof lockRental>>) => Promise<T>) {
  return prisma.$transaction(async tx => action(tx, await lockRental(tx, id)), { maxWait: 10000, timeout: 30000 });
}

async function assertUnbilled(tx: RentalTx, id: string, start: Date, end: Date = rentalToday()) {
  const invoice = await tx.invoice.findFirst({ where: { rentalAgreementId: id, status: { not: 'void' }, periodStart: { lte: end }, periodEnd: { gte: start } } });
  if (invoice) throw new AppError(409, `Dates overlap invoice ${invoice.invoiceNumber}; void/correct it before changing billed history`);
}

export async function deployRentalItem(tx: RentalTx, rental: Awaited<ReturnType<typeof lockRental>>, input: any) {
  if (input.id) {
    const existing = await tx.rentalAgreementItem.findUnique({ where: { id: input.id } });
    if (existing) {
      if (existing.rentalAgreementId !== rental.id || existing.serializedEquipmentId !== input.serializedEquipmentId || existing.productId !== input.productId) throw new AppError(409, 'Deployment retry does not match its original item');
      return existing;
    }
  }
  if (!['active', 'scheduled'].includes(rental.status)) throw new AppError(409, 'Agreement is not active or scheduled');
  if (input.status && input.status !== 'deployed' || input.returnedDate) throw new AppError(400, 'New equipment must be deployed; return it separately');
  const deployedDate = input.deployedDate ? rentalDate(input.deployedDate, 'deployedDate') : rentalToday();
  if (deployedDate > rentalToday()) throw new AppError(400, 'deployedDate cannot be in the future');
  const rateType = input.rateType || rental.billingRateType;
  if (!['daily', 'weekly', 'monthly'].includes(rateType)) throw new AppError(400, 'Invalid rateType');
  if (input.rate != null && (typeof input.rate !== 'number' || !Number.isFinite(input.rate) || input.rate < 0)) throw new AppError(400, 'Rate must be a non-negative number');
  await assertUnbilled(tx, rental.id, deployedDate);
  if (input.replacesItemId) {
    const previous = await tx.rentalAgreementItem.findUnique({ where: { id: input.replacesItemId } });
    if (!previous || previous.rentalAgreementId !== rental.id || previous.productId !== input.productId || previous.serializedEquipmentId === input.serializedEquipmentId) {
      throw new AppError(400, 'Replacement must reference different equipment of the same product on this rental');
    }
    if (previous.returnedDate && previous.returnedDate > deployedDate) throw new AppError(400, 'Replacement predates the original collection');
    if (previous.status === 'deployed') await returnRentalItem(tx, rental.id, previous.id, { returnedDate: deployedDate.toISOString() });
    else if (previous.status !== 'returned') throw new AppError(409, 'Original item cannot be replaced');
  }
  // All deployment paths use the same row lock, including offline retries and
  // creation with initial items. One serial cannot be claimed by two jobs.
  await tx.$queryRaw`SELECT id FROM serialized_equipment WHERE id = ${input.serializedEquipmentId} FOR UPDATE`;
  const equipment = await tx.serializedEquipment.findUnique({ where: { id: input.serializedEquipmentId } });
  if (!equipment) throw new AppError(404, 'Equipment not found');
  if (equipment.productId !== input.productId) throw new AppError(400, 'Equipment does not match product');
  if (equipment.status !== 'available' || equipment.currentRentalId) throw new AppError(409, 'Equipment is not available');
  if (await tx.rentalAgreementItem.findFirst({ where: { serializedEquipmentId: equipment.id, status: 'deployed' } })) throw new AppError(409, 'Equipment already has a deployed assignment');
  const item = await tx.rentalAgreementItem.create({ data: {
    id: input.id, rentalAgreementId: rental.id, productId: input.productId, serializedEquipmentId: equipment.id,
    rate: input.rate ?? undefined, rateType, deployedDate, status: 'deployed', deployInspection: input.deployInspection ?? undefined,
    replacesItemId: input.replacesItemId || undefined,
  }, include: { product: { select: { id: true, name: true, partNumber: true } }, serializedEquipment: { select: { id: true, serialNumber: true } } } });
  await tx.serializedEquipment.update({ where: { id: equipment.id }, data: { status: 'rented', currentRentalId: rental.id, currentCustomerId: rental.companyId } });
  if (rental.status === 'scheduled') await tx.rentalAgreement.update({ where: { id: rental.id }, data: { status: 'active' } });
  return item;
}

export async function returnRentalItem(tx: RentalTx, rentalId: string, itemId: string, input: any = {}) {
  const item = await tx.rentalAgreementItem.findUnique({ where: { id: itemId } });
  if (!item || item.rentalAgreementId !== rentalId) throw new AppError(404, 'Rental item not found on this agreement');
  const returnedDate = input.returnedDate ? rentalDate(input.returnedDate, 'returnedDate') : rentalToday();
  if (item.status === 'returned') {
    if (input.returnedDate && +returnedDate !== +item.returnedDate!) throw new AppError(409, 'Return retry cannot change the original return date');
    return item; // Lost acknowledgement: never release an asset a second time.
  }
  if (item.status !== 'deployed') throw new AppError(409, `Item is ${item.status}`);
  if (returnedDate < item.deployedDate || returnedDate > rentalToday()) throw new AppError(400, 'Return date must be between deployment and today');
  // Return day is inclusive; only days AFTER it would change billed history.
  await assertUnbilled(tx, rentalId, new Date(+returnedDate + 86400000));
  const updated = await tx.rentalAgreementItem.update({ where: { id: item.id }, data: { status: 'returned', returnedDate } });
  await tx.serializedEquipment.updateMany({ where: { id: item.serializedEquipmentId, currentRentalId: rentalId, status: 'rented' }, data: {
    status: 'available', currentRentalId: null, currentCustomerId: null,
    ...(input.inspectionData ? { customData: input.inspectionData } : {}),
  } });
  return updated;
}

export async function closeRental(tx: RentalTx, rental: Awaited<ReturnType<typeof lockRental>>, status: 'completed' | 'cancelled', reason?: string, endDateInput?: unknown) {
  const endDate = endDateInput ? rentalDate(endDateInput, 'endDate') : rentalToday();
  if (rental.status === status) {
    if (endDateInput && +endDate !== +rental.endDate!) throw new AppError(409, 'Close retry cannot change the original end date');
    return { success: true, returnedItems: 0, alreadyClosed: true };
  }
  if (endDate > rentalToday()) throw new AppError(400, 'endDate cannot be in the future');
  if (endDate < rental.startDate) throw new AppError(400, 'endDate cannot precede the rental start');
  const manualEquipment = (rental.composition as any)?.manualEquipment || [];
  if (manualEquipment.some((row: any) => row.status !== 'returned')) {
    throw new AppError(409, 'Return and inspect the deployed equipment rows before closing this rental');
  }
  if (manualEquipment.some((row: any) => row.returnedAt > endDate.toISOString().slice(0, 10))) {
    throw new AppError(400, 'endDate predates equipment activity');
  }
  const latestItem = await tx.rentalAgreementItem.findFirst({ where: { rentalAgreementId: rental.id, OR: [{ deployedDate: { gt: endDate } }, { returnedDate: { gt: endDate } }] } });
  if (latestItem) throw new AppError(400, 'endDate predates equipment activity');
  await assertUnbilled(tx, rental.id, new Date(+endDate + 86400000));
  if (rental.status !== 'active' && !(status === 'cancelled' && rental.status === 'scheduled')) throw new AppError(409, 'Agreement is not active');
  const items = await tx.rentalAgreementItem.findMany({ where: { rentalAgreementId: rental.id, status: 'deployed' }, orderBy: { serializedEquipmentId: 'asc' },
    include: { serializedEquipment: { select: { serialNumber: true } } } });
  // Hard stop: a job is not done while its gear is still out. Closing ends
  // billing, so "close now, the trailer comes in Friday" silently gives away
  // every day until Friday. Units come back on a Return ticket (which closes
  // the job itself once the last one is in). Cancelling is different — that is
  // "this never happened", so it still pulls everything back.
  if (status === 'completed' && items.length) {
    const serials = items.map(i => i.serializedEquipment?.serialNumber || 'unserialized').join(', ');
    throw new AppError(409, `Cannot close this rental: ${items.length} unit${items.length === 1 ? ' is' : 's are'} still out (${serials}). Return ${items.length === 1 ? 'it' : 'them'} on a Return ticket first.`);
  }
  for (const item of items) await returnRentalItem(tx, rental.id, item.id, { returnedDate: endDate.toISOString() });
  await tx.rentalAgreement.update({ where: { id: rental.id }, data: { status, endDate, ...(reason ? { notes: `${rental.notes || ''}\nCancelled: ${reason}` } : {}) } });
  return { success: true, returnedItems: items.length };
}

