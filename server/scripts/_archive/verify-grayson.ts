import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const g = await p.company.findFirst({
    where: { name: { contains: 'Grayson', mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!g) { console.log('No Grayson'); return; }

  const padCount = await p.pad.count({ where: { currentOperatorId: g.id } });
  const wellCount = await p.well.count({ where: { currentOperatorId: g.id } });
  console.log(`${g.name}: ${padCount} pads, ${wellCount} wells`);

  const pads = await p.pad.findMany({ where: { currentOperatorId: g.id }, select: { name: true }, take: 10 });
  pads.forEach(pad => console.log('  -', pad.name));

  await p.$disconnect();
}
main();
