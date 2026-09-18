import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Delete orphaned inspection (test data from pad with no air system)
  const del = await p.airSystemInspection.deleteMany({ where: { workPointId: null } });
  console.log('Deleted orphaned inspections: ' + del.count);

  // Final state
  const totalInsp = await p.airSystemInspection.count();
  const totalWp = await p.workPoint.count();
  const activeWp = await p.workPoint.count({ where: { isActive: true } });
  const wellsAir = await p.well.count({ where: { hasSuppliedAir: true } });

  console.log('\n=== Final State ===');
  console.log('WorkPoints: ' + totalWp + ' (' + activeWp + ' active)');
  console.log('AirSystemInspections: ' + totalInsp + ' (all linked)');
  console.log('Wells with hasSuppliedAir: ' + wellsAir);

  // Show remaining inspections
  const remaining = await p.airSystemInspection.findMany({
    include: {
      ticket: { select: { ticketNumber: true } },
      workPoint: { select: { name: true } },
    }
  });
  for (const r of remaining) {
    console.log('  ' + r.id + ' -> wp=' + (r.workPoint?.name || 'NONE') + ' ticket=' + (r.ticket?.ticketNumber || 'NONE'));
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
