import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Import Verification ===\n');

  // Counts
  const fieldCount = await prisma.field.count();
  const padCount = await prisma.pad.count();
  const wellCount = await prisma.well.count();
  console.log(`Fields: ${fieldCount}`);
  console.log(`Pads: ${padCount}`);
  console.log(`Wells: ${wellCount}`);

  // Sample fields
  console.log('\n--- Top 10 Fields by Well Count ---');
  const fields = await prisma.field.findMany({
    include: { _count: { select: { wells: true, pads: true } } },
    orderBy: { wells: { _count: 'desc' } },
    take: 10,
  });
  for (const f of fields) {
    console.log(`  ${f.name} | ${f.county || '?'} | ${f._count.wells} wells | ${f._count.pads} pads`);
  }

  // Pads with operators
  const padsWithOp = await prisma.pad.count({ where: { currentOperatorId: { not: null } } });
  const padsActive = await prisma.pad.count({ where: { isActive: true } });
  console.log(`\nPads with operator: ${padsWithOp} / ${padCount}`);
  console.log(`Pads active: ${padsActive} / ${padCount}`);

  // Wells with API numbers
  const wellsWithApi = await prisma.well.count({ where: { apiNumber: { not: null } } });
  const wellsWithCoords = await prisma.well.count({ where: { latitude: { not: null } } });
  console.log(`\nWells with API#: ${wellsWithApi} / ${wellCount}`);
  console.log(`Wells with coords: ${wellsWithCoords} / ${wellCount}`);

  // Sample a Hess pad with wells
  console.log('\n--- Sample: First pad with wells ---');
  const samplePad = await prisma.pad.findFirst({
    where: { wells: { some: { apiNumber: { not: null } } } },
    include: {
      field: true,
      currentOperator: { select: { name: true } },
      wells: { take: 5, select: { wellName: true, apiNumber: true, wellType: true, wellStatus: true, latitude: true, longitude: true, county: true } },
    },
  });
  if (samplePad) {
    console.log(`  Pad: ${samplePad.name}`);
    console.log(`  Field: ${samplePad.field.name}`);
    console.log(`  Operator: ${samplePad.currentOperator?.name || 'none'}`);
    console.log(`  County: ${samplePad.county} | Lat: ${samplePad.latitude} | Lng: ${samplePad.longitude}`);
    console.log(`  Wells:`);
    for (const w of samplePad.wells) {
      console.log(`    ${w.wellName} | API: ${w.apiNumber} | ${w.wellType}/${w.wellStatus} | ${w.latitude},${w.longitude}`);
    }
  }

  // Check company distribution
  console.log('\n--- Top Companies by Pad Count ---');
  const companyPads = await prisma.company.findMany({
    where: { pads: { some: {} } },
    include: { _count: { select: { pads: true, wells: true } } },
    orderBy: { pads: { _count: 'desc' } },
    take: 10,
  });
  for (const c of companyPads) {
    console.log(`  ${c.name} | ${c._count.pads} pads | ${c._count.wells} wells`);
  }

  // Pads without any operator (the big unmatched companies)
  const noOpPads = await prisma.pad.count({ where: { currentOperatorId: null } });
  console.log(`\nPads without operator: ${noOpPads}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
