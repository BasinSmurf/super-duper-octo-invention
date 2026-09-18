import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Search broader terms
  const searches = [
    'conoco', 'conocophillips', 'phillips', 'cop',
    'chord', 'oasis', 'whiting', 'enerplus',
    'xto', 'exxon',
  ];

  for (const term of searches) {
    const matches = await prisma.company.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { qbCustomerFullName: { contains: term, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, qbCustomerFullName: true },
    });
    if (matches.length > 0) {
      console.log(`"${term}" → ${matches.length} matches:`);
      for (const m of matches) {
        console.log(`  ${m.id} | "${m.name}" | qb="${m.qbCustomerFullName}"`);
      }
    }
  }

  // Also dump ALL companies to see if we can find ConocoPhillips
  console.log('\n--- All company names containing "con" ---');
  const conMatches = await prisma.company.findMany({
    where: {
      OR: [
        { name: { startsWith: 'Con', mode: 'insensitive' } },
        { qbCustomerFullName: { startsWith: 'Con', mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, qbCustomerFullName: true },
  });
  for (const m of conMatches) {
    console.log(`  ${m.id} | "${m.name}" | qb="${m.qbCustomerFullName}"`);
  }

  console.log('\n--- All company names containing "ch" ---');
  const chMatches = await prisma.company.findMany({
    where: {
      OR: [
        { name: { startsWith: 'Ch', mode: 'insensitive' } },
        { qbCustomerFullName: { startsWith: 'Ch', mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, qbCustomerFullName: true },
  });
  for (const m of chMatches) {
    console.log(`  ${m.id} | "${m.name}" | qb="${m.qbCustomerFullName}"`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
