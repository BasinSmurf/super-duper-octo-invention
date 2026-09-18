import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.enverusSyncQueue.findMany({
    orderBy: { createdAt: 'desc' },
    take: 3,
  });

  for (const l of logs) {
    console.log(`=== ${l.id} | ${l.status} | ${l.target} ===`);
    console.log('Created:', l.createdAt);
    console.log('Error:', l.errorMessage || '(none)');
    console.log('\n--- Request Payload ---');
    console.log(JSON.stringify(l.requestPayload, null, 2));
    console.log('\n--- Response Payload ---');
    console.log(JSON.stringify(l.responsePayload, null, 2));
    console.log('\n');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
