import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Seed companies have IDs like 'co-hess', 'co-continental', etc.
  // QB-imported companies have IDs like 'qb-xxxxx'
  const allCompanies = await prisma.company.findMany({
    select: { id: true, name: true, qbCustomerListId: true, qbCustomerFullName: true },
    orderBy: { name: 'asc' },
  });

  const seed = allCompanies.filter(c => c.id.startsWith('co-'));
  const qb = allCompanies.filter(c => c.id.startsWith('qb-'));
  const other = allCompanies.filter(c => !c.id.startsWith('co-') && !c.id.startsWith('qb-'));

  console.log(`=== Seed companies (${seed.length}) ===`);
  for (const c of seed) {
    console.log(`  ${c.id} | ${c.name} | qb: ${c.qbCustomerFullName || '(none)'}`);
  }

  console.log(`\n=== QB-imported companies (${qb.length}) ===`);
  console.log(`  (first 10 shown)`);
  for (const c of qb.slice(0, 10)) {
    console.log(`  ${c.id} | ${c.name} | qb: ${c.qbCustomerFullName || '(none)'}`);
  }

  if (other.length > 0) {
    console.log(`\n=== Other companies (${other.length}) ===`);
    for (const c of other) {
      console.log(`  ${c.id} | ${c.name}`);
    }
  }

  // Check if any seed companies have tickets, invoices, or other references
  for (const c of seed) {
    const tickets = await prisma.serviceTicket.count({ where: { companyId: c.id } });
    const invoices = await prisma.invoice.count({ where: { companyId: c.id } });
    const rentals = await prisma.rentalAgreement.count({ where: { companyId: c.id } });
    const shopWOs = await prisma.shopWorkOrder.count({ where: { companyId: c.id } });
    if (tickets + invoices + rentals + shopWOs > 0) {
      console.log(`\n  ⚠ ${c.name} has references: ${tickets} tickets, ${invoices} invoices, ${rentals} rentals, ${shopWOs} shop WOs`);
    }
  }

  // Also check seed products (non-QB imported)
  const seedProducts = await prisma.product.findMany({
    where: { qbItemFullName: null },
    select: { id: true, partNumber: true, name: true },
  });

  console.log(`\n=== Seed products without QB mapping (${seedProducts.length}) ===`);
  for (const p of seedProducts) {
    console.log(`  ${p.partNumber} | ${p.name}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
