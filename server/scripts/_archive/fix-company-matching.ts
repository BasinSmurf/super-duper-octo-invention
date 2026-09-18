/**
 * Fix company matching for the big unmatched operators:
 * 1. Create ConocoPhillips as a company (Azure #157 + #168 "Conoco Inc")
 * 2. Create Chord Energy LLC and set as parent of Enerplus, Oasis, Whiting
 * 3. Update all pads/wells that have null operator to correct companies
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient();

function parseCSV(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || '').trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else current += ch;
  }
  result.push(current);
  return result;
}

async function main() {
  console.log('=== Fixing Company Matching ===\n');

  // Step 1: Create ConocoPhillips
  console.log('1. Creating ConocoPhillips...');
  let conoco = await prisma.company.findFirst({
    where: { name: { contains: 'ConocoPhillips', mode: 'insensitive' } },
  });
  if (!conoco) {
    conoco = await prisma.company.create({
      data: {
        name: 'ConocoPhillips',
        companyType: 'operator',
        qbCustomerFullName: 'ConocoPhillips',
        paymentTerms: 'Net 30',
        dueDateOffset: 30,
        isActive: true,
        state: 'ND',
      },
    });
    console.log(`  Created: ${conoco.id} | ${conoco.name}`);
  } else {
    console.log(`  Already exists: ${conoco.id} | ${conoco.name}`);
  }

  // Step 2: Create Chord Energy LLC
  console.log('\n2. Creating Chord Energy LLC...');
  let chord = await prisma.company.findFirst({
    where: { name: { contains: 'Chord Energy', mode: 'insensitive' } },
  });
  if (!chord) {
    chord = await prisma.company.create({
      data: {
        name: 'Chord Energy LLC',
        companyType: 'operator',
        qbCustomerFullName: 'Chord Energy LLC',
        paymentTerms: 'Net 30',
        dueDateOffset: 30,
        isActive: true,
        state: 'ND',
      },
    });
    console.log(`  Created: ${chord.id} | ${chord.name}`);
  } else {
    console.log(`  Already exists: ${chord.id} | ${chord.name}`);
  }

  // Step 3: Set Chord as parent of Enerplus
  console.log('\n3. Setting Chord as parent of Enerplus...');
  const enerplus = await prisma.company.findFirst({
    where: { name: { contains: 'Enerplus', mode: 'insensitive' } },
  });
  if (enerplus) {
    await prisma.company.update({
      where: { id: enerplus.id },
      data: { parentCompanyId: chord.id },
    });
    console.log(`  Enerplus (${enerplus.id}) → parent: Chord (${chord.id})`);
  }

  // Step 4: Create Oasis Petroleum as child of Chord
  console.log('\n4. Creating Oasis Petroleum...');
  let oasis = await prisma.company.findFirst({
    where: { name: { contains: 'Oasis', mode: 'insensitive' } },
  });
  if (!oasis) {
    oasis = await prisma.company.create({
      data: {
        name: 'Oasis Petroleum LLC',
        companyType: 'operator',
        parentCompanyId: chord.id,
        isActive: false, // merged into Chord
        state: 'ND',
        customData: { note: 'Merged into Chord Energy' },
      },
    });
    console.log(`  Created: ${oasis.id} | ${oasis.name} → parent: Chord`);
  } else {
    await prisma.company.update({
      where: { id: oasis.id },
      data: { parentCompanyId: chord.id },
    });
    console.log(`  Updated ${oasis.name} → parent: Chord`);
  }

  // Step 5: Create Whiting Petroleum as child of Chord
  console.log('\n5. Creating Whiting Petroleum...');
  let whiting = await prisma.company.findFirst({
    where: { name: { contains: 'Whiting', mode: 'insensitive' } },
  });
  if (!whiting) {
    whiting = await prisma.company.create({
      data: {
        name: 'Whiting Petroleum',
        companyType: 'operator',
        parentCompanyId: chord.id,
        isActive: false, // merged into Chord
        state: 'ND',
        customData: { note: 'Merged into Chord Energy' },
      },
    });
    console.log(`  Created: ${whiting.id} | ${whiting.name} → parent: Chord`);
  } else {
    await prisma.company.update({
      where: { id: whiting.id },
      data: { parentCompanyId: chord.id },
    });
    console.log(`  Updated ${whiting.name} → parent: Chord`);
  }

  // Step 6: Build Azure Company ID → Sundog mapping for the new companies
  // Azure #157 = ConocoPhillips, #168 = "DO NOT USE Conoco Inc" (same thing)
  // Azure #184 = Chord Energy LLC
  // Azure #173 = Oasis Petroleum
  // Azure #174 = Whiting Petroleum
  const azureToSundog = new Map<string, string>([
    ['157', conoco.id],
    ['168', conoco.id],  // "DO NOT USE Conoco Inc" → same as ConocoPhillips
    ['184', chord.id],
    ['173', oasis.id],
    ['174', whiting.id],
  ]);

  // Step 7: Update pads that have customData.azureLocationId and belong to these companies
  console.log('\n6. Updating pad operators...');

  // Load claudius to find which locations belong to which companies
  const claudiusPath = 'C:\\Users\\mbart\\Downloads\\claudius_locations_wells.csv';
  const claudiusRows = parseCSV(claudiusPath);

  // Build location_id → company_id map
  const locToCompany = new Map<string, string>();
  for (const row of claudiusRows) {
    const locId = row['location_id'];
    const companyId = row['company_id'];
    if (locId && companyId && !locToCompany.has(locId)) {
      locToCompany.set(locId, companyId);
    }
  }

  // Find all pads without operators
  const padsNoOp = await prisma.pad.findMany({
    where: { currentOperatorId: null },
    select: { id: true, customData: true },
  });

  let updated = 0;
  for (const pad of padsNoOp) {
    const cd = pad.customData as any;
    if (!cd || !cd.azureLocationId) continue;

    const azureLocId = String(cd.azureLocationId);
    const azureCompanyId = locToCompany.get(azureLocId);
    if (!azureCompanyId) continue;

    const sundogId = azureToSundog.get(azureCompanyId);
    if (!sundogId) continue;

    await prisma.pad.update({
      where: { id: pad.id },
      data: { currentOperatorId: sundogId },
    });
    updated++;
  }
  console.log(`  Updated ${updated} pads with operator`);

  // Step 8: Also update wells for those pads
  console.log('\n7. Updating well operators...');
  const wellsNoOp = await prisma.well.findMany({
    where: { currentOperatorId: null },
    select: { id: true, padId: true },
  });

  let wellsUpdated = 0;
  for (const well of wellsNoOp) {
    if (!well.padId) continue;
    const pad = await prisma.pad.findUnique({
      where: { id: well.padId },
      select: { currentOperatorId: true },
    });
    if (pad?.currentOperatorId) {
      await prisma.well.update({
        where: { id: well.id },
        data: { currentOperatorId: pad.currentOperatorId },
      });
      wellsUpdated++;
    }
  }
  console.log(`  Updated ${wellsUpdated} wells with operator`);

  // Step 9: Final summary
  const totalPads = await prisma.pad.count();
  const padsWithOp = await prisma.pad.count({ where: { currentOperatorId: { not: null } } });
  const totalWells = await prisma.well.count();
  const wellsWithOp = await prisma.well.count({ where: { currentOperatorId: { not: null } } });

  console.log('\n=== Final State ===');
  console.log(`  Pads with operator: ${padsWithOp} / ${totalPads}`);
  console.log(`  Wells with operator: ${wellsWithOp} / ${totalWells}`);

  // Top companies
  const topCo = await prisma.company.findMany({
    where: { pads: { some: {} } },
    include: { _count: { select: { pads: true, wells: true } } },
    orderBy: { pads: { _count: 'desc' } },
    take: 15,
  });
  console.log('\n  Top companies by pads:');
  for (const c of topCo) {
    console.log(`    ${c.name} | ${c._count.pads} pads | ${c._count.wells} wells`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
