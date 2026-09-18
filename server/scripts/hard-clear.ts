/**
 * Hard-clear all transactional/test data.
 * Preserves reference data: users, companies, locations (fields/pads/wells/facilities),
 * products, serialized equipment.
 *
 * Usage: npx tsx scripts/hard-clear.ts
 */
import { prisma } from '../src/db.js';

async function main() {
  console.log('🧹 Hard-clearing transactional data...\n');

  // Phase 1: Ticket children
  const fitTests = await prisma.fitTestRecord.deleteMany();
  console.log(`  fit_test_records:            ${fitTests.count}`);

  const ihTests = await prisma.ihTestRecord.deleteMany();
  console.log(`  ih_test_records:             ${ihTests.count}`);

  const trainingRoster = await prisma.trainingRosterRecord.deleteMany();
  console.log(`  training_roster_records:     ${trainingRoster.count}`);

  const airInspections = await prisma.airSystemInspection.deleteMany();
  console.log(`  air_system_inspections:      ${airInspections.count}`);

  const assemblyParts = await prisma.ticketAssemblyPartsUsed.deleteMany();
  console.log(`  ticket_assembly_parts_used:  ${assemblyParts.count}`);

  const ticketAttachments = await prisma.ticketAttachment.deleteMany();
  console.log(`  ticket_attachments:          ${ticketAttachments.count}`);

  const ticketLineItems = await prisma.ticketLineItem.deleteMany();
  console.log(`  ticket_line_items:           ${ticketLineItems.count}`);

  // Phase 2: Service tickets
  const tickets = await prisma.serviceTicket.deleteMany();
  console.log(`  service_tickets:             ${tickets.count}`);

  // Phase 3: Invoices
  const invoiceLineItems = await prisma.invoiceLineItem.deleteMany();
  console.log(`  invoice_line_items:          ${invoiceLineItems.count}`);

  const invoices = await prisma.invoice.deleteMany();
  console.log(`  invoices:                    ${invoices.count}`);

  const billingGroups = await prisma.billingGroup.deleteMany();
  console.log(`  billing_groups:              ${billingGroups.count}`);

  // Phase 4: Rentals
  const rentalDailyLogs = await prisma.rentalDailyLog.deleteMany();
  console.log(`  rental_daily_logs:           ${rentalDailyLogs.count}`);

  const rentalItems = await prisma.rentalAgreementItem.deleteMany();
  console.log(`  rental_agreement_items:      ${rentalItems.count}`);

  const rentals = await prisma.rentalAgreement.deleteMany();
  console.log(`  rental_agreements:           ${rentals.count}`);

  // Phase 5: Repair orders (legacy)
  const repairLabor = await prisma.repairOrderLabor.deleteMany();
  console.log(`  repair_order_labor:          ${repairLabor.count}`);

  const repairParts = await prisma.repairOrderPart.deleteMany();
  console.log(`  repair_order_parts:          ${repairParts.count}`);

  const repairOrders = await prisma.repairOrder.deleteMany();
  console.log(`  repair_orders:               ${repairOrders.count}`);

  // Phase 6: Shop work orders
  const shopStatusLogs = await prisma.shopItemStatusLog.deleteMany();
  console.log(`  shop_item_status_log:        ${shopStatusLogs.count}`);

  const shopItems = await prisma.shopWorkOrderItem.deleteMany();
  console.log(`  shop_work_order_items:       ${shopItems.count}`);

  const shopWOs = await prisma.shopWorkOrder.deleteMany();
  console.log(`  shop_work_orders:            ${shopWOs.count}`);

  // Phase 7: Service routes
  const routeVisits = await prisma.routeCycleVisit.deleteMany();
  console.log(`  route_cycle_visits:          ${routeVisits.count}`);

  const routeCycles = await prisma.routeCycle.deleteMany();
  console.log(`  route_cycles:                ${routeCycles.count}`);

  const routeStops = await prisma.routeStop.deleteMany();
  console.log(`  route_stops:                 ${routeStops.count}`);

  const routes = await prisma.serviceRoute.deleteMany();
  console.log(`  service_routes:              ${routes.count}`);

  // Phase 8: Sync queues
  const qbQueue = await prisma.qbSyncQueue.deleteMany();
  console.log(`  qb_sync_queue:               ${qbQueue.count}`);

  const enverusQueue = await prisma.enverusSyncQueue.deleteMany();
  console.log(`  enverus_sync_queue:          ${enverusQueue.count}`);

  // Phase 9: Audit log
  const auditLogs = await prisma.auditLog.deleteMany();
  console.log(`  audit_log:                   ${auditLogs.count}`);

  console.log('\n✅ All transactional data cleared.');
  console.log('   Reference data preserved: users, companies, locations, products, equipment.');

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
