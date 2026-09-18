import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Search for anything fit-test-ish in the imported QB items
  const matches = await prisma.product.findMany({
    where: { OR: [
      { name: { contains: 'fit', mode: 'insensitive' } },
      { partNumber: { contains: 'FIT', mode: 'insensitive' } },
      { qbItemFullName: { contains: 'fit', mode: 'insensitive' } },
    ]},
    select: { id: true, partNumber: true, name: true, qbItemListId: true, qbItemFullName: true, defaultSellPrice: true },
  });
  console.log('Products matching "fit":');
  for (const m of matches) {
    console.log(`  ${m.partNumber} | ${m.name} | QB: ${m.qbItemFullName || '(none)'} | ListID: ${m.qbItemListId || '(none)'} | $${m.defaultSellPrice || 0}`);
  }

  // Also search for "respirator" or "quantitative" in case it's named differently
  const alt = await prisma.product.findMany({
    where: { OR: [
      { name: { contains: 'respirator', mode: 'insensitive' } },
      { name: { contains: 'quantitative', mode: 'insensitive' } },
      { qbItemFullName: { contains: 'respirator', mode: 'insensitive' } },
    ]},
    select: { id: true, partNumber: true, name: true, qbItemListId: true, qbItemFullName: true, defaultSellPrice: true },
  });
  if (alt.length > 0) {
    console.log('\nProducts matching "respirator"/"quantitative":');
    for (const m of alt) {
      console.log(`  ${m.partNumber} | ${m.name} | QB: ${m.qbItemFullName || '(none)'} | ListID: ${m.qbItemListId || '(none)'} | $${m.defaultSellPrice || 0}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
