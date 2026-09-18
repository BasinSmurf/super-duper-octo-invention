import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const fields = await prisma.field.findMany();
  console.log('Fields: ' + fields.length);
  for (const f of fields) console.log('  ' + f.id + ' | ' + f.name + ' | ' + f.county);

  const pads = await prisma.pad.findMany();
  console.log('Pads: ' + pads.length);
  for (const p of pads) console.log('  ' + p.id + ' | ' + p.name + ' | field=' + p.fieldId + ' | op=' + p.currentOperatorId);

  const wells = await prisma.well.findMany();
  console.log('Wells: ' + wells.length);
  for (const w of wells) console.log('  ' + w.id + ' | ' + w.wellName + ' | pad=' + w.padId + ' | field=' + w.fieldId);

  const totalCo = await prisma.company.count();
  console.log('Total companies: ' + totalCo);

  // Sample companies to see QB names
  const companies = await prisma.company.findMany({
    take: 10,
    orderBy: { name: 'asc' },
    select: { id: true, name: true, qbCustomerFullName: true },
  });
  console.log('Sample companies:');
  for (const c of companies) console.log('  ' + c.id + ' | ' + c.name + ' | qb=' + c.qbCustomerFullName);

  // Check for FK constraints on wells/pads/fields
  const ticketsWithWells = await prisma.serviceTicket.count({ where: { wellId: { not: null } } });
  const ticketsWithPads = await prisma.serviceTicket.count({ where: { padId: { not: null } } });
  const ticketsWithFields = await prisma.serviceTicket.count({ where: { fieldId: { not: null } } });
  console.log('Tickets referencing wells: ' + ticketsWithWells);
  console.log('Tickets referencing pads: ' + ticketsWithPads);
  console.log('Tickets referencing fields: ' + ticketsWithFields);

  const rentalsWithWells = await prisma.rentalAgreement.count({ where: { wellId: { not: null } } });
  console.log('Rentals referencing wells: ' + rentalsWithWells);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
