/**
 * shopHardCloseSweep.ts — WI-05: the thing that happens 48 hours later.
 *
 * Soft close is an event a person causes. Hard close is not — it is the absence
 * of one, the window simply running out. Nothing calls it, so something has to
 * notice, and that is this.
 *
 * At hard close a unit becomes final, which means two things fire:
 *
 *   billing    the unit becomes visible to invoice generation. That needs no
 *              work here — isBillableShopItem reads the deadline directly, so
 *              a unit becomes billable by the clock passing, not by a job
 *              running. If this sweep never ran, billing would still be right.
 *
 *   VaultPRO   the push does need doing, because it is an outbound action
 *              rather than a query. enqueueInspectionRecord refuses while a
 *              unit is inside its window; this re-calls it once the window has
 *              shut.
 *
 * That asymmetry is deliberate. Billing correctness must not depend on a
 * background worker being alive, so it is derived. The push cannot be derived,
 * so it is swept — and marked, because "fires exactly once" is a requirement.
 */

import { prisma } from '../index.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';
import { enqueueInspectionRecord, enqueueAttachment } from './blueLionEnqueue.js';
import { materializeQaForItem } from './shopQaMaterialize.js';

export const CHECK_INTERVAL_MS = parseInt(
  process.env.SHOP_HARD_CLOSE_TICK_MS || `${5 * 60_000}`,
  10,
);

/** Units per tick. A backlog drains over several ticks rather than in one gulp. */
const BATCH_SIZE = parseInt(process.env.SHOP_HARD_CLOSE_BATCH || '50', 10);

let timer: ReturnType<typeof setInterval> | null = null;

export interface SweepResult {
  hardClosed: number;
  inspectionsQueued: number;
  attachmentsQueued: number;
  /** WI-06: batch-QA results frozen into their self-contained snapshots. */
  qaSnapshotted: number;
}

export async function processHardCloses(now: Date = new Date()): Promise<SweepResult> {
  const due = await prisma.shopWorkOrderItem.findMany({
    where: {
      hardClosesAt: { lte: now },
      vaultPushedAt: null,
      parentItemId: null,
    },
    orderBy: { hardClosesAt: 'asc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      serialNumber: true,
      equipmentInspections: { select: { id: true } },
      attachments: { select: { id: true } },
    },
  });

  const result: SweepResult = {
    hardClosed: 0, inspectionsQueued: 0, attachmentsQueued: 0, qaSnapshotted: 0,
  };

  for (const item of due) {
    try {
      // WI-06 first: a batch QA held normalized through the soft window is
      // flattened into its per-unit snapshot and given its ledger inspection
      // HERE, before the enqueue walk below — so the inspection it writes is
      // simply one of the unit's inspections by the time we look.
      //
      // Deliberately re-read rather than using the `equipmentInspections`
      // selected above, which was fetched before this call created one.
      const qa = await materializeQaForItem(item.id, now);
      result.qaSnapshotted += qa.snapshotted;
      const inspections = qa.inspectionsCreated > 0
        ? await prisma.equipmentInspection.findMany({
            where: { shopItemId: item.id }, select: { id: true },
          })
        : item.equipmentInspections;

      for (const insp of inspections) {
        const r = await enqueueInspectionRecord(insp.id);
        result.inspectionsQueued += r.enqueued;
      }
      // Per-unit evidence (WI-04) rides the same deadline: a photo attached to
      // a record that is still being corrected should not reach an immutable
      // ledger before the record settles.
      for (const att of item.attachments) {
        const r = await enqueueAttachment(att.id);
        result.attachmentsQueued += r.enqueued;
      }

      // Marked only after the enqueues succeeded. A throw above leaves
      // vaultPushedAt null and the unit is retried next tick — the failure mode
      // is a repeat attempt, never a silently skipped unit.
      await prisma.shopWorkOrderItem.update({
        where: { id: item.id },
        data: { vaultPushedAt: new Date() },
      });
      result.hardClosed++;
    } catch (err) {
      console.warn(
        `[hard-close] VaultPRO handoff failed for unit ${item.serialNumber} (${item.id}) — will retry:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (result.hardClosed > 0) {
    console.log(
      `[hard-close] ${result.hardClosed} unit(s) hard-closed — `
      + `${result.inspectionsQueued} inspection(s), ${result.attachmentsQueued} attachment(s) queued for VaultPRO`
      + (result.qaSnapshotted > 0 ? `, ${result.qaSnapshotted} batch-QA record(s) frozen` : ''),
    );
  }
  return result;
}

export function startShopHardCloseSweep(): void {
  if (timer) return;
  const runTick = () => {
    heartbeat('shop-hard-close');
    return runScheduledJob('shop.hard-close', 300, async () => {
      await processHardCloses();
    });
  };
  void runTick();
  timer = setInterval(() => { void runTick(); }, CHECK_INTERVAL_MS);
  console.log(`[hard-close] Sweep started (every ${Math.round(CHECK_INTERVAL_MS / 1000)}s)`);
}

export function stopShopHardCloseSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
