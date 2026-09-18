import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Find pads with the most work points (air systems) that also have wells
  const richPads = await p.pad.findMany({
    where: {
      workPoints: { some: { isActive: true, reelSerialNumber: { not: null } } },
      wells: { some: { hasSuppliedAir: true } },
    },
    select: {
      id: true,
      name: true,
      currentOperator: { select: { name: true } },
      field: { select: { name: true } },
      county: true,
      wells: {
        select: {
          id: true,
          wellName: true,
          wellStatus: true,
          apiNumber: true,
          hasSuppliedAir: true,
        },
        take: 5,
      },
      workPoints: {
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          reelSerialNumber: true,
          standSerialNumber: true,
          customData: true,
        },
      },
      _count: { select: { workPoints: true, wells: true } },
    },
    orderBy: { workPoints: { _count: 'desc' } },
    take: 15,
  });

  console.log('=== Top Pads with Air System Data ===\n');

  for (const pad of richPads) {
    console.log('--- ' + pad.name + ' ---');
    console.log('  Company: ' + (pad.currentOperator?.name || 'unknown'));
    console.log('  Field: ' + (pad.field?.name || 'unknown'));
    console.log('  County: ' + (pad.county || 'unknown'));
    console.log('  Wells: ' + pad._count.wells + ' | Work Points: ' + pad._count.workPoints);

    for (const wp of pad.workPoints) {
      const cd = wp.customData as any;
      const bottleCount = cd?.activeBottleCount || 0;
      const totalBottles = cd?.totalBottleCount || 0;
      console.log('  WP: ' + wp.name + ' | Reel: ' + (wp.reelSerialNumber || '-') + ' | Stand: ' + (wp.standSerialNumber || '-') + ' | Bottles: ' + bottleCount + '/' + totalBottles);

      if (cd?.bottles) {
        for (const b of cd.bottles.slice(0, 3)) {
          console.log('      Bottle: ' + b.serialNumber + ' | Hydro: ' + (b.hydroDate || '-') + ' | Active: ' + b.isActive);
        }
        if (cd.bottles.length > 3) {
          console.log('      ... and ' + (cd.bottles.length - 3) + ' more');
        }
      }
    }

    for (const w of pad.wells.slice(0, 3)) {
      console.log('  Well: ' + w.wellName + ' | API: ' + (w.apiNumber || '-') + ' | Status: ' + w.wellStatus + ' | Air: ' + w.hasSuppliedAir);
    }
    if (pad.wells.length > 3) {
      console.log('  ... and ' + (pad._count.wells - 3) + ' more wells');
    }
    console.log('');
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
