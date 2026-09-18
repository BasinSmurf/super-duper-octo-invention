import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const grayson = await p.company.findFirst({
    where: { name: { contains: 'Grayson', mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!grayson) { console.log('No Grayson found!'); return; }
  console.log('Target:', grayson.name, grayson.id);

  const conoco = await p.company.findFirst({
    where: { name: { contains: 'ConocoPhillips', mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!conoco) { console.log('No Conoco found!'); return; }
  console.log('Source:', conoco.name, conoco.id);

  const pads = await p.pad.findMany({
    where: { currentOperatorId: conoco.id, isActive: true },
    select: { id: true, name: true },
    take: 5,
  });
  console.log(`Transferring ${pads.length} pads:`);
  for (const pad of pads) console.log('  -', pad.name);

  const padIds = pads.map(pad => pad.id);

  // Transfer pads
  const padResult = await p.pad.updateMany({
    where: { id: { in: padIds } },
    data: { currentOperatorId: grayson.id },
  });
  console.log(`Updated ${padResult.count} pads`);

  // Transfer wells on those pads
  const wellResult = await p.well.updateMany({
    where: { padId: { in: padIds } },
    data: { currentOperatorId: grayson.id },
  });
  console.log(`Updated ${wellResult.count} wells`);

  // Create history
  for (const pad of pads) {
    await p.operatorHistory.create({
      data: {
        padId: pad.id,
        previousOperatorId: conoco.id,
        newOperatorId: grayson.id,
        effectiveDate: new Date(),
        source: 'manual',
        notes: 'Sandbox testing — Enverus dev',
      },
    });
  }
  console.log('Created history records. Done!');

  // Verify
  const count = await p.pad.count({ where: { currentOperatorId: grayson.id } });
  console.log(`Grayson now has ${count} pads`);

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
