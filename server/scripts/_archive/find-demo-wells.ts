import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Search for Elisabeth pads
  console.log('=== Searching for "elisabeth" pads ===');
  const elisPads = await p.pad.findMany({
    where: { name: { contains: 'elisabeth', mode: 'insensitive' } },
    select: { id: true, name: true, isActive: true, currentOperatorId: true, currentOperator: { select: { name: true } } },
  });
  for (const pad of elisPads) {
    console.log('  ' + pad.name + ' | active=' + pad.isActive + ' | company=' + (pad.currentOperator?.name || 'none'));
  }

  // Search for SC Barney
  console.log('\n=== Searching for "barney" pads ===');
  const barneyPads = await p.pad.findMany({
    where: { name: { contains: 'barney', mode: 'insensitive' } },
    select: { id: true, name: true, isActive: true, currentOperator: { select: { name: true } } },
  });
  for (const pad of barneyPads) {
    console.log('  ' + pad.name + ' | active=' + pad.isActive + ' | company=' + (pad.currentOperator?.name || 'none'));
  }

  // Search for Blue Buttes
  console.log('\n=== Searching for "blue buttes" pads ===');
  const bbPads = await p.pad.findMany({
    where: { name: { contains: 'blue buttes', mode: 'insensitive' } },
    select: { id: true, name: true, isActive: true, currentOperator: { select: { name: true } } },
  });
  for (const pad of bbPads) {
    console.log('  ' + pad.name + ' | active=' + pad.isActive + ' | company=' + (pad.currentOperator?.name || 'none'));
  }

  // Search for Pederson
  console.log('\n=== Searching for "pederson" pads ===');
  const pedPads = await p.pad.findMany({
    where: { name: { contains: 'pederson', mode: 'insensitive' } },
    select: { id: true, name: true, isActive: true, currentOperator: { select: { name: true } } },
  });
  for (const pad of pedPads) {
    console.log('  ' + pad.name + ' | active=' + pad.isActive + ' | company=' + (pad.currentOperator?.name || 'none'));
  }

  // Let's also look at what companies have the most air-system-equipped pads
  console.log('\n=== Companies with most air system work points ===');
  const wpsByCompany = await p.workPoint.groupBy({
    by: ['padId'],
    where: { isActive: true, padId: { not: null } },
    _count: true,
  });

  // Get the pads and their companies
  const padIds = wpsByCompany.map(w => w.padId!).filter(Boolean);
  const padsWithCompany = await p.pad.findMany({
    where: { id: { in: padIds } },
    select: { id: true, name: true, currentOperator: { select: { id: true, name: true } } },
  });
  const padMap = new Map(padsWithCompany.map(p => [p.id, p]));

  // Count by company
  const companyCount = new Map<string, { name: string; count: number }>();
  for (const wp of wpsByCompany) {
    const pad = padMap.get(wp.padId!);
    const compName = pad?.currentOperator?.name || 'unknown';
    const compId = pad?.currentOperator?.id || 'unknown';
    const key = compId;
    if (!companyCount.has(key)) companyCount.set(key, { name: compName, count: 0 });
    companyCount.get(key)!.count += wp._count;
  }

  const sorted = Array.from(companyCount.entries()).sort((a, b) => b[1].count - a[1].count);
  for (const [id, { name, count }] of sorted.slice(0, 10)) {
    console.log('  ' + name + ': ' + count + ' active work points');
  }

  // Now find the richest wells with DMR data (API numbers, county, field)
  console.log('\n=== Wells with API numbers + air systems ===');
  const richWells = await p.well.findMany({
    where: {
      hasSuppliedAir: true,
      apiNumber: { not: null },
    },
    select: {
      id: true,
      wellName: true,
      apiNumber: true,
      wellStatus: true,
      county: true,
      pad: {
        select: {
          id: true,
          name: true,
          currentOperator: { select: { name: true } },
          field: { select: { name: true } },
          _count: { select: { workPoints: true } },
        },
      },
    },
    take: 30,
  });

  for (const w of richWells) {
    console.log('  Well: ' + w.wellName);
    console.log('    API: ' + w.apiNumber + ' | County: ' + (w.county || '-') + ' | Status: ' + w.wellStatus);
    console.log('    Pad: ' + (w.pad?.name || '-') + ' | Company: ' + (w.pad?.currentOperator?.name || '-'));
    console.log('    Field: ' + (w.pad?.field?.name || '-') + ' | WorkPoints: ' + (w.pad?._count.workPoints || 0));
    console.log('');
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
