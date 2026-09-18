import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Clearing seed data (keeping QB imports + users + equipment) ===\n');

  // 1. Clear seed companies and their transactional references
  const seedCompanyIds = ['co-basin', 'co-conoco', 'co-continental', 'co-hess', 'co-marathon', 'co-oasis', 'co-whiting'];

  // Find invoices tied to seed companies
  const seedInvoices = await prisma.invoice.findMany({
    where: { companyId: { in: seedCompanyIds } },
    select: { id: true, invoiceNumber: true },
  });
  console.log(`Invoices tied to seed companies: ${seedInvoices.length}`);

  // Delete invoice line items, then invoices
  if (seedInvoices.length > 0) {
    const invoiceIds = seedInvoices.map(i => i.id);
    const liDel = await prisma.invoiceLineItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    console.log(`  Deleted ${liDel.count} invoice line items`);

    // Delete QB sync queue entries for these invoices
    const qbDel = await prisma.qbSyncQueue.deleteMany({ where: { entityId: { in: invoiceIds } } });
    console.log(`  Deleted ${qbDel.count} QB sync queue entries`);

    const invDel = await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    console.log(`  Deleted ${invDel.count} invoices`);
  }

  // Find and delete tickets tied to seed companies
  const seedTickets = await prisma.serviceTicket.findMany({
    where: { companyId: { in: seedCompanyIds } },
    select: { id: true, ticketNumber: true },
  });
  console.log(`\nTickets tied to seed companies: ${seedTickets.length}`);

  if (seedTickets.length > 0) {
    const ticketIds = seedTickets.map(t => t.id);

    // Get line item IDs for assembly parts
    const lineItems = await prisma.ticketLineItem.findMany({
      where: { ticketId: { in: ticketIds } },
      select: { id: true },
    });
    const lineItemIds = lineItems.map(li => li.id);

    if (lineItemIds.length > 0) {
      const apDel = await prisma.ticketAssemblyPartsUsed.deleteMany({ where: { ticketLineItemId: { in: lineItemIds } } });
      console.log(`  Deleted ${apDel.count} assembly parts`);
    }

    const ftDel = await prisma.fitTestRecord.deleteMany({ where: { ticketId: { in: ticketIds } } });
    console.log(`  Deleted ${ftDel.count} fit test records`);

    const ihDel = await prisma.ihTestRecord.deleteMany({ where: { ticketId: { in: ticketIds } } });
    console.log(`  Deleted ${ihDel.count} IH test records`);

    const trDel = await prisma.trainingRosterRecord.deleteMany({ where: { ticketId: { in: ticketIds } } });
    console.log(`  Deleted ${trDel.count} training roster records`);

    const attDel = await prisma.ticketAttachment.deleteMany({ where: { ticketId: { in: ticketIds } } });
    console.log(`  Deleted ${attDel.count} attachments`);

    // Detach invoice line item refs
    await prisma.invoiceLineItem.updateMany({
      where: { sourceTicketId: { in: ticketIds } },
      data: { sourceTicketId: null, sourceTicketNumber: null },
    });

    const liDel = await prisma.ticketLineItem.deleteMany({ where: { ticketId: { in: ticketIds } } });
    console.log(`  Deleted ${liDel.count} ticket line items`);

    const tDel = await prisma.serviceTicket.deleteMany({ where: { id: { in: ticketIds } } });
    console.log(`  Deleted ${tDel.count} tickets`);
  }

  // Delete rentals tied to seed companies
  const rentalItemDel = await prisma.rentalAgreementItem.deleteMany({ where: { rentalAgreement: { companyId: { in: seedCompanyIds } } } });
  console.log(`\nDeleted ${rentalItemDel.count} rental items`);
  const renDel = await prisma.rentalAgreement.deleteMany({ where: { companyId: { in: seedCompanyIds } } });
  console.log(`Deleted ${renDel.count} rental agreements`);

  // Delete shop WOs tied to seed companies
  const shopItemDel = await prisma.shopWorkOrderItem.deleteMany({ where: { workOrder: { companyId: { in: seedCompanyIds } } } });
  console.log(`Deleted ${shopItemDel.count} shop WO items`);
  const shopDel = await prisma.shopWorkOrder.deleteMany({ where: { companyId: { in: seedCompanyIds } } });
  console.log(`Deleted ${shopDel.count} shop WOs`);

  // Note: Fields/pads/wells are shared location data, not tied to companies.
  // We keep them — they're real ND oil field locations.

  // Now delete the seed companies
  const compDel = await prisma.company.deleteMany({ where: { id: { in: seedCompanyIds } } });
  console.log(`\nDeleted ${compDel.count} seed companies`);

  // Clean up audit logs for deleted entities
  const auditDel = await prisma.auditLog.deleteMany({
    where: { entityId: { in: [...seedCompanyIds, ...seedTickets.map(t => t.id), ...seedInvoices.map(i => i.id)] } },
  });
  console.log(`Deleted ${auditDel.count} audit log entries`);

  // Summary
  const remaining = await prisma.company.count();
  const remainingProducts = await prisma.product.count();
  console.log(`\n=== Done ===`);
  console.log(`Remaining companies: ${remaining} (all QB-imported)`);
  console.log(`Remaining products: ${remainingProducts}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
