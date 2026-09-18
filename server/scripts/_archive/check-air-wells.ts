import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Check wells flagged as having supplied air
  const airWells = await prisma.well.count({ where: { hasSuppliedAir: true } });
  console.log('Wells with hasSuppliedAir=true: ' + airWells);

  // Check air system inspection records
  const airInspections = await prisma.airSystemInspection.count();
  console.log('Air system inspections: ' + airInspections);

  // Check all tickets
  const allTickets = await prisma.serviceTicket.findMany({
    select: { id: true, ticketNumber: true, ticketType: true, serviceSubtype: true, status: true, workPointId: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  console.log('\nRecent tickets (' + allTickets.length + '):');
  for (const t of allTickets) {
    console.log('  ' + t.ticketNumber + ' | ' + t.ticketType + '/' + t.serviceSubtype + ' | ' + t.status + ' | wp=' + (t.workPointId || 'none'));
  }

  // Check if any AirSystemInspection references work points
  const inspSample = await prisma.airSystemInspection.findMany({
    take: 5,
    include: { workPoint: { select: { id: true, name: true } } },
  });
  console.log('\nSample inspections: ' + inspSample.length);
  for (const i of inspSample) {
    console.log('  ' + i.id + ' | wp=' + (i.workPoint?.name || 'NULL - ORPHANED'));
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
