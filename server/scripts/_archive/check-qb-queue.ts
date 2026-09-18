import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Check QB sync queue entries
  const queue = await prisma.qbSyncQueue.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  console.log(`=== QB Sync Queue (${queue.length} entries) ===`);
  for (const q of queue) {
    console.log(`  ${q.id.slice(0,8)} | ${q.entityType}/${q.action} | status: ${q.status} | priority: ${q.priority}`);
    console.log(`    entityId: ${q.entityId.slice(0,8)}`);
    console.log(`    created: ${q.createdAt.toISOString()}`);
    if (q.processedAt) console.log(`    processed: ${q.processedAt.toISOString()}`);
    if (q.errorMessage) console.log(`    ERROR: ${q.errorMessage}`);
    if (q.retryCount > 0) console.log(`    retries: ${q.retryCount}`);
    console.log('');
  }

  // Check recent invoices
  const invoices = await prisma.invoice.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { lineItems: { select: { id: true, description: true, amount: true, qbItemFullName: true, qbItemListId: true } } },
  });

  console.log(`=== Recent Invoices (${invoices.length}) ===`);
  for (const inv of invoices) {
    console.log(`  ${inv.invoiceNumber} | ${inv.status} | $${inv.total} | ${inv.sourceType}`);
    console.log(`    company: ${inv.companyName} | companyId: ${inv.companyId.slice(0,8)}`);
    console.log(`    qbSOTxnId: ${inv.qbSalesOrderTxnId || '(none)'} | qbSONumber: ${inv.qbSalesOrderNumber || '(none)'}`);
    for (const li of inv.lineItems) {
      console.log(`    line: ${li.description?.slice(0,60)} | $${li.amount} | qbItem: ${li.qbItemFullName || '(none)'} | listId: ${li.qbItemListId || '(none)'}`);
    }
    console.log('');
  }

  // Check recent audit logs for QB-related stuff
  const audits = await prisma.auditLog.findMany({
    where: { OR: [
      { entityType: 'qb_sync' },
      { entityType: 'invoice' },
      { entityType: 'qbwc' },
    ]},
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  console.log(`=== Recent Audit Logs (${audits.length}) ===`);
  for (const a of audits) {
    console.log(`  ${a.entityType}/${a.action} | ${a.createdAt.toISOString()}`);
    if (a.changes) console.log(`    changes: ${JSON.stringify(a.changes).slice(0, 200)}`);
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
