import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Clearing all user data (tickets, rentals, invoices) ===\n');

  // Level 1: Leaf tables (no dependents)
  const steps: [string, () => Promise<{ count: number }>][] = [
    ['SiteLogEntry', () => prisma.siteLogEntry.deleteMany()],
    ['ShopItemStatusLog', () => prisma.shopItemStatusLog.deleteMany()],
    ['ShopWorkOrderItem', () => prisma.shopWorkOrderItem.deleteMany()],
    ['ShopWorkOrder', () => prisma.shopWorkOrder.deleteMany()],
    ['TicketAttachment', () => prisma.ticketAttachment.deleteMany()],
    ['FitTestRecord', () => prisma.fitTestRecord.deleteMany()],
    ['AirSystemInspection', () => prisma.airSystemInspection.deleteMany()],
    ['IhTestRecord', () => prisma.ihTestRecord.deleteMany()],
    ['TrainingRosterRecord', () => prisma.trainingRosterRecord.deleteMany()],
    ['RentalDailyLog', () => prisma.rentalDailyLog.deleteMany()],
    ['RentalAgreementItem', () => prisma.rentalAgreementItem.deleteMany()],
    ['QbSyncQueue', () => prisma.qbSyncQueue.deleteMany()],
    ['EnverusSyncQueue', () => prisma.enverusSyncQueue.deleteMany()],
    ['AuditLog', () => prisma.auditLog.deleteMany()],

    // Level 2: Line items with children
    ['TicketAssemblyPartsUsed', () => prisma.ticketAssemblyPartsUsed.deleteMany()],
    ['TicketLineItem', () => prisma.ticketLineItem.deleteMany()],

    // Level 3: Repair orders
    ['RepairOrderLabor', () => prisma.repairOrderLabor.deleteMany()],
    ['RepairOrderPart', () => prisma.repairOrderPart.deleteMany()],
    ['RepairOrder', () => prisma.repairOrder.deleteMany()],

    // Level 4: Invoice line items then invoices
    ['InvoiceLineItem', () => prisma.invoiceLineItem.deleteMany()],
    ['Invoice', () => prisma.invoice.deleteMany()],

    // Level 5: Billing groups
    ['BillingGroup', () => prisma.billingGroup.deleteMany()],

    // Level 6: Core models
    ['ServiceTicket', () => prisma.serviceTicket.deleteMany()],
    ['RentalAgreement', () => prisma.rentalAgreement.deleteMany()],
  ];

  for (const [name, fn] of steps) {
    try {
      const result = await fn();
      if (result.count > 0) {
        console.log(`  ✓ ${name}: deleted ${result.count} rows`);
      } else {
        console.log(`  - ${name}: 0 rows`);
      }
    } catch (err: any) {
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }

  // Null out rental references on equipment
  const eqUpdate = await prisma.serializedEquipment.updateMany({
    where: { currentRentalId: { not: null } },
    data: { currentRentalId: null },
  });
  if (eqUpdate.count > 0) {
    console.log(`  ✓ SerializedEquipment: cleared ${eqUpdate.count} rental refs`);
  }

  // Reset ticket number sequence
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE ticket_number_seq RESTART WITH 1`);
  console.log(`  ✓ Reset ticket_number_seq to 1`);

  console.log('\n=== Done! Database is clean for testing. ===');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
