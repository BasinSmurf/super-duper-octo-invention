import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Update Hess Corporation (the company on our test invoice) to use the QB customer name
  const updated = await p.company.update({
    where: { id: 'co-hess' },
    data: { qbCustomerFullName: 'Baker Hughes I' },
    select: { id: true, name: true, qbCustomerFullName: true },
  });
  console.log('Updated:', updated.name, '→ QB customer:', updated.qbCustomerFullName);
  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
