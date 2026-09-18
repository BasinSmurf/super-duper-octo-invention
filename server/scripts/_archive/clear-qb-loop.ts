import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Clear all the invoice/query entries that piled up from the infinite loop
  const deleted = await prisma.qbSyncQueue.deleteMany({
    where: {
      entityType: 'invoice',
      action: 'query',
    },
  });
  console.log(`Deleted ${deleted.count} invoice/query entries`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
