import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find entries stuck on 'submitted' that have a successful response
  const entries = await prisma.enverusSyncQueue.findMany({
    where: { status: 'submitted' },
  });

  for (const e of entries) {
    if (!e.responsePayload) continue;
    try {
      const body = JSON.parse(e.responsePayload);
      const statusCode = body?.events?.[0]?.eventStatusCode?.codeValue;
      const itemId = body?.events?.[0]?.data?.output?.receipt?.itemID;
      if (statusCode === 'completed' || e.responseStatusCode === 200) {
        console.log(`Fixing ${e.id}: ${e.entityType} ${e.entityId} → accepted (itemID: ${itemId})`);
        await prisma.enverusSyncQueue.update({
          where: { id: e.id },
          data: { status: 'accepted', respondedAt: new Date() },
        });
        // Also update the invoice
        if (e.entityType === 'invoice') {
          await prisma.invoice.update({
            where: { id: e.entityId },
            data: { enverusStatus: 'accepted' },
          });
          console.log(`  → Updated invoice ${e.entityId} enverusStatus = accepted`);
        }
      }
    } catch { /* skip */ }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
