import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find what tickets fed into INV-2026-00003
  const inv = await prisma.invoice.findFirst({
    where: { invoiceNumber: 'INV-2026-00003' },
    include: {
      lineItems: { include: { product: true } },
    },
  });
  if (!inv) { console.log('Not found'); return; }

  console.log(`Invoice: ${inv.invoiceNumber} | ${inv.status} | $${inv.total}`);
  console.log(`Source ticket IDs from line items:`);
  const ticketIds = new Set(inv.lineItems.map(li => li.sourceTicketId).filter(Boolean));
  console.log(`  ${[...ticketIds].join(', ') || '(none on lines)'}`);

  // Check all service tickets for Petro-Hunt
  const petroTickets = await prisma.serviceTicket.findMany({
    where: { companyId: inv.companyId },
    include: {
      fitTestRecords: { select: { id: true, employeeName: true } },
      trainingRosterRecords: { select: { id: true, employeeName: true } },
      lineItems: { select: { id: true, description: true, rate: true, quantity: true } },
    },
  });

  console.log(`\nAll tickets for ${inv.companyName}: ${petroTickets.length}`);
  for (const t of petroTickets) {
    console.log(`  ${t.ticketNumber} | ${t.status} | type: ${t.ticketType}/${t.serviceSubtype}`);
    console.log(`    lineItems: ${t.lineItems.length} | fitTestRecords: ${t.fitTestRecords.length} | trainingRosterRecords: ${t.trainingRosterRecords.length}`);
    for (const ftr of t.fitTestRecords) console.log(`    FTR: ${ftr.employeeName}`);
    for (const tr of t.trainingRosterRecords) console.log(`    TRR: ${tr.employeeName}`);
    for (const li of t.lineItems) console.log(`    LI: "${li.description}" qty=${li.quantity} rate=${li.rate}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
