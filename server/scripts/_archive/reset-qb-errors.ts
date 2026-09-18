import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Reset errored entries back to pending so they retry with fixed XML
  const updated = await prisma.qbSyncQueue.updateMany({
    where: { status: 'error' },
    data: { status: 'pending', retryCount: 0, errorMessage: null, qbxmlRequest: null, sentAt: null },
  });
  console.log(`Reset ${updated.count} errored queue entries back to pending`);

  const queue = await prisma.qbSyncQueue.findMany({ orderBy: { priority: 'asc' } });
  console.log(`\nQueue now has ${queue.length} entries:`);
  for (const q of queue) {
    console.log(`  ${q.id.slice(0,8)} | ${q.entityType}/${q.action} | ${q.status} | pri: ${q.priority}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
