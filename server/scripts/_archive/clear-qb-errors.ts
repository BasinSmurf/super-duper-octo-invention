import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const errorEntries = await prisma.qbSyncQueue.findMany({
    where: { status: 'error' },
  });
  console.log(`QB sync queue errors: ${errorEntries.length}`);
  for (const e of errorEntries) {
    console.log(`  ${e.id.slice(0,8)} | ${e.entityType}/${e.action} | retries: ${e.retryCount} | ${e.errorMessage?.slice(0, 100)}`);
  }

  if (errorEntries.length > 0) {
    const del = await prisma.qbSyncQueue.deleteMany({ where: { status: 'error' } });
    console.log(`\nDeleted ${del.count} error entries from QB queue`);
  }

  // Also show remaining queue
  const remaining = await prisma.qbSyncQueue.findMany({ orderBy: { createdAt: 'desc' } });
  console.log(`\nRemaining queue entries: ${remaining.length}`);
  for (const r of remaining) {
    console.log(`  ${r.id.slice(0,8)} | ${r.entityType}/${r.action} | ${r.status} | entity: ${r.entityId.slice(0,8)}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
