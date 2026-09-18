import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Find Deep Creek Federal 43X-05H pad
  const pad = await p.pad.findFirst({
    where: { name: { contains: 'Deep Creek Federal 43X-05H', mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  console.log('Pad: ' + pad?.name + ' (id=' + pad?.id + ')');

  if (!pad) { await p.$disconnect(); return; }

  // Query like the API would — by padId
  const wpByPad = await p.workPoint.findMany({
    where: { padId: pad.id, isActive: true },
    orderBy: { name: 'asc' },
  });
  console.log('\nWork points by padId (' + wpByPad.length + '):');
  for (const wp of wpByPad) {
    const cd = wp.customData as any;
    const bottles = cd?.bottles || [];
    const cylinders = cd?.cylinders || [];
    console.log('  ' + wp.name + ' | reel=' + (wp.reelSerialNumber || '-') + ' | stand=' + (wp.standSerialNumber || '-'));
    console.log('    bottles: ' + bottles.length + ' | cylinders: ' + cylinders.length);
    if (bottles.length > 0) {
      console.log('    first bottle: ' + JSON.stringify(bottles[0]));
    }
  }

  // Query by wellId (how it was before — should return 0)
  const wells = await p.well.findMany({
    where: { padId: pad.id },
    select: { id: true, wellName: true },
  });
  console.log('\nWells at pad (' + wells.length + '):');
  for (const w of wells) console.log('  ' + w.wellName + ' (id=' + w.id + ')');

  const wellIds = wells.map(w => w.id);
  const wpByWell = await p.workPoint.findMany({
    where: { wellId: { in: wellIds } },
  });
  console.log('\nWork points by wellIds: ' + wpByWell.length + ' (this was the old broken query)');

  // Now test OR logic (how the new API works)
  const wpCombined = await p.workPoint.findMany({
    where: {
      OR: [
        { wellId: { in: wellIds } },
        { padId: pad.id },
      ],
      isActive: true,
    },
    orderBy: { name: 'asc' },
  });
  console.log('Work points by OR(wellIds, padId): ' + wpCombined.length + ' (new fixed query)');

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
