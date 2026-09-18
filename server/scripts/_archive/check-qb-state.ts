import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // QB sync queue - all entries
  const queue = await prisma.qbSyncQueue.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  console.log(`=== QB Sync Queue (${queue.length} entries) ===`);
  for (const q of queue) {
    console.log(`  ${q.id.slice(0,8)} | ${q.entityType}/${q.action} | status: ${q.status} | pri: ${q.priority} | retries: ${q.retryCount}`);
    console.log(`    entityId: ${q.entityId.slice(0,8)} | created: ${q.createdAt.toISOString()}`);
    if (q.errorMessage) console.log(`    ERROR: ${q.errorMessage.slice(0, 200)}`);
    if (q.qbxmlRequest) console.log(`    request: ${q.qbxmlRequest.slice(0, 150)}...`);
    console.log('');
  }

  // All invoices with their SO/Invoice status
  const invoices = await prisma.invoice.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true, invoiceNumber: true, status: true, total: true,
      companyName: true, sourceType: true,
      qbSalesOrderTxnId: true, qbSalesOrderNumber: true, qbSalesOrderPushedAt: true,
      qbInvoiceTxnId: true, qbInvoiceNumber: true, qbInvoiceCreatedAt: true,
    },
  });
  console.log(`=== Invoices (${invoices.length}) ===`);
  for (const inv of invoices) {
    console.log(`  ${inv.invoiceNumber} | ${inv.status} | $${inv.total} | ${inv.sourceType}`);
    console.log(`    SO: txnId=${inv.qbSalesOrderTxnId || '(none)'} number=${inv.qbSalesOrderNumber || '(none)'} pushed=${inv.qbSalesOrderPushedAt?.toISOString() || '(none)'}`);
    console.log(`    INV: txnId=${inv.qbInvoiceTxnId || '(none)'} number=${inv.qbInvoiceNumber || '(none)'} created=${inv.qbInvoiceCreatedAt?.toISOString() || '(none)'}`);
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
