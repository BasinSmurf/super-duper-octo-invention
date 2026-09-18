import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Clear failed Enverus invoice submissions so we can resubmit
  const deleted = await prisma.enverusSyncQueue.deleteMany({
    where: {
      entityType: 'invoice',
      status: { in: ['error', 'submitted'] },
    },
  });
  console.log(`Deleted ${deleted.count} failed/old invoice submissions`);

  // Also reset the invoice's enverusStatus so the button shows "Submit" not "Resubmit"
  const updated = await prisma.invoice.updateMany({
    where: {
      enverusStatus: { not: null },
    },
    data: {
      enverusStatus: null,
      enverusSubmittedAt: null,
    },
  });
  console.log(`Reset enverusStatus on ${updated.count} invoices`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
