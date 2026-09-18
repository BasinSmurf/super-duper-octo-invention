import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const entries = await prisma.enverusSyncQueue.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  console.log(`=== ${entries.length} Enverus Queue Entries ===\n`);

  for (const e of entries) {
    console.log(`--- ${e.id} | ${e.status} | ${e.action} | ${e.endpointUrl} ---`);
    console.log('Created:', e.createdAt.toISOString());
    console.log('Entity:', e.entityType, e.entityId);

    // Parse and pretty-print the request payload
    if (e.requestPayload) {
      try {
        const parsed = JSON.parse(e.requestPayload);
        console.log('\nRequest Payload:');
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log('\nRequest Payload (raw):', e.requestPayload.substring(0, 500));
      }
    }

    // Parse and pretty-print the response payload
    if (e.responsePayload) {
      try {
        const parsed = JSON.parse(e.responsePayload);
        console.log('\nResponse Payload:');
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log('\nResponse Payload (raw):', e.responsePayload.substring(0, 500));
      }
    }

    console.log('\nError:', e.errorMessage || '(none)');
    console.log('\n');
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
