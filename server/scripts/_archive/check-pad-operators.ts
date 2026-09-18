import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Find the pad
  const pads = await p.pad.findMany({
    where: { name: { contains: 'Arlys', mode: 'insensitive' } },
    include: {
      currentOperator: { select: { id: true, name: true } },
      field: { select: { name: true } },
    },
  });
  console.log('=== Pads matching "Arlys" ===');
  for (const pad of pads) {
    console.log(JSON.stringify({
      id: pad.id.slice(0, 8),
      name: pad.name,
      field: pad.field?.name,
      operatorId: pad.currentOperatorId?.slice(0, 8) || 'NULL',
      operatorName: pad.currentOperator?.name || 'NONE',
      isActive: pad.isActive,
    }));
  }

  // Check how many pads each company owns
  const companies = await p.company.findMany({
    where: { name: { contains: 'Continental', mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  const chord = await p.company.findMany({ where: { name: { contains: 'Chord', mode: 'insensitive' } }, select: { id: true, name: true } });
  const grayson = await p.company.findMany({ where: { name: { contains: 'Grayson', mode: 'insensitive' } }, select: { id: true, name: true } });
  const allCos = [...companies, ...chord, ...grayson];

  console.log('\n=== Pad counts by company ===');
  for (const c of allCos) {
    const count = await p.pad.count({ where: { currentOperatorId: c.id } });
    console.log(`${c.name} (${c.id.slice(0, 8)}): ${count} pads`);
  }

  // Total pad count & how many have null operator
  const total = await p.pad.count();
  const nullOps = await p.pad.count({ where: { currentOperatorId: null } });
  console.log(`\nTotal pads: ${total}, null operator: ${nullOps}`);

  // Top pad operators
  const ops = await p.pad.groupBy({
    by: ['currentOperatorId'],
    _count: true,
    orderBy: { _count: { currentOperatorId: 'desc' } },
    take: 10,
  });
  console.log('\n=== Top pad operators ===');
  for (const o of ops) {
    const co = o.currentOperatorId
      ? await p.company.findUnique({ where: { id: o.currentOperatorId }, select: { name: true } })
      : null;
    console.log(`${co?.name || 'NULL'} (${o.currentOperatorId?.slice(0, 8) || 'null'}): ${o._count} pads`);
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
