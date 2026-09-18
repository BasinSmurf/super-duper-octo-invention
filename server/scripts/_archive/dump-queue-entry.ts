import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const entries = await prisma.qbSyncQueue.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  for (const e of entries) {
    console.log(`=== ${e.id} | ${e.entityType}/${e.action} | ${e.status} | retries=${e.retryCount} ===`);
    console.log('Error:', e.errorMessage || '(none)');
    console.log('Request:', e.qbxmlRequest || '(none)');
    console.log('Response:', e.qbxmlResponse || '(none)');
    console.log();
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
