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

function normalize(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '') // strip all non-alphanumeric
}

async function main() {
  console.log('=== Checking ConocoPhillips Duplicate Locations ===\n');

  const claudiusRows = parseCSV('C:\\Users\\mbart\\Downloads\\claudius_locations_wells.csv');

  // Separate locations by company ID
  const co157Locs = new Map<string, { id: string; name: string; wells: string[] }>();
  const co168Locs = new Map<string, { id: string; name: string; wells: string[] }>();

  for (const row of claudiusRows) {
    const companyId = row['company_id'];
    const locId = row['location_id'];
    const locName = row['location_name'] || '';
    const wellName = row['well_name'] || '';

    if (companyId === '157') {
      if (!co157Locs.has(locId)) co157Locs.set(locId, { id: locId, name: locName, wells: [] });
      if (wellName && row['dmr_match'] !== 'no_wells') co157Locs.get(locId)!.wells.push(wellName);
    } else if (companyId === '168') {
      if (!co168Locs.has(locId)) co168Locs.set(locId, { id: locId, name: locName, wells: [] });
      if (wellName && row['dmr_match'] !== 'no_wells') co168Locs.get(locId)!.wells.push(wellName);
    }
  }

  console.log(`Company #157 (ConocoPhillips): ${co157Locs.size} locations`);
  console.log(`Company #168 (DO NOT USE Conoco Inc): ${co168Locs.size} locations`);

  // Build normalized name lookup for #157
  const norm157 = new Map<string, { id: string; name: string; wells: string[] }>();
  for (const [id, loc] of co157Locs) {
    norm157.set(normalize(loc.name), loc);
  }

  // Find exact name matches
  let exactMatches = 0;
  let fuzzyMatches = 0;
  const dupes: { loc157: any; loc168: any }[] = [];

  for (const [id, loc168] of co168Locs) {
    const normName = normalize(loc168.name);
    const match157 = norm157.get(normName);
    if (match157) {
      exactMatches++;
      dupes.push({ loc157: match157, loc168: loc168 });
    }
  }

  console.log(`\nExact name matches (normalized): ${exactMatches}`);

  // Show first 30 dupes
  if (dupes.length > 0) {
    console.log(`\n--- First ${Math.min(30, dupes.length)} Duplicate Pairs ---`);
    for (const d of dupes.slice(0, 30)) {
      console.log(`  #157 loc ${d.loc157.id}: "${d.loc157.name}" (${d.loc157.wells.length} wells)`);
      console.log(`  #168 loc ${d.loc168.id}: "${d.loc168.name}" (${d.loc168.wells.length} wells)`);
      console.log('');
    }
  }

  // Also check: are the #168 locations mostly inactive/deleted?
  const locationRows = parseCSV('C:\\Users\\mbart\\OneDrive\\Desktop\\NOTREBLE\\Location_202602191538.csv');
  let co168Active = 0, co168Inactive = 0, co168Deleted = 0;
  let co157Active = 0, co157Inactive = 0, co157Deleted = 0;

  for (const l of locationRows) {
    const cid = l['CompanyId'];
    const status = l['Status'];
    const isDeleted = l['IsDeleted'] === '1';

    if (cid === '157') {
      if (isDeleted) co157Deleted++;
      else if (status === '1') co157Inactive++;
      else co157Active++;
    } else if (cid === '168') {
      if (isDeleted) co168Deleted++;
      else if (status === '1') co168Inactive++;
      else co168Active++;
    }
  }

  console.log('\n--- Status Breakdown ---');
  console.log(`#157 (ConocoPhillips): ${co157Active} active, ${co157Inactive} inactive, ${co157Deleted} deleted`);
  console.log(`#168 (DO NOT USE):     ${co168Active} active, ${co168Inactive} inactive, ${co168Deleted} deleted`);

  // Check how many pads in Sundog DB belong to ConocoPhillips
  const conoco = await prisma.company.findFirst({ where: { name: 'ConocoPhillips' } });
  if (conoco) {
    const padCount = await prisma.pad.count({ where: { currentOperatorId: conoco.id } });
    const wellCount = await prisma.well.count({ where: { currentOperatorId: conoco.id } });

    // Check for duplicate pad names under ConocoPhillips
    const pads = await prisma.pad.findMany({
      where: { currentOperatorId: conoco.id },
      select: { id: true, name: true, isActive: true, customData: true },
      orderBy: { name: 'asc' },
    });

    const nameGroups = new Map<string, typeof pads>();
    for (const p of pads) {
      const norm = normalize(p.name);
      if (!nameGroups.has(norm)) nameGroups.set(norm, []);
      nameGroups.get(norm)!.push(p);
    }

    let dupeGroups = 0;
    let totalDupePads = 0;
    const dupeExamples: string[] = [];

    for (const [norm, group] of nameGroups) {
      if (group.length > 1) {
        dupeGroups++;
        totalDupePads += group.length;
        if (dupeExamples.length < 15) {
          const details = group.map(p => {
            const cd = p.customData as any;
            return `loc#${cd?.azureLocationId} ${p.isActive ? 'active' : 'INACTIVE'}`;
          }).join(' | ');
          dupeExamples.push(`  "${group[0].name}" (${group.length}x): ${details}`);
        }
      }
    }

    console.log(`\n--- Sundog DB: ConocoPhillips ---`);
    console.log(`Total pads: ${padCount}, wells: ${wellCount}`);
    console.log(`Duplicate pad name groups: ${dupeGroups} (${totalDupePads} total pads)`);
    if (dupeExamples.length > 0) {
      console.log('Examples:');
      for (const ex of dupeExamples) console.log(ex);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
