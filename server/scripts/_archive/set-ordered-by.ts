import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find all Enverus-enabled billing profiles
  const profiles = await prisma.customerBillingProfile.findMany({
    where: { enverusEnabled: true },
    include: { company: { select: { name: true } } },
  });

  console.log(`Found ${profiles.length} Enverus-enabled profiles:`);
  for (const p of profiles) {
    console.log(`  ${p.id} | ${p.company.name} | buyerDuns: ${p.buyerDuns} | orderedBy: ${p.defaultOrderedByName || '(none)'}`);
  }

  // Set defaultOrderedByName on all profiles that have buyerDuns but no orderedBy
  for (const p of profiles) {
    if (p.buyerDuns && !p.defaultOrderedByName) {
      // Use 'OpenInvoice Admin' for sandbox testing (works for Grayson Mill)
      await prisma.customerBillingProfile.update({
        where: { id: p.id },
        data: { defaultOrderedByName: 'OpenInvoice Admin' },
      });
      console.log(`  → Set defaultOrderedByName = 'OpenInvoice Admin' on ${p.company.name}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
