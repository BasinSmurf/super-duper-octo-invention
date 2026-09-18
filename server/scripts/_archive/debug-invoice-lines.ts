import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find the most recent non-void invoice
  const invoice = await prisma.invoice.findFirst({
    where: { status: { not: 'void' } },
    orderBy: { createdAt: 'desc' },
    include: {
      lineItems: {
        orderBy: { sortOrder: 'asc' },
        include: { product: { select: { id: true, partNumber: true, name: true, qbItemFullName: true } } },
      },
    },
  });

  if (!invoice) { console.log('No invoices found'); return; }

  console.log(`=== Invoice ${invoice.invoiceNumber} (${invoice.status}) ===`);
  console.log(`Total: $${invoice.total} | Lines: ${invoice.lineItems.length}`);
  console.log('');

  for (const li of invoice.lineItems) {
    console.log(`Line #${li.lineNumber}:`);
    console.log(`  description: "${li.description}"`);
    console.log(`  partNumber: ${li.partNumber || '(none)'}`);
    console.log(`  qty: ${li.quantity} | rate: ${li.rate} | amount: ${li.amount}`);
    console.log(`  qbItemFullName: ${li.qbItemFullName || '(none)'}`);
    console.log(`  qbItemListId: ${li.qbItemListId || '(none)'}`);
    console.log(`  product.qbItemFullName: ${li.product?.qbItemFullName || '(none)'}`);
    console.log(`  sourceTicketNumber: ${li.sourceTicketNumber || '(none)'}`);
    console.log(`  notes: ${li.notes || '(none)'}`);
    console.log('');
  }

  // Also check — what does the QBXML builder do with qty=0 lines?
  console.log('=== Lines with qty=0 or amount=0 ===');
  const zeroLines = invoice.lineItems.filter(li =>
    parseFloat(li.quantity.toString()) === 0 || parseFloat(li.amount.toString()) === 0
  );
  for (const li of zeroLines) {
    console.log(`  #${li.lineNumber}: "${li.description}" qty=${li.quantity} rate=${li.rate} amount=${li.amount}`);
  }

  const billableLines = invoice.lineItems.filter(li => parseFloat(li.amount.toString()) > 0);
  console.log(`\n=== Billable lines: ${billableLines.length}, Zero lines: ${zeroLines.length} ===`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
