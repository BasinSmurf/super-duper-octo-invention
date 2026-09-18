import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // WP-only pads = pads that have work points but zero wells
  // These are likely dupes from the air import creating pads instead of reusing existing
  const wpOnly = await p.pad.findMany({
    where: {
      isActive: true,
      workPoints: { some: {} },
      wells: { none: {} },
    },
    select: { id: true, name: true, currentOperatorId: true, customData: true, _count: { select: { workPoints: true } } },
  });
  console.log('Pads with work points but ZERO wells: ' + wpOnly.length);
  for (const pad of wpOnly.slice(0, 15)) {
    const cd = pad.customData as any;
    console.log('  ' + pad.name + ' | wp=' + pad._count.workPoints + ' | azLoc=' + (cd?.azureLocationId || '-') + ' | op=' + (pad.currentOperatorId || '-'));
  }

  // Now cross check — the air import script sets padId on work points
  // but the LOCATION import also created pads from the same Azure locationIds
  // So both scripts created pads for the same azureLocationId
  // Let's check: for each WP-only pad, is there another pad with same operator + similar name that HAS wells?
  console.log('\n--- Checking for matching pads with wells ---');
  let matchCount = 0;
  for (const pad of wpOnly) {
    const cd = pad.customData as any;
    const azLocId = cd?.azureLocationId;
    // Find other pads with same azureLocationId
    if (azLocId) {
      const dupes = await p.pad.findMany({
        where: {
          id: { not: pad.id },
          customData: { path: ['azureLocationId'], equals: azLocId },
        },
        select: { id: true, name: true, _count: { select: { wells: true, workPoints: true } } },
      });
      if (dupes.length > 0) {
        matchCount++;
        if (matchCount <= 10) {
          console.log('\n  WP-only: ' + pad.name + ' (azLoc=' + azLocId + ', wp=' + pad._count.workPoints + ')');
          for (const d of dupes) {
            console.log('    Match: ' + d.name + ' (wells=' + d._count.wells + ', wp=' + d._count.workPoints + ')');
          }
        }
      }
    }
  }
  console.log('\nWP-only pads with a duplicate azureLocationId pad: ' + matchCount + ' / ' + wpOnly.length);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
