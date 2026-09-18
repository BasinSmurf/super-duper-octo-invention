import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Void INV-2026-00003 (orphaned - tickets were deleted)
  const inv3 = await prisma.invoice.findFirst({ where: { invoiceNumber: 'INV-2026-00003' } });
  if (inv3 && inv3.status !== 'void') {
    await prisma.invoice.update({
      where: { id: inv3.id },
      data: { status: 'void', internalNotes: 'Voided: orphaned after ticket cleanup, no source tickets exist' },
    });
    console.log('Voided INV-2026-00003');
  }

  // Clean up any QB sync queue entries for voided invoices
  const voidedInvoices = await prisma.invoice.findMany({
    where: { status: 'void' },
    select: { id: true, invoiceNumber: true },
  });
  const voidedIds = voidedInvoices.map(i => i.id);

  if (voidedIds.length > 0) {
    const qbDel = await prisma.qbSyncQueue.deleteMany({
      where: { entityId: { in: voidedIds } },
    });
    console.log(`Deleted ${qbDel.count} QB queue entries for voided invoices`);
  }

  // Also void INV-2026-00004 if it's the $0 shop WO one
  const inv4 = await prisma.invoice.findFirst({ where: { invoiceNumber: 'INV-2026-00004' } });
  if (inv4) {
    console.log(`INV-2026-00004: ${inv4.status} | $${inv4.total}`);
  }

  // Reset any remaining errored queue entries
  const resetted = await prisma.qbSyncQueue.updateMany({
    where: { status: 'error' },
    data: { status: 'pending', retryCount: 0, errorMessage: null, qbxmlRequest: null, sentAt: null },
  });
  if (resetted.count > 0) console.log(`Reset ${resetted.count} errored queue entries`);

  // Final state
  const remaining = await prisma.qbSyncQueue.findMany({ orderBy: { createdAt: 'desc' } });
  console.log(`\nQueue: ${remaining.length} entries`);
  for (const q of remaining) {
    console.log(`  ${q.entityType}/${q.action} | ${q.status} | retries: ${q.retryCount}`);
  }

  const invoices = await prisma.invoice.findMany({ orderBy: { createdAt: 'desc' } });
  console.log(`\nInvoices: ${invoices.length}`);
  for (const i of invoices) {
    console.log(`  ${i.invoiceNumber} | ${i.status} | $${i.total} | ${i.companyName}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
