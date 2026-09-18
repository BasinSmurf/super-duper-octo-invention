/**
 * audit-serials.ts — READ-ONLY. What would a serial re-mint actually change?
 *
 * Run this BEFORE anything is purged or re-pushed. It classifies every
 * serialized unit, groups the unusable ones by defect, and shows the tag each
 * would be minted as. It writes nothing — no sequence is advanced, no row is
 * touched, so it's safe to run against prod as many times as you like.
 *
 * Usage:
 *   npx tsx scripts/audit-serials.ts            # summary + samples
 *   npx tsx scripts/audit-serials.ts --all      # every affected unit
 *   npx tsx scripts/audit-serials.ts --json     # machine-readable
 *
 * The `pushed` column is the one that matters for the reload: units already
 * carrying a blueLionAssetId are registered in BlueLion's ledger under their
 * current serial. Re-minting those changes their externalId, so they re-push
 * as NEW assets — the old registration is orphaned, not updated.
 */
import { prisma } from '../src/db.js';
import {
  classifySerial,
  formatAssignedSerial,
  isAssignedSerial,
  DEFECT_EXPLANATIONS,
  type SerialDefect,
} from '../src/services/serialQuality.js';

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const asJson = args.includes('--json');

async function main(): Promise<void> {
  const units = await prisma.serializedEquipment.findMany({
    select: {
      id: true,
      serialNumber: true,
      parentEquipmentId: true,
      blueLionAssetId: true,
      product: { select: { name: true, category: true, isAssembly: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const flagged: {
    id: string;
    serial: string;
    defect: SerialDefect;
    category: string;
    product: string;
    isChild: boolean;
    pushed: boolean;
    proposed: string;
  }[] = [];

  let usable = 0;
  let alreadyMinted = 0;

  for (const u of units) {
    if (isAssignedSerial(u.serialNumber)) { alreadyMinted += 1; continue; }
    const verdict = classifySerial(u.serialNumber);
    if (verdict.usable) { usable += 1; continue; }
    flagged.push({
      id: u.id,
      serial: u.serialNumber,
      defect: verdict.defect,
      category: u.product.category,
      product: u.product.name,
      isChild: u.parentEquipmentId !== null,
      pushed: u.blueLionAssetId !== null,
      // Illustrative only — the real sequence value is assigned at mint time.
      proposed: formatAssignedSerial(u.product.category, 0),
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ total: units.length, usable, alreadyMinted, flagged }, null, 2));
    return;
  }

  const byDefect = new Map<SerialDefect, typeof flagged>();
  for (const f of flagged) {
    const list = byDefect.get(f.defect) ?? [];
    list.push(f);
    byDefect.set(f.defect, list);
  }

  console.log(`\n  ${units.length} serialized units`);
  console.log(`  ${usable} usable · ${flagged.length} would be re-minted · ${alreadyMinted} already carry a BSU tag`);
  console.log(`  ${flagged.filter((f) => f.pushed).length} of the flagged are already registered in BlueLion\n`);

  for (const [defect, list] of [...byDefect.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ── ${defect} (${list.length}) — ${DEFECT_EXPLANATIONS[defect]}`);
    for (const f of showAll ? list : list.slice(0, 10)) {
      const marks = [f.isChild ? 'child' : null, f.pushed ? 'in-bluelion' : null].filter(Boolean).join(',');
      console.log(`     ${JSON.stringify(f.serial).padEnd(28)} ${f.product.slice(0, 34).padEnd(36)} → ${f.proposed}${marks ? `  [${marks}]` : ''}`);
    }
    if (!showAll && list.length > 10) console.log(`     … ${list.length - 10} more (--all to list)`);
    console.log('');
  }

  if (flagged.length === 0) console.log('  Nothing to re-mint — every serial passes.\n');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
