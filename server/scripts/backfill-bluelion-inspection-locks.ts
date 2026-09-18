/**
 * Backfill: lock historical equipment inspections that reached a terminal
 * outcome (pass/condemn) but were never locked — and so never enqueued for
 * BlueLion sync. Root cause: the shop item status gate (assertItemQaSatisfied
 * in routes/shopOrders.ts) let items reach shop_complete/condemned on
 * checklist-completeness alone, without requiring the inspection to actually
 * be locked. That gate is now fixed for new inspections; this backfills the
 * ones that already slipped through.
 *
 * Reuses lockInspectionRecord() — the exact same path as the live
 * POST /:id/lock route — so outcome flow-back, shop-item routing, and the
 * BlueLion enqueue all happen identically. Routing/flow-back are no-ops for
 * items already at a terminal status (verified: routeShopItemFromInspection
 * skips illegal transitions, applyInspectionOutcome skips already-condemned
 * equipment), so this is safe to run against old, closed work orders.
 *
 * Runs as a synthetic "system" user id (audited as a system action, not
 * attributed to a specific tech's account) — createAuditLog requires a
 * userId, so this must resolve to a real user row; SYSTEM_USER_ID below picks
 * the oldest admin account as that placeholder.
 *
 * Usage: npx tsx scripts/backfill-bluelion-inspection-locks.ts [--dry-run]
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { lockInspectionRecord } from '../src/services/inspectionLock.js';
import { AppError } from '../src/middleware/errorHandler.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const candidates = await prisma.equipmentInspection.findMany({
    where: { outcome: { in: ['pass', 'condemn'] }, lockedAt: null },
    select: { id: true, serialNumber: true, category: true, outcome: true, inspectedAt: true },
    orderBy: { inspectedAt: 'asc' },
  });

  console.log(`Found ${candidates.length} unlocked pass/condemn inspection(s).`);
  if (DRY_RUN) console.log('--dry-run: no changes will be made.\n');

  let locked = 0;
  let skipped = 0;
  let failed = 0;

  let systemUserId: string | null = null;
  if (!DRY_RUN && candidates.length > 0) {
    const systemUser = await prisma.user.findFirst({
      where: { role: 'platform_admin', isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!systemUser) throw new Error('No active platform_admin user found to attribute this backfill to');
    systemUserId = systemUser.id;
  }

  for (const insp of candidates) {
    const label = `${insp.serialNumber} [${insp.category}/${insp.outcome}] inspected ${insp.inspectedAt.toISOString().slice(0, 10)}`;
    if (DRY_RUN) {
      console.log(`  would lock: ${label}`);
      continue;
    }
    try {
      await lockInspectionRecord(prisma, insp.id, systemUserId!);
      console.log(`  ✓ locked: ${label}`);
      locked++;
    } catch (err) {
      if (err instanceof AppError && (err.statusCode === 422 || err.statusCode === 409)) {
        console.warn(`  ⚠ skipped (${err.message}): ${label}`);
        skipped++;
      } else {
        console.error(`  ✗ failed: ${label}`, err);
        failed++;
      }
    }
  }

  console.log(`\nDone. locked=${locked} skipped=${skipped} failed=${failed} total=${candidates.length}`);
  if (locked > 0) {
    console.log('Locked rows are now enqueued in bluelion_sync_queue — the next processor tick (≤60s) will push them.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
