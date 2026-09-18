/**
 * Create a test invoice and queue it for QBWC to push as a Sales Order.
 *
 * This uses generic QB names that should work in any test company file.
 * QB will create the customer/items if they don't exist (or you can pre-create them).
 */
import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

async function main() {
  // Use first company in DB as the test customer
  const company = await p.company.findFirst({ select: { id: true, name: true } });
  if (!company) throw new Error('No companies in DB');

  // Generate invoice number
  const year = new Date().getFullYear();
  const last = await p.invoice.findFirst({
    where: { invoiceNumber: { startsWith: `INV-${year}-` } },
    orderBy: { invoiceNumber: 'desc' },
    select: { invoiceNumber: true },
  });
  let seq = 1;
  if (last) {
    const parts = last.invoiceNumber.split('-');
    const lastSeq = parseInt(parts[2], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }
  const invoiceNumber = `INV-${year}-${String(seq).padStart(5, '0')}`;

  console.log(`Creating test invoice ${invoiceNumber} for ${company.name}...`);

  // Create the invoice with line items
  const invoice = await p.invoice.create({
    data: {
      invoiceNumber,
      status: 'queued',
      sourceType: 'manual',
      companyId: company.id,
      companyName: company.name,
      invoiceDate: new Date(),
      subtotal: 350.00,
      taxAmount: 0,
      total: 350.00,
      notes: 'QBWC test Sales Order',
      lineItems: {
        create: [
          {
            lineNumber: 1,
            description: 'Air monitoring service - test',
            quantity: 2,
            unitOfMeasure: 'EA',
            rate: 125.00,
            amount: 250.00,
            isTaxable: false,
            sortOrder: 1,
            // No QB item mapping - QB will need a generic item or will error
            // That's fine for testing - we want to see what happens
          },
          {
            lineNumber: 2,
            description: 'Calibration gas - test',
            quantity: 1,
            unitOfMeasure: 'EA',
            rate: 100.00,
            amount: 100.00,
            isTaxable: false,
            sortOrder: 2,
          },
        ],
      },
    },
    include: { lineItems: true },
  });

  console.log(`Invoice created: ${invoice.id}`);
  console.log(`  ${invoice.lineItems.length} line items, total $${invoice.total}`);

  // Queue it for QBWC
  const queueEntry = await p.qbSyncQueue.create({
    data: {
      entityType: 'sales_order',
      entityId: invoice.id,
      action: 'add',
      status: 'pending',
      priority: 3,
    },
  });

  console.log(`Queue entry created: ${queueEntry.id}`);
  console.log(`\nReady! Hit "Update Selected" in QBWC to push the Sales Order.`);
  console.log(`\nNOTE: Since company "${company.name}" has no qbCustomerFullName set,`);
  console.log(`the builder will use the company name as CustomerRef FullName.`);
  console.log(`If that customer doesn't exist in your test QB file, QB will return an error.`);
  console.log(`You may need to create a customer named "${company.name}" in QB first,`);
  console.log(`or update the company record: UPDATE companies SET qb_customer_full_name = 'YourQBCustomerName' WHERE id = '${company.id}';`);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
