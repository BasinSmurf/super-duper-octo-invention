import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const searches = ['conoco', 'chord', 'oasis', 'whiting', 'conocophillips', 'newfield'];

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
    console.log(`\n"${term}" → ${matches.length} matches:`);
    for (const m of matches) {
      console.log(`  ${m.id} | "${m.name}" | qb="${m.qbCustomerFullName}"`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
