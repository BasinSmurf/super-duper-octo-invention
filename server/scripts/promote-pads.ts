/**
 * ServicePRO Pad Promotion — pad_promote.xlsx handoff, 2026-07-31.
 *
 * Sundog models Pad and Well as separate tables (unlike the legacy system,
 * which treated these locations as a single "pad" with no per-well
 * granularity). Each name below currently exists in ServicePRO as a
 * standalone Well record standing in for the pad — real ticket/workpoint
 * history hangs off that well id. This script:
 *
 *   1. Creates a real Pad for each name (field/operator copied from the
 *      stand-in well).
 *   2. Re-points every FK that referenced the stand-in well (tickets,
 *      workpoints, operator history, route stops, rental agreements,
 *      serialized equipment) onto the new pad, then deletes the stand-in
 *      well — it was never a real well.
 *   3. Upserts the real child wells (keyed on API number, per
 *      pad_promote_normalized.csv) under the new pad, active = true.
 *
 * Idempotent: re-running is a no-op for anything already promoted (pad
 * lookup by name+operator, well upsert on apiNumber unique constraint).
 *
 * Held out of this batch (2026-07-31, pending corrected source data):
 *   - BW-ARNEGARD STATE H6-8   (dup child row; real H-8 API still unknown)
 *   - Dakota Federal 42x-36    (42X-36D api is 13 digits, one short)
 *   - Madisyn 154-94-0706      (EN-MADISYN ...H-1 legal reads 0607 not 0706)
 *
 * Usage: npx tsx scripts/promote-pads.ts [--dry-run]
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';

// Canonical pad name -> actual stand-in well name, only where they differ.
// "lundin 11-15" has no exact-match well; the closest is "Lundin 11X-15"
// (itself a duplicate pair — see dedupeWellDuplicates below).
const WELL_NAME_OVERRIDE: Record<string, string> = {
  'lundin 11-15': 'Lundin 11X-15',
};

interface PadDef {
  padName: string;
  children: { wellName: string; api: string }[];
  // Default true: repoint the duplicate's history onto the survivor and
  // delete it (approved for Rink 13x-4, whose duplicate had 0 tickets).
  // Set false to leave the duplicate untouched and just flag it — used for
  // lundin 11-15, where the "duplicate" turned out to carry its own ticket
  // history (2 tickets) that wasn't disclosed when merge-vs-pick was asked,
  // so it needs its own review rather than a silent merge.
  mergeDuplicates?: boolean;
}

const PADS: PadDef[] = [
  { padName: 'BW-NORGARD H1-4', children: [
    { wellName: 'BW-NORGARD 149-100-1102H-1', api: '33053039800000' },
    { wellName: 'BW-NORGARD- 149-100-1102H-2', api: '33053059920000' },
    { wellName: 'BW-NORGARD- 149-100-1102H-3', api: '33053059930000' },
    { wellName: 'BW-NORGARD- 149-100-1102H-4', api: '33053061120000' },
  ]},
  { padName: 'BW-SHARON H1-3', children: [
    { wellName: 'BW-SHARON-150-100- 2536H-1', api: '33053040190000' },
    { wellName: 'BW-SHARON 150-100-2536H-2', api: '33053046980000' },
    { wellName: 'BW-SHARON 150-100-2536H-3', api: '33053047520000' },
  ]},
  { padName: 'BW-Wilson 149-99-3625H', children: [
    { wellName: 'BW-WILSON 149-99-3625H-1', api: '33053035930000' },
    { wellName: 'BW-Wilson- 149-99-3625H-2', api: '33053103380000' },
    { wellName: 'BW-Wilson- 149-99-3625H-5', api: '33053104940000' },
    { wellName: 'BW-WILSON- 149-99-3625H-4PNC', api: '33053064770000' },
    { wellName: 'BW-Wilson- 149-99-3625H-6', api: '33053104950000' },
  ]},
  { padName: 'Black Federal 33-28 CTB', children: [
    { wellName: 'BLACK FEDERAL 33-28 #6TFH', api: '33105049330000' },
    { wellName: 'BLACK FEDERAL 33-28 #7H', api: '33105053250000' },
  ]},
  { padName: 'COLE 44X-32', children: [
    { wellName: 'COLE 44X-32C', api: '33053054070000' },
    { wellName: 'COLE 44X-32DXA', api: '33053087650000' },
    { wellName: 'COLE 44X-32F', api: '33053087630000' },
    { wellName: 'COLE 44X-32G', api: '33053054060000' },
  ]},
  { padName: 'Cherry Creek State 14X-36', children: [
    { wellName: 'CHERRY CREEK STATE 14X-36AXD', api: '33053083290000' },
    { wellName: 'CHERRY CREEK STATE 14X-36B', api: '33053083330000' },
    { wellName: 'CHERRY CREEK STATE 14X-36E', api: '33053083300000' },
    { wellName: 'CHERRY CREEK STATE 14X-36EXF', api: '33053083310000' },
    { wellName: 'CHERRY CREEK STATE 14X-36F', api: '33053083320000' },
  ]},
  { padName: 'EN-NESET-156-94-0706', children: [
    { wellName: 'EN-NESET-156-94- 0706H-1', api: '33061007390000' },
    { wellName: 'EN-NESET- 156-94-0706H-2', api: '33061031740000' },
    { wellName: 'EN-NESET- 156-94-0706H-4', api: '33061031720000' },
    { wellName: 'EN-NESET- 156-94-0706H-5', api: '33061031710000' },
    { wellName: 'EN-Neset- 156-94-0706H-6', api: '33061049750000' },
  ]},
  { padName: 'En- Weyrauch C-154-93-2932 H5-12', children: [
    { wellName: 'EN-WEYRAUCH C- 154-93-2932H-5', api: '33061034550000' },
    { wellName: 'EN-WEYRAUCH C- 154-93-2932H-6', api: '33061034560000' },
    { wellName: 'EN-WEYRAUCH C- 154-93-2932H-7', api: '33061034570000' },
    { wellName: 'EN-WEYRAUCH C- 154-93-2932H-8', api: '33061034580000' },
    { wellName: 'EN-WEYRAUCH C- 154-93-2932H-9', api: '33061034590000' },
    { wellName: 'EN-WEYRAUCH C- 154-93-2932H-10', api: '33061034700000' },
    { wellName: 'EN-WEYRAUCH C- 154-93-2932H-11', api: '33061034710000' },
    { wellName: 'EN-WEYRAUCH C- 154-93-2932H-12', api: '33061034720000' },
  ]},
  { padName: 'FBIR Grinnell 34X-33', children: [
    { wellName: 'FBIR GRINNELL 34X-33A', api: '33025028620000' },
    { wellName: 'FBIR GRINNELL 34X-33B', api: '33025028600000' },
    { wellName: 'FBIR GRINNELL 34X-33D', api: '33025028570000' },
    { wellName: 'FBIR GRINNELL 34X-33F', api: '33025028590000' },
  ]},
  { padName: 'FBIR Reese 43X-33', children: [
    { wellName: 'FBIR REESE 43X-33B', api: '33025029420000' },
    { wellName: 'FBIR REESE 43X-33D', api: '33025029460000' },
    { wellName: 'FBIR REESE 43X-33E', api: '33025029410000' },
    { wellName: 'FBIR REESE 43X-33F', api: '33025029430000' },
    { wellName: 'FBIR REESE 43X-33G', api: '33025029450000' },
  ]},
  { padName: 'FBIR Walterpackswolf 31X-12 Pad', children: [
    { wellName: 'FBIR WALTERPACKSWOLF 31X-12C', api: '33025011790000' },
    { wellName: 'FBIR WALTERPACKSWOLF 31X-12D', api: '33025019320000' },
    { wellName: 'FBIR WALTERPACKSWOLF 31X-12G', api: '33025019300000' },
    { wellName: 'FBIR WALTERPACKSWOLF 31X-12H', api: '33025019310000' },
  ]},
  { padName: 'Granli 34x-20', children: [
    { wellName: 'GRANLI 34X-20BXC', api: '33053062040000' },
    { wellName: 'GRANLI 34X-20C', api: '33053062050000' },
    { wellName: 'GRANLI 34X-20D', api: '33053062070000' },
  ]},
  { padName: 'HM Hove 34X-33', children: [
    { wellName: 'HM HOVE 34X-33C', api: '33105035560000' },
    { wellName: 'HM HOVE 34X-33D', api: '33105035580000' },
    { wellName: 'HM HOVE 34X-33G', api: '33105035570000' },
    { wellName: 'HM HOVE 34X-33H', api: '33105035750000' },
  ]},
  { padName: 'KRAKEN OPERATING - Mathewson', children: [] },
  { padName: 'KRAKEN OPERATING - Mercer', children: [] },
  { padName: 'KRAKEN OPERATING - Rixey', children: [] },
  { padName: 'KRAKEN OPERATING - Ruffing', children: [] },
  { padName: 'KRAKEN OPERATING - Sumner', children: [] },
  { padName: 'Lund 21X/41X Pad', children: [] },
  { padName: 'lundin 11-15', mergeDuplicates: false, children: [
    { wellName: 'LUNDIN 11X-15AXB', api: '33053075040000' },
    { wellName: 'LUNDIN 11X-15E', api: '33053071150000' },
    { wellName: 'LUNDIN 11X-15F', api: '33053075050000' },
    { wellName: 'LUNDIN 11-15SEH', api: '33053033960000' },
  ]},
  { padName: 'Maddy Federal 24X-34', children: [
    { wellName: 'MADDY FEDERAL 24X-34F', api: '33053073030000' },
    { wellName: 'MADDY FEDERAL 24X-34AXD', api: '33053073070000' },
    { wellName: 'MADDY FEDERAL 24X-34B', api: '33053073010000' },
    { wellName: 'MADDY FEDERAL 24X-34D', api: '33053073060000' },
    { wellName: 'MADDY FEDERAL 24X-34C', api: '33053073020000' },
  ]},
  { padName: 'Mandal/Hovet Federal 41x-29', children: [
    { wellName: 'HOVET FEDERAL 41X-29B', api: '33053034050000' },
    { wellName: 'HOVET FEDERAL 41X-29E', api: '33053089000000' },
    { wellName: 'HOVET FEDERAL 41X-29G', api: '33053089010000' },
  ]},
  { padName: 'Martin federal 21x-33', children: [
    { wellName: 'MARTIN FEDERAL 21X-33A', api: '33025021130000' },
    { wellName: 'MARTIN FEDERAL 21X-33B', api: '33025021150000' },
    { wellName: 'MARTIN FEDERAL 21X-33E', api: '33025021120000' },
    { wellName: 'MARTIN FEDERAL 21X-33F', api: '33025021140000' },
    { wellName: 'MARTIN FEDERAL 21-33SWH', api: '33025019220000' },
  ]},
  { padName: 'Nordeng 34X-23 Pad', children: [
    { wellName: 'NORDENG 34X-23A', api: '33053068750000' },
    { wellName: 'NORDENG 34X-23B', api: '33053068780000' },
    { wellName: 'NORDENG 34X-23AXB', api: '33053068760000' },
    { wellName: 'NORDENG 34X-23E', api: '33053069010000' },
    { wellName: 'NORDENG 34X-23F', api: '33053068790000' },
  ]},
  { padName: 'Olaf 42X-11', children: [
    { wellName: 'OLAF 42X-11B', api: '33105051460000' },
    { wellName: 'OLAF 42X-11C', api: '33105051440000' },
    { wellName: 'OLAF 42X-11EXF', api: '33105051470000' },
  ]},
  { padName: 'Pocasset 29-32 CTB', children: [
    { wellName: 'POCASSET 29-32 #2H', api: '33105047840000' },
    { wellName: 'POCASSET 29-32 #3TFH', api: '33105047850000' },
    { wellName: 'POCASSET 32-29 #4TFH', api: '33105049310000' },
    { wellName: 'POCASSET 32-29 #5H', api: '33105049300000' },
    { wellName: 'POCASSET 32-29 #6TFH', api: '33105049290000' },
    { wellName: 'POCASSET 32-29 #7H', api: '33105049280000' },
  ]},
  { padName: 'Ravin 21X-15', children: [
    { wellName: 'RAVIN 21X-15A', api: '33053082160000' },
    { wellName: 'RAVIN 21X-15E', api: '33053082150000' },
    { wellName: 'RAVIN 21X-15EXF', api: '33053082130000' },
    { wellName: 'RAVIN 21X-15F', api: '33053082110000' },
  ]},
  { padName: 'Rink 13x-4', children: [
    { wellName: 'RINK 13X-4A', api: '33053052530000' },
    { wellName: 'RINK 13-24H', api: '33053035830000' },
    { wellName: 'RINK 13X-4F', api: '33053052540000' },
  ]},
  { padName: 'Rough Federal 44x-23', children: [
    { wellName: 'ROUGH FEDERAL 44X-23A', api: '33053083090000' },
    { wellName: 'ROUGH FEDERAL 44X-23D', api: '33053083030000' },
    { wellName: 'ROUGH FEDERAL 44X-23DXA', api: '33053083910000' },
    { wellName: 'ROUGH FEDERAL 44X-23E', api: '33053083080000' },
    { wellName: 'ROUGH FEDERAL 44X-23G', api: '33053083040000' },
  ]},
  { padName: 'Ryan 14X-9', children: [
    { wellName: 'RYAN 14X-9A', api: '33053069030000' },
    { wellName: 'RYAN 14X-9B', api: '33053069050000' },
    { wellName: 'RYAN 14X-9E', api: '33053069020000' },
    { wellName: 'RYAN 14X-9EXF', api: '33053069040000' },
    { wellName: 'RYAN 1-9H', api: '33061021630000' },
  ]},
  { padName: 'SC-NORMAN 3-5', children: [
    { wellName: 'SC-NORMAN 154-98-3130H-3', api: '33105026690000' },
    { wellName: 'SC-NORMAN 154-98-3130H-4', api: '33105026700000' },
    { wellName: 'SC-NORMAN 154-98-3130H-5', api: '33105026710000' },
  ]},
  { padName: 'Stenehjem 31X-28', children: [
    { wellName: 'STENEHJEM 31X-28C', api: '33053065390000' },
    { wellName: 'STENEHJEM 31X-28D', api: '33053066020000' },
    { wellName: 'STENEHJEM 31X-28DXA', api: '33053070680000' },
  ]},
];

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// Re-point every FK that can reference a well onto either another well
// (dedupe merge) or a pad (promotion) and null the well-side field.
async function repointWellRefs(
  tx: Tx,
  fromWellId: string,
  target: { toWellId: string } | { toPadId: string }
) {
  const wellData = 'toWellId' in target ? { wellId: target.toWellId } : { wellId: null, padId: target.toPadId };
  const currentWellData = 'toWellId' in target
    ? { currentWellId: target.toWellId }
    : { currentWellId: null, currentPadId: target.toPadId };
  const wellOnlyData = 'toWellId' in target ? target.toWellId : null;

  await tx.workPoint.updateMany({ where: { wellId: fromWellId }, data: wellData });
  await tx.serviceTicket.updateMany({ where: { wellId: fromWellId }, data: wellData });
  await tx.operatorHistory.updateMany({ where: { wellId: fromWellId }, data: wellData });
  await tx.routeStop.updateMany({ where: { wellId: fromWellId }, data: wellData });
  await tx.rentalAgreement.updateMany({ where: { wellId: fromWellId }, data: wellData });
  await tx.serializedEquipment.updateMany({ where: { currentWellId: fromWellId }, data: currentWellData });
  // No pad-equivalent field on these two — best effort is to repoint (merge)
  // or clear (promotion, since a pad isn't a valid override target).
  await tx.ticketLineItem.updateMany({ where: { wellIdOverride: fromWellId }, data: { wellIdOverride: wellOnlyData } });
  await tx.fitTestRecord.updateMany({ where: { wellId: fromWellId }, data: { wellId: wellOnlyData } });
  await tx.dmrReferenceWell.updateMany({ where: { matchedWellId: fromWellId }, data: { matchedWellId: wellOnlyData } });
}

// RentalAgreement.wellIds is a denormalized JSON array, invisible to the
// relation-based counts above — check it directly so we never silently drop
// a well out of an active rental's well list.
async function assertNoJsonArrayReferences(wellId: string) {
  const rows = await prisma.$queryRaw<{ id: string; agreement_number: string }[]>`
    SELECT id, agreement_number FROM rental_agreements
    WHERE well_ids::text LIKE ${'%"' + wellId + '"%'}
  `;
  if (rows.length > 0) {
    throw new Error(
      `Well ${wellId} appears in rental_agreements.well_ids JSON array for: ${rows.map(r => r.agreement_number).join(', ')}. ` +
      `Resolve manually before promoting — refusing to guess.`
    );
  }
}

interface Summary {
  padsCreated: number;
  padsSkipped: number;
  wellsUpserted: number;
  wellsRetired: number;
  duplicatesMerged: number;
}

async function upsertChildren(
  tx: Tx,
  padDef: PadDef,
  padId: string,
  fieldId: string,
  currentOperatorId: string | null,
  isDryRun: boolean,
  summary: Summary
) {
  for (const child of padDef.children) {
    console.log(`    upsert well ${child.wellName} (${child.api})`);
    if (isDryRun) {
      summary.wellsUpserted++;
      continue;
    }
    await tx.well.upsert({
      where: { apiNumber: child.api },
      create: {
        wellName: child.wellName,
        apiNumber: child.api,
        padId,
        fieldId,
        currentOperatorId,
        isActiveForService: true,
      },
      update: {
        padId,
        isActiveForService: true,
      },
    });
    summary.wellsUpserted++;
  }
}

async function findStandInWell(tx: Tx, padName: string) {
  const resolvedName = WELL_NAME_OVERRIDE[padName] || padName;
  const candidates = await tx.well.findMany({
    where: { wellName: { equals: resolvedName, mode: 'insensitive' } },
    include: {
      _count: { select: { serviceTickets: true, workPoints: true } },
    },
  });

  if (candidates.length === 0) {
    throw new Error(`No stand-in well found for pad "${padName}" (resolved name "${resolvedName}")`);
  }
  if (candidates.length === 1) {
    return { survivor: candidates[0], duplicates: [] as typeof candidates };
  }

  // Multiple stand-in wells with the same name (import duplication bug).
  // Survivor = most service history; ties broken by earliest creation.
  const sorted = [...candidates].sort((a, b) => {
    const aScore = a._count.serviceTickets * 1000 + a._count.workPoints;
    const bScore = b._count.serviceTickets * 1000 + b._count.workPoints;
    if (bScore !== aScore) return bScore - aScore;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return { survivor: sorted[0], duplicates: sorted.slice(1) };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Pad Promotion${dryRun ? ' (DRY RUN)' : ''} — ${PADS.length} pads\n`);

  const summary: Summary = { padsCreated: 0, padsSkipped: 0, wellsUpserted: 0, wellsRetired: 0, duplicatesMerged: 0 };
  const unmergedDuplicates: { padName: string; wellId: string; tickets: number }[] = [];

  for (const padDef of PADS) {
    await prisma.$transaction(async (tx) => {
      const { survivor, duplicates } = await findStandInWell(tx, padDef.padName);
      const shouldMerge = padDef.mergeDuplicates !== false;

      for (const dup of duplicates) {
        if (!shouldMerge) {
          console.log(`  [${padDef.padName}] NOT merging duplicate stand-in well ${dup.id} (${dup._count.serviceTickets} tickets) — left untouched, flagged for manual review`);
          unmergedDuplicates.push({ padName: padDef.padName, wellId: dup.id, tickets: dup._count.serviceTickets });
          continue;
        }
        console.log(`  [${padDef.padName}] merging duplicate stand-in well ${dup.id} (${dup._count.serviceTickets} tickets) into survivor ${survivor.id} (${survivor._count.serviceTickets} tickets)`);
        if (!dryRun) {
          await assertNoJsonArrayReferences(dup.id);
          await repointWellRefs(tx, dup.id, { toWellId: survivor.id });
          await tx.well.delete({ where: { id: dup.id } });
        }
        summary.duplicatesMerged++;
      }

      const existingPad = await tx.pad.findFirst({
        where: { name: { equals: padDef.padName, mode: 'insensitive' } },
      });
      if (existingPad) {
        console.log(`  [${padDef.padName}] pad already exists (${existingPad.id}) — skipping promotion, still upserting children`);
        summary.padsSkipped++;
        await upsertChildren(tx, padDef, existingPad.id, existingPad.fieldId, existingPad.currentOperatorId, dryRun, summary);
        return;
      }

      console.log(`  [${padDef.padName}] promoting stand-in well ${survivor.id} -> new pad`);
      let padId: string;
      if (dryRun) {
        padId = `dry-run-${padDef.padName}`;
      } else {
        await assertNoJsonArrayReferences(survivor.id);
        const pad = await tx.pad.create({
          data: {
            name: padDef.padName,
            fieldId: survivor.fieldId,
            currentOperatorId: survivor.currentOperatorId,
            section: survivor.section,
            township: survivor.township,
            range: survivor.range,
            latitude: survivor.latitude,
            longitude: survivor.longitude,
            county: survivor.county,
            isActive: true,
            manuallyVerified: true,
          },
        });
        padId = pad.id;
        await repointWellRefs(tx, survivor.id, { toPadId: padId });
        await tx.well.delete({ where: { id: survivor.id } });
      }
      summary.padsCreated++;
      summary.wellsRetired++;

      await upsertChildren(tx, padDef, padId, survivor.fieldId, survivor.currentOperatorId, dryRun, summary);
    });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Summary${dryRun ? ' (dry run)' : ''}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  Pads created:          ${summary.padsCreated}`);
  console.log(`  Pads already existed:  ${summary.padsSkipped}`);
  if (unmergedDuplicates.length > 0) {
    console.log(`\n  Duplicates left untouched (need manual review):`);
    for (const d of unmergedDuplicates) {
      console.log(`    - ${d.padName}: well ${d.wellId} (${d.tickets} tickets)`);
    }
  }
  console.log(`  Stand-in wells retired:${summary.wellsRetired}`);
  console.log(`  Duplicate wells merged:${summary.duplicatesMerged}`);
  console.log(`  Child wells upserted:  ${summary.wellsUpserted}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Fatal error:', e);
    prisma.$disconnect();
    process.exit(1);
  });
