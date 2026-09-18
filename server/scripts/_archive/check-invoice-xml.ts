import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Get the invoice that failed
  const invoice = await prisma.invoice.findFirst({
    where: { invoiceNumber: 'INV-2026-00002' },
    include: {
      company: true,
      lineItems: {
        orderBy: { sortOrder: 'asc' },
        include: { product: { select: { qbItemListId: true, qbItemFullName: true, partNumber: true } } },
      },
    },
  });

  if (!invoice) { console.log('Invoice not found!'); return; }

  console.log('=== Invoice ===');
  console.log(`  Number: ${invoice.invoiceNumber}`);
  console.log(`  Status: ${invoice.status}`);
  console.log(`  Company: ${invoice.companyName} (id: ${invoice.companyId})`);
  console.log(`  QB Customer ListID: ${invoice.company?.qbCustomerListId || '(none)'}`);
  console.log(`  QB Customer FullName: ${(invoice.company as any)?.qbCustomerFullName || '(none)'}`);

  console.log('\n=== Line Items ===');
  for (const li of invoice.lineItems) {
    console.log(`  #${li.lineNumber}: ${li.description}`);
    console.log(`    qty: ${li.quantity} | rate: ${li.rate} | amount: ${li.amount}`);
    console.log(`    partNumber: ${li.partNumber || '(none)'}`);
    console.log(`    qbItemFullName (line): ${li.qbItemFullName || '(none)'}`);
    console.log(`    qbItemListId (line): ${li.qbItemListId || '(none)'}`);
    console.log(`    qbItemFullName (product): ${li.product?.qbItemFullName || '(none)'}`);
    console.log(`    qbItemListId (product): ${li.product?.qbItemListId || '(none)'}`);
  }

  // Now simulate what the QBXML builder would produce
  const customerListId = invoice.company?.qbCustomerListId || null;
  const customerFullName = (invoice.company as any)?.qbCustomerFullName || invoice.company?.name || invoice.companyName;

  console.log('\n=== QBXML Build Inputs ===');
  console.log(`  CustomerRef: ListID=${customerListId || '(none)'} FullName=${customerFullName}`);

  for (const li of invoice.lineItems) {
    const itemListId = li.qbItemListId || li.product?.qbItemListId || null;
    const itemFullName = li.qbItemFullName || li.product?.qbItemFullName || null;
    console.log(`  Line: ItemRef ListID=${itemListId || '(none)'} FullName=${itemFullName || '(none → fallback Misc)'}`);
    console.log(`    Desc: ${li.description}`);
    console.log(`    Qty: ${li.quantity} Rate: ${li.rate}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
