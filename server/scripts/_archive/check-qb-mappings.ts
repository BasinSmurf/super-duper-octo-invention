import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const companies = await p.company.findMany({
    where: { OR: [{ qbCustomerListId: { not: null } }, { qbCustomerFullName: { not: null } }] },
    select: { id: true, name: true, qbCustomerListId: true, qbCustomerFullName: true },
    take: 10,
  });
  console.log(`\nQB-mapped companies: ${companies.length}`);
  companies.forEach(c => console.log(`  ${c.name} | fullName=${c.qbCustomerFullName || '(none)'} | listId=${c.qbCustomerListId || '(none)'}`));

  const allCompanies = await p.company.findMany({ select: { id: true, name: true }, take: 5 });
  console.log(`\nFirst 5 companies (any):`);
  allCompanies.forEach(c => console.log(`  ${c.id} | ${c.name}`));

  const products = await p.product.findMany({
    where: { OR: [{ qbItemListId: { not: null } }, { qbItemFullName: { not: null } }] },
    select: { id: true, partNumber: true, name: true, qbItemFullName: true, unitPrice: true },
    take: 10,
  });
  console.log(`\nQB-mapped products: ${products.length}`);
  products.forEach(pr => console.log(`  ${pr.partNumber} | ${pr.qbItemFullName || '(none)'} | $${pr.unitPrice}`));

  const allProducts = await p.product.findMany({ select: { id: true, partNumber: true, name: true, unitPrice: true }, take: 5 });
  console.log(`\nFirst 5 products (any):`);
  allProducts.forEach(pr => console.log(`  ${pr.id} | ${pr.partNumber} | ${pr.name} | $${pr.unitPrice}`));

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
