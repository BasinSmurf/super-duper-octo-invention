import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Void INV-2026-00004 - $0 shop WO invoice
  const inv4 = await prisma.invoice.findFirst({ where: { invoiceNumber: 'INV-2026-00004' } });
  if (inv4 && inv4.status !== 'void') {
    await prisma.invoice.update({
      where: { id: inv4.id },
      data: { status: 'void', internalNotes: 'Voided: $0 test invoice' },
    });
    console.log('Voided INV-2026-00004');
  }

  // Clear ALL queue entries
  const qDel = await prisma.qbSyncQueue.deleteMany({});
  console.log(`Cleared ${qDel.count} queue entries`);

  // Final state
  const invoices = await prisma.invoice.findMany({ orderBy: { createdAt: 'desc' } });
  console.log(`\nInvoices:`);
  for (const i of invoices) {
    console.log(`  ${i.invoiceNumber} | ${i.status} | $${i.total}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
