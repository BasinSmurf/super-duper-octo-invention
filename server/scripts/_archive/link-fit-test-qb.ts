import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Get the QB-imported item
  const qbItem = await prisma.product.findFirst({
    where: { partNumber: '11009' },
  });

  // Get our seed FIT-TEST product
  const fitTest = await prisma.product.findFirst({
    where: { partNumber: 'FIT-TEST' },
  });

  if (!qbItem) { console.log('QB item 11009 not found!'); return; }
  if (!fitTest) { console.log('FIT-TEST product not found!'); return; }

  console.log('QB item 11009:', { id: qbItem.id.slice(0,8), fullName: qbItem.qbItemFullName, listId: qbItem.qbItemListId });
  console.log('FIT-TEST:', { id: fitTest.id.slice(0,8), fullName: fitTest.qbItemFullName, listId: fitTest.qbItemListId, price: fitTest.defaultSellPrice?.toString() });

  // Copy QB mapping from 11009 → FIT-TEST
  await prisma.product.update({
    where: { id: fitTest.id },
    data: {
      qbItemFullName: qbItem.qbItemFullName,
      qbItemListId: qbItem.qbItemListId,
    },
  });

  console.log('\n→ Linked FIT-TEST to QB item:', qbItem.qbItemFullName);

  // Verify
  const updated = await prisma.product.findFirst({ where: { partNumber: 'FIT-TEST' } });
  console.log('Updated FIT-TEST:', {
    partNumber: updated!.partNumber,
    qbItemFullName: updated!.qbItemFullName,
    qbItemListId: updated!.qbItemListId,
    price: updated!.defaultSellPrice?.toString(),
  });

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
