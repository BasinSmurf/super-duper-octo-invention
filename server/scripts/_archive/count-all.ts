import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const counts: Record<string, number> = {
    serviceTickets: await p.serviceTicket.count(),
    ticketLineItems: await p.ticketLineItem.count(),
    ticketAttachments: await p.ticketAttachment.count(),
    fitTestRecords: await p.fitTestRecord.count(),
    ihTestRecords: await p.ihTestRecord.count(),
    trainingRosterRecords: await p.trainingRosterRecord.count(),
    airSystemInspections: await p.airSystemInspection.count(),
    invoices: await p.invoice.count(),
    invoiceLineItems: await p.invoiceLineItem.count(),
    billingGroups: await p.billingGroup.count(),
    rentalAgreements: await p.rentalAgreement.count(),
    rentalAgreementItems: await p.rentalAgreementItem.count(),
    shopWorkOrders: await p.shopWorkOrder.count(),
    shopWorkOrderItems: await p.shopWorkOrderItem.count(),
    repairOrders: await p.repairOrder.count(),
    qbSyncQueue: await p.qbSyncQueue.count(),
    auditLog: await p.auditLog.count(),
    legacyTickets: await p.legacyTicket.count(),
    // Reference data (should NOT be cleared)
    companies: await p.company.count(),
    products: await p.product.count(),
    users: await p.user.count(),
    serializedEquipment: await p.serializedEquipment.count(),
  };

  console.log('\n=== Transactional Data ===');
  for (const [k, v] of Object.entries(counts)) {
    if (['companies', 'products', 'users', 'serializedEquipment'].includes(k)) continue;
    if (v > 0) console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== Reference Data (preserved) ===');
  console.log(`  companies: ${counts.companies}`);
  console.log(`  products: ${counts.products}`);
  console.log(`  users: ${counts.users}`);
  console.log(`  serializedEquipment: ${counts.serializedEquipment}`);

  await p.$disconnect();
}
main();
