/**
 * nuke-transactional.ts
 *
 * Wipes ALL transactional data (tickets, invoices, rentals, shop WOs, repairs,
 * billing groups, sync queues, audit logs) while preserving reference data
 * (companies, products, equipment definitions, users, locations, routes).
 *
 * Resets all serialized equipment back to "available" with no customer/rental links.
 *
 * Usage:  npx tsx prisma/nuke-transactional.ts
 */

import { prisma } from '../src/db.js';


async function nuke() {
  console.log('\n🔥  NUKING ALL TRANSACTIONAL DATA...\n');

  // Delete in FK-safe order: deepest children first, parents last

  // ── 1. Sync queues & audit logs (no children) ──
  const qbSync = await prisma.qbSyncQueue.deleteMany();
  console.log(`  QB sync queue:            ${qbSync.count} rows`);

  const envSync = await prisma.enverusSyncQueue.deleteMany();
  console.log(`  Enverus sync queue:       ${envSync.count} rows`);

  const audit = await prisma.auditLog.deleteMany();
  console.log(`  Audit logs:               ${audit.count} rows`);

  // ── 2. Invoice line items → Invoices ──
  const invLines = await prisma.invoiceLineItem.deleteMany();
  console.log(`  Invoice line items:       ${invLines.count} rows`);

  const invoices = await prisma.invoice.deleteMany();
  console.log(`  Invoices:                 ${invoices.count} rows`);

  // ── 3. Route cycle visits → Route cycles ──
  const cycleVisits = await prisma.routeCycleVisit.deleteMany();
  console.log(`  Route cycle visits:       ${cycleVisits.count} rows`);

  const routeCycles = await prisma.routeCycle.deleteMany();
  console.log(`  Route cycles:             ${routeCycles.count} rows`);

  // ── 4. Ticket children ──
  const ticketAssemblyParts = await prisma.ticketAssemblyPartsUsed.deleteMany();
  console.log(`  Ticket assembly parts:    ${ticketAssemblyParts.count} rows`);

  const ticketAttachments = await prisma.ticketAttachment.deleteMany();
  console.log(`  Ticket attachments:       ${ticketAttachments.count} rows`);

  const ticketLineItems = await prisma.ticketLineItem.deleteMany();
  console.log(`  Ticket line items:        ${ticketLineItems.count} rows`);

  const fitTestRecords = await prisma.fitTestRecord.deleteMany();
  console.log(`  Fit test records:         ${fitTestRecords.count} rows`);

  const airInspections = await prisma.airSystemInspection.deleteMany();
  console.log(`  Air system inspections:   ${airInspections.count} rows`);

  const ihTests = await prisma.ihTestRecord.deleteMany();
  console.log(`  IH test records:          ${ihTests.count} rows`);

  const trainingRoster = await prisma.trainingRosterRecord.deleteMany();
  console.log(`  Training roster records:  ${trainingRoster.count} rows`);

  // ── 5. Repair order children → Repair orders ──
  const repairParts = await prisma.repairOrderPart.deleteMany();
  console.log(`  Repair order parts:       ${repairParts.count} rows`);

  const repairLabor = await prisma.repairOrderLabor.deleteMany();
  console.log(`  Repair order labor:       ${repairLabor.count} rows`);

  const repairs = await prisma.repairOrder.deleteMany();
  console.log(`  Repair orders:            ${repairs.count} rows`);

  // ── 6. Shop work order children → Shop work orders ──
  const shopStatusLogs = await prisma.shopItemStatusLog.deleteMany();
  console.log(`  Shop item status logs:    ${shopStatusLogs.count} rows`);

  const shopItems = await prisma.shopWorkOrderItem.deleteMany();
  console.log(`  Shop work order items:    ${shopItems.count} rows`);

  const shopWOs = await prisma.shopWorkOrder.deleteMany();
  console.log(`  Shop work orders:         ${shopWOs.count} rows`);

  // ── 7. Reset equipment BEFORE deleting rentals (equipment FK → rental) ──
  const eqReset = await prisma.serializedEquipment.updateMany({
    data: {
      status: 'available',
      currentCustomerId: null,
      currentRentalId: null,
      currentPadId: null,
      currentWellId: null,
      currentFacilityId: null,
    },
  });
  console.log(`  Equipment reset:          ${eqReset.count} units → available`);

  // ── 8. Rental children → Rental agreements ──
  const rentalLogs = await prisma.rentalDailyLog.deleteMany();
  console.log(`  Rental daily logs:        ${rentalLogs.count} rows`);

  const rentalItems = await prisma.rentalAgreementItem.deleteMany();
  console.log(`  Rental agreement items:   ${rentalItems.count} rows`);

  const rentals = await prisma.rentalAgreement.deleteMany();
  console.log(`  Rental agreements:        ${rentals.count} rows`);

  // ── 9. Tickets (after all children removed) ──
  // First clear self-referencing sourceTicketId and FK links that would block deletion
  await prisma.serviceTicket.updateMany({
    where: { sourceTicketId: { not: null } },
    data: { sourceTicketId: null },
  });
  await prisma.serviceTicket.updateMany({
    where: { linkedRentalAgreementId: { not: null } },
    data: { linkedRentalAgreementId: null },
  });
  await prisma.serviceTicket.updateMany({
    where: { billingGroupId: { not: null } },
    data: { billingGroupId: null },
  });
  console.log(`  Ticket FK links cleared`);

  const tickets = await prisma.serviceTicket.deleteMany();
  console.log(`  Service tickets:          ${tickets.count} rows`);

  // ── 10. Billing groups (after tickets deleted) ──
  const billingGroups = await prisma.billingGroup.deleteMany();
  console.log(`  Billing groups:           ${billingGroups.count} rows`);

  console.log('\n✅  Transactional data nuked. Reference data intact.');
  console.log('   Kept: companies, products, equipment defs, users, fields/pads/wells, routes, facilities\n');
}

nuke()
  .catch((e) => {
    console.error('💥  Nuke failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
