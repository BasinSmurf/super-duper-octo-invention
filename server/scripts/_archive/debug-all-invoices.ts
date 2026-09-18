import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const invoices = await prisma.invoice.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      lineItems: {
        orderBy: { sortOrder: 'asc' },
        include: { product: { select: { partNumber: true, qbItemFullName: true } } },
      },
    },
  });

  console.log(`Total invoices: ${invoices.length}\n`);

  for (const inv of invoices) {
    console.log(`=== ${inv.invoiceNumber} | ${inv.status} | $${inv.total} | ${inv.sourceType} | ${inv.companyName} ===`);
    for (const li of inv.lineItems) {
      const amt = parseFloat(li.amount.toString());
      console.log(`  #${li.lineNumber}: ${amt > 0 ? '$' + amt : '$0'} | "${li.description.slice(0, 60)}" | part: ${li.partNumber || '-'} | qb: ${li.qbItemFullName || li.product?.qbItemFullName || '-'}`);
    }
    console.log('');
  }

  // Also check: are there any fit test tickets in billing_queue or completed?
  const fitTestTickets = await prisma.serviceTicket.findMany({
    where: { serviceSubtype: 'fit_test' },
    include: {
      fitTestRecords: { select: { id: true, employeeName: true } },
      lineItems: { select: { id: true, description: true, rate: true } },
    },
  });

  console.log(`=== Fit test tickets: ${fitTestTickets.length} ===`);
  for (const t of fitTestTickets) {
    console.log(`  ${t.ticketNumber} | ${t.status} | lineItems: ${t.lineItems.length} | fitTestRecords: ${t.fitTestRecords.length}`);
    for (const ftr of t.fitTestRecords) {
      console.log(`    FTR: ${ftr.employeeName}`);
    }
    for (const li of t.lineItems) {
      console.log(`    LI: "${li.description}" rate=${li.rate}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
