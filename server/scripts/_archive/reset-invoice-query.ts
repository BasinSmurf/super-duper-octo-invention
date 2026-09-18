import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Reset failed invoice/query entries back to pending
  const result = await prisma.qbSyncQueue.updateMany({
    where: { entityType: 'invoice', action: 'query', status: 'error' },
    data: {
      status: 'pending',
      retryCount: 0,
      errorMessage: null,
      errorCode: null,
      sentAt: null,
      completedAt: null,
      qbxmlRequest: null,
      qbxmlResponse: null,
    },
  });
  console.log(`Reset ${result.count} failed invoice/query entries to pending`);

  // Verify
  const pending = await prisma.qbSyncQueue.findMany({
    where: { status: 'pending' },
    select: { id: true, entityType: true, action: true, status: true, retryCount: true, priority: true },
  });
  console.log('Pending entries now:', pending);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
