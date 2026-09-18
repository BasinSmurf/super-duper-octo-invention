/**
 * Print the exact qbXML an invoice would push to QuickBooks — without touching
 * QBWC or the sync queue.
 *
 * Usage: npx tsx scripts/preview-qb-invoice.ts INV-2026-00099 [--so]
 *
 * Use it to check the header fields QB is fussy about (CLASS, LOCATION, the
 * sales-tax item, element order) before wondering why they came out blank in
 * QuickBooks, and to capture the payload for the FAILURE CORPUS in
 * src/services/__tests__/qbxmlBuilder.golden.test.ts when QB rejects a doc.
 */

import { prisma } from '../src/db.js';
import { buildQbDocDataFromInvoice } from '../src/routes/qbwc.js';
import { buildInvoiceAdd, buildSalesOrderAdd } from '../src/services/qbxmlBuilder.js';

async function main() {
  const ref = process.argv[2];
  const asSalesOrder = process.argv.includes('--so');
  if (!ref) {
    console.error('Usage: npx tsx scripts/preview-qb-invoice.ts <invoice-number> [--so]');
    process.exit(1);
  }

  const invoice = await prisma.invoice.findFirst({
    where: { invoiceNumber: { equals: ref, mode: 'insensitive' } },
    select: { id: true, invoiceNumber: true, division: true, isDickinson: true, sourceType: true },
  });
  if (!invoice) {
    console.error(`No invoice matching "${ref}"`);
    process.exit(1);
  }

  const data = await buildQbDocDataFromInvoice(invoice.id);

  console.log(`\n${invoice.invoiceNumber}  (${invoice.sourceType})`);
  console.log(`  frozen division : ${invoice.division ?? '(none)'}${invoice.isDickinson ? ' + Dickinson' : ''}`);
  console.log(`  QB CLASS        : ${data.classFullName ?? '(BLANK)'}`);
  console.log(`  QB LOCATION     : ${data.otherLocation ?? '(BLANK)'}`);
  console.log(`  QB tax item     : ${data.salesTaxItemFullName ?? '(none)'}`);
  console.log(`  lines           : ${data.lines.length}\n`);
  console.log(asSalesOrder ? buildSalesOrderAdd(data) : buildInvoiceAdd(data));
}

main()
  .catch(e => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Importing the QBWC route pulls in modules that hold the event loop open
    // (Redis clients, interval timers). Nothing here is long-running, so bail
    // out rather than hanging after the XML is printed.
    process.exit(process.exitCode ?? 0);
  });
