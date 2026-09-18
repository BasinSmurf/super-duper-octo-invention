/**
 * unitIdentity.ts — WI-05: resolve which physical unit this is, AT CLOSE.
 *
 * At close and not at intake, deliberately. At intake the counter has a pile of
 * gear and a customer waiting; the serial has just been typed and may still be
 * wrong. By close the unit has been inspected, worked, and QA'd — the serial has
 * been read off the plate several times, and the tech is the person best placed
 * to say whether this is the same cylinder they saw last spring.
 *
 * ONLY THE AMBIGUOUS CASE INTERRUPTS. That is the whole design:
 *
 *   no existing record   → create one silently. There is nothing to ask about;
 *                          a prompt here would be a dialog whose only answer is
 *                          "yes", which trains people to click through dialogs.
 *   existing record      → ask, once: "You've worked on this unit before — is
 *                          this the same one?" Serial numbers repeat across
 *                          manufacturers, and silently appending this ticket's
 *                          history to the wrong unit's record is the kind of
 *                          error nobody finds until an audit.
 *
 * Confirmed → this ticket's records append to the existing record. Denied → a
 * new record, because the tech has just told us these are two different objects
 * that happen to share a serial.
 */

import type { PrismaClient } from '../db.js';

export type IdentityResolution = 'matched' | 'created';

export interface IdentityCandidate {
  itemId: string;
  serialNumber: string;
  /** The existing record we think this might be. */
  candidateEquipmentId: string;
  candidateLastSeenAt: Date | null;
  candidateCategory: string | null;
  candidateCustomerName: string | null;
}

/**
 * Units on a work order that need a human to say yes or no.
 *
 * A unit already carrying `serializedEquipmentId` is not asked about — its
 * identity was settled when that link was made.
 */
export async function findIdentityCandidates(
  prisma: PrismaClient,
  workOrderId: string,
): Promise<IdentityCandidate[]> {
  const items = await prisma.shopWorkOrderItem.findMany({
    where: {
      workOrderId,
      parentItemId: null,
      serializedEquipmentId: null,
      identityResolution: null,
      softClosedAt: { not: null },
    },
    select: { id: true, serialNumber: true },
  });
  if (items.length === 0) return [];

  const serials = items.map((i) => i.serialNumber);
  const existing = await prisma.serializedEquipment.findMany({
    where: { serialNumber: { in: serials } },
    select: {
      id: true,
      serialNumber: true,
      updatedAt: true,
      product: { select: { name: true } },
      currentCustomer: { select: { name: true } },
    },
  });
  const bySerial = new Map(existing.map((e) => [e.serialNumber, e]));

  const candidates: IdentityCandidate[] = [];
  for (const item of items) {
    const match = bySerial.get(item.serialNumber);
    if (!match) continue; // silent-create case — not a question for anyone
    candidates.push({
      itemId: item.id,
      serialNumber: item.serialNumber,
      candidateEquipmentId: match.id,
      candidateLastSeenAt: match.updatedAt ?? null,
      candidateCategory: match.product?.name ?? null,
      candidateCustomerName: match.currentCustomer?.name ?? null,
    });
  }
  return candidates;
}

/**
 * Settle the units nobody needs to be asked about.
 *
 * Runs on close for every unit with no existing record for its serial: mints a
 * SerializedEquipment row, links it, and marks the identity `created`. Returns
 * how many it settled.
 *
 * Idempotent — a unit that already has a link or a resolution is skipped, so
 * running this twice does not mint duplicates.
 */
export async function autoCreateMissingIdentities(
  prisma: PrismaClient,
  workOrderId: string,
  userId: string,
): Promise<number> {
  const items = await prisma.shopWorkOrderItem.findMany({
    where: {
      workOrderId,
      parentItemId: null,
      serializedEquipmentId: null,
      identityResolution: null,
      softClosedAt: { not: null },
    },
    select: {
      id: true,
      serialNumber: true,
      equipmentCategory: true,
      productId: true,
      workOrder: { select: { companyId: true } },
    },
  });
  if (items.length === 0) return 0;

  const existing = await prisma.serializedEquipment.findMany({
    where: { serialNumber: { in: items.map((i) => i.serialNumber) } },
    select: { serialNumber: true },
  });
  const taken = new Set(existing.map((e) => e.serialNumber));

  let created = 0;
  for (const item of items) {
    if (taken.has(item.serialNumber)) continue; // ambiguous — a human decides
    // SerializedEquipment.productId is required, so a unit that was taken in
    // without a catalog product cannot mint a record. Left unresolved rather
    // than invented: it stays a ServicePRO-only unit and says so, instead of
    // being attached to a placeholder product that would follow it forever.
    if (!item.productId) continue;

    await prisma.$transaction(async (tx) => {
      const equipment = await tx.serializedEquipment.create({
        data: {
          serialNumber: item.serialNumber,
          productId: item.productId!,
          // Gear that came in through shop intake belongs to the customer who
          // dropped it off — Basin is servicing it, not holding stock.
          ownership: 'customer_owned',
          currentCustomerId: item.workOrder.companyId,
          status: 'available',
        },
        select: { id: true },
      });
      await tx.shopWorkOrderItem.update({
        where: { id: item.id },
        data: {
          serializedEquipmentId: equipment.id,
          identityResolution: 'created',
          identityResolvedAt: new Date(),
          identityResolvedById: userId,
        },
      });
    });
    created++;
  }
  return created;
}

/**
 * A human's answer to "is this the same one?".
 *
 * `sameUnit: true` links this ticket's work onto the existing record.
 * `false` means the tech has told us these are two different objects sharing a
 * serial, so a new record is minted — and the serial is suffixed to keep the
 * unique constraint honest rather than silently failing the write.
 */
export async function resolveIdentity(
  prisma: PrismaClient,
  itemId: string,
  sameUnit: boolean,
  userId: string,
): Promise<{ equipmentId: string; resolution: IdentityResolution }> {
  const item = await prisma.shopWorkOrderItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      serialNumber: true,
      equipmentCategory: true,
      productId: true,
      workOrder: { select: { companyId: true } },
    },
  });
  if (!item) throw new Error(`Shop item ${itemId} not found`);

  if (sameUnit) {
    const match = await prisma.serializedEquipment.findUnique({
      where: { serialNumber: item.serialNumber },
      select: { id: true },
    });
    if (!match) throw new Error(`No existing record for serial ${item.serialNumber}`);
    await prisma.shopWorkOrderItem.update({
      where: { id: itemId },
      data: {
        serializedEquipmentId: match.id,
        identityResolution: 'matched',
        identityResolvedAt: new Date(),
        identityResolvedById: userId,
      },
    });
    return { equipmentId: match.id, resolution: 'matched' };
  }

  // Different object, same serial. serialNumber is unique, so the new record
  // needs a distinguishable one — suffixed rather than mangled so the original
  // is still legible to whoever untangles this later.
  if (!item.productId) {
    throw new Error(
      `Unit ${item.serialNumber} has no catalog product, so no equipment record can be created for it.`,
    );
  }
  const suffixed = `${item.serialNumber}#${Date.now().toString(36)}`;
  const equipment = await prisma.serializedEquipment.create({
    data: {
      serialNumber: suffixed,
      productId: item.productId,
      ownership: 'customer_owned',
      currentCustomerId: item.workOrder.companyId,
      status: 'available',
      conditionNotes: `Distinct unit sharing serial ${item.serialNumber}; confirmed by tech at close.`,
    },
    select: { id: true },
  });
  await prisma.shopWorkOrderItem.update({
    where: { id: itemId },
    data: {
      serializedEquipmentId: equipment.id,
      identityResolution: 'created',
      identityResolvedAt: new Date(),
      identityResolvedById: userId,
    },
  });
  return { equipmentId: equipment.id, resolution: 'created' };
}
