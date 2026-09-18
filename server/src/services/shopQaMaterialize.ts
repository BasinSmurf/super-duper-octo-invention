/**
 * shopQaMaterialize.ts — WI-06: the moment a batch QA stops being correctable.
 *
 * A batch QA lives normalized while the units are inside their 48-hour soft
 * window: one checklist row, read through by every unit in the batch, so a
 * correction is one UPDATE. At hard close that stops being the right shape —
 * the record is now permanent, and a permanent record that points at a mutable
 * row somewhere else is only as permanent as that row.
 *
 * So hard close does three things, in this order, and the order matters:
 *
 *   1. SNAPSHOT   flatten event + result into a self-contained record and write
 *                 it to the result row. The database enforces write-once (see
 *                 the 20260831120000 migration's trigger), so this is the
 *                 point of no return — and it is what makes the batch
 *                 uncorrectable, which the correction route checks for.
 *
 *   2. MATERIALIZE  write the locked EquipmentInspection that carries the
 *                 snapshot. This is the ledger spine; VaultPRO pushes read from
 *                 inspections, not from QA rows.
 *
 *   3. ENQUEUE    handled by the caller (shopHardCloseSweep), which was already
 *                 walking the unit's inspections. Materializing before it does
 *                 that means the new inspection is simply one of them.
 *
 * IDEMPOTENT AT EVERY STEP. The sweep retries a unit whose handoff threw, so
 * every write here is guarded on its own prior state rather than on having got
 * here only once.
 *
 * ONE LEDGER EVENT PER UNIT. If the unit already has a locked pass/condemn
 * inspection of its own — the tech batch-QA'd it AND inspected it individually
 * — no second inspection is written. The snapshot is still taken (ServicePRO
 * keeps the full QA record either way); what is suppressed is a duplicate entry
 * in an immutable external ledger, which nobody can retract.
 */

import type { Prisma } from '../db.js';
import { prisma } from '../index.js';
import { buildQaSnapshot, snapshotNoteLine, type QaVaultSnapshot } from './shopBatchQa.js';

/** Outcomes that already constitute a ledger event for the unit. */
const LEDGER_OUTCOMES = new Set(['pass', 'condemn']);

export interface MaterializeResult {
  snapshotted: number;
  inspectionsCreated: number;
}

const RESULT_INCLUDE = {
  qaEvent: {
    include: {
      performedBy: { select: { name: true } },
      correctedBy: { select: { name: true } },
      _count: { select: { results: true } },
    },
  },
  item: {
    select: {
      id: true,
      serialNumber: true,
      serializedEquipmentId: true,
      workOrder: {
        select: { workOrderNumber: true, company: { select: { name: true } } },
      },
    },
  },
} satisfies Prisma.ShopQaUnitResultInclude;

/**
 * Freeze every un-snapshotted QA result for one unit and give it its ledger row.
 *
 * Called from the hard-close sweep, before it walks the unit's inspections.
 */
export async function materializeQaForItem(
  itemId: string,
  now: Date = new Date(),
): Promise<MaterializeResult> {
  const out: MaterializeResult = { snapshotted: 0, inspectionsCreated: 0 };

  const results = await prisma.shopQaUnitResult.findMany({
    where: { itemId, vaultSnapshotAt: null },
    include: RESULT_INCLUDE,
  });
  if (results.length === 0) return out;

  // Does the unit already carry its own ledger event? Read once, not per
  // result — a unit with two QA results should not get two inspections either.
  const existingLedger = await prisma.equipmentInspection.findFirst({
    where: {
      shopItemId: itemId,
      lockedAt: { not: null },
      outcome: { in: ['pass', 'condemn'] },
      // An inspection this materializer wrote on a previous (failed) attempt is
      // not "the tech's own inspection" — it must not suppress its own retry.
      qaUnitResult: null,
    },
    select: { id: true, outcome: true },
  });
  const alreadyLedgered = !!existingLedger && LEDGER_OUTCOMES.has(existingLedger.outcome);

  for (const result of results) {
    const snapshot = buildQaSnapshot({
      event: result.qaEvent,
      result,
      batchSize: result.qaEvent._count.results,
      serialNumber: result.item.serialNumber,
      customer: result.item.workOrder?.company?.name ?? null,
      workOrderNumber: result.item.workOrder?.workOrderNumber ?? null,
      capturedAt: now,
    });

    // A FAILED QA is not a service event. The unit went back to the bench; the
    // thing VaultPRO eventually records is whatever happened after. The
    // snapshot is still written, because ServicePRO's own audit trail should
    // say a QA was run and did not pass.
    const wantsInspection = snapshot.outcome === 'pass' && !alreadyLedgered;

    await prisma.$transaction(async (tx) => {
      let inspectionId: string | null = null;
      if (wantsInspection) {
        const insp = await tx.equipmentInspection.create({
          data: {
            shopItemId: result.item.id,
            serializedEquipmentId: result.item.serializedEquipmentId,
            serialNumber: result.item.serialNumber,
            category: result.qaEvent.category,
            outcome: 'pass',
            serviceActions: snapshot.serviceActions.length
              ? snapshot.serviceActions
              : ['visual_only'],
            // qaChecklist in the shape the existing gate reads, PLUS the
            // self-contained snapshot. The first keeps every existing consumer
            // (the gate, the PDF, the detail page) working with no special
            // case; the second is the record that has to survive them all.
            data: {
              qaChecklist: checklistBooleans(snapshot),
              qaSnapshot: snapshot as unknown as Prisma.InputJsonValue,
              batchQa: true,
            } as Prisma.InputJsonObject,
            notes: snapshotNoteLine(snapshot),
            inspectedById: result.qaEvent.performedById,
            inspectedAt: result.qaEvent.performedAt,
            lockedAt: now,
          },
          select: { id: true },
        });
        inspectionId = insp.id;
      }

      await tx.shopQaUnitResult.update({
        where: { id: result.id },
        data: {
          vaultSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          vaultSnapshotAt: now,
          ...(inspectionId ? { inspectionId } : {}),
        },
      });
    });

    out.snapshotted++;
    if (wantsInspection) out.inspectionsCreated++;
  }

  return out;
}

/**
 * The flat { key: boolean } map the pre-existing QA gate reads.
 *
 * Derived from the snapshot rather than from the live event so the locked
 * inspection agrees with the frozen record byte for byte — two views of one
 * moment, not two reads of a moving one.
 */
function checklistBooleans(snap: QaVaultSnapshot): Prisma.InputJsonObject {
  const out: Record<string, boolean> = {};
  for (const cp of snap.checkpoints) {
    if (typeof cp.result === 'boolean') out[cp.key] = cp.result;
  }
  return out;
}
