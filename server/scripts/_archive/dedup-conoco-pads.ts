/**
 * Deduplicate ConocoPhillips pads that exist in both Azure Company #157 and #168.
 * Strategy:
 *   - Group pads by normalized name under ConocoPhillips
 *   - For each duplicate group, keep the pad with more wells (or the #157 version)
 *   - Move any orphaned wells from the loser pad to the winner pad
 *   - Delete the loser pad
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function normalize(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '');
}

async function main() {
  console.log('=== Deduplicating ConocoPhillips Pads ===\n');

  const conoco = await prisma.company.findFirst({ where: { name: 'ConocoPhillips' } });
  if (!conoco) {
    console.log('ConocoPhillips not found!');
    return;
  }

  // Get all ConocoPhillips pads with well counts
  const pads = await prisma.pad.findMany({
    where: { currentOperatorId: conoco.id },
    include: {
      _count: { select: { wells: true } },
    },
    orderBy: { name: 'asc' },
  });

  console.log(`Total ConocoPhillips pads: ${pads.length}`);

  // Group by normalized name
  const groups = new Map<string, typeof pads>();
  for (const p of pads) {
    const norm = normalize(p.name);
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm)!.push(p);
  }

  let dupeGroups = 0;
  let padsDeleted = 0;
  let wellsMoved = 0;

  for (const [norm, group] of groups) {
    if (group.length <= 1) continue;
    dupeGroups++;

    // Sort: prefer more wells, then prefer #157 (higher azureLocationId typically)
    group.sort((a, b) => {
      // More wells wins
      if (a._count.wells !== b._count.wells) return b._count.wells - a._count.wells;
      // Otherwise prefer the one from #157 (newer data, usually higher Azure location ID)
      const aLocId = (a.customData as any)?.azureLocationId || 0;
      const bLocId = (b.customData as any)?.azureLocationId || 0;
      return bLocId - aLocId;
    });

    const winner = group[0];
    const losers = group.slice(1);

    for (const loser of losers) {
      // Move wells from loser to winner
      if (loser._count.wells > 0) {
        const moved = await prisma.well.updateMany({
          where: { padId: loser.id },
          data: { padId: winner.id },
        });
        wellsMoved += moved.count;
      }

      // Check for any other FK references before deleting
      // (serviceTickets, rentalAgreements, facilities, workPoints, routeStops, serializedEquipment, operatorHistory)
      const ticketCount = await prisma.serviceTicket.count({ where: { padId: loser.id } });
      const rentalCount = await prisma.rentalAgreement.count({ where: { padId: loser.id } });
      const facilityCount = await prisma.facility.count({ where: { padId: loser.id } });
      const workPointCount = await prisma.workPoint.count({ where: { padId: loser.id } });
      const equipCount = await prisma.serializedEquipment.count({ where: { currentPadId: loser.id } });

      if (ticketCount + rentalCount + facilityCount + workPointCount + equipCount > 0) {
        console.log(`  SKIP DELETE "${loser.name}" (loc#${(loser.customData as any)?.azureLocationId}) — has ${ticketCount} tickets, ${rentalCount} rentals, ${facilityCount} facilities`);
        continue;
      }

      // Delete route stops and operator history for loser pad
      await prisma.routeStop.deleteMany({ where: { padId: loser.id } });
      await prisma.operatorHistory.deleteMany({ where: { padId: loser.id } });

      // Delete loser pad
      await prisma.pad.delete({ where: { id: loser.id } });
      padsDeleted++;
    }
  }

  console.log(`\nDuplicate groups: ${dupeGroups}`);
  console.log(`Pads deleted: ${padsDeleted}`);
  console.log(`Wells moved: ${wellsMoved}`);

  // Final counts
  const finalPads = await prisma.pad.count({ where: { currentOperatorId: conoco.id } });
  const finalWells = await prisma.well.count({ where: { currentOperatorId: conoco.id } });
  const totalPads = await prisma.pad.count();
  const totalWells = await prisma.well.count();

  console.log(`\nConocoPhillips: ${finalPads} pads, ${finalWells} wells`);
  console.log(`Total DB: ${totalPads} pads, ${totalWells} wells`);

  // Verify no more dupes
  const checkPads = await prisma.pad.findMany({
    where: { currentOperatorId: conoco.id },
    select: { name: true },
  });
  const nameSet = new Map<string, number>();
  for (const p of checkPads) {
    const norm = normalize(p.name);
    nameSet.set(norm, (nameSet.get(norm) || 0) + 1);
  }
  const remainingDupes = [...nameSet.entries()].filter(([, count]) => count > 1);
  console.log(`Remaining duplicate name groups: ${remainingDupes.length}`);
  if (remainingDupes.length > 0 && remainingDupes.length <= 10) {
    for (const [name, count] of remainingDupes) {
      console.log(`  "${name}" × ${count}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
