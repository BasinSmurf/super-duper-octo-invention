import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // ConocoPhillips already created with qbCustomerFullName: 'ConocoPhillips'
  // User confirms QB customer name IS "ConocoPhillips" — verify it's set correctly
  const conoco = await prisma.company.findFirst({
    where: { name: 'ConocoPhillips' },
  });

  if (conoco) {
    console.log(`ConocoPhillips found: ${conoco.id}`);
    console.log(`  qbCustomerFullName: "${conoco.qbCustomerFullName}"`);
    console.log(`  qbCustomerListId: "${conoco.qbCustomerListId}"`);

    // Make sure it's set correctly
    if (conoco.qbCustomerFullName !== 'ConocoPhillips') {
      await prisma.company.update({
        where: { id: conoco.id },
        data: { qbCustomerFullName: 'ConocoPhillips' },
      });
      console.log('  Updated qbCustomerFullName to "ConocoPhillips"');
    } else {
      console.log('  Already correct!');
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
