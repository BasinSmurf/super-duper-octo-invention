import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const inv = await p.invoice.findFirst({
    where: { invoiceNumber: 'INV-2026-00004' },
    select: {
      invoiceNumber: true, status: true, companyName: true, total: true,
      qbSalesOrderTxnId: true, qbSalesOrderNumber: true, qbSalesOrderPushedAt: true,
    },
  });
  console.log(JSON.stringify(inv, null, 2));
  await p.$disconnect();
}
main();
