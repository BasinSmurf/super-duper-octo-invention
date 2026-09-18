/**
 * Import real location data from Azure dbo CSVs into Prisma Field/Pad/Well.
 *
 * Data flow:
 *   Azure Company (match by QuickBooksName) → Sundog Company
 *   Azure Route   → used as context on Pads (route name/area stored in customData)
 *   Azure Location → Prisma Pad
 *   Azure Well     → Prisma Well
 *   DMR field_name → Prisma Field (deduplicated)
 *   DMR data       → Well enrichment (API#, lat/long, county, spud date, legal location)
 *
 * Primary source: claudius_locations_wells.csv (enriched concat with DMR data)
 * Secondary sources: Company, Route, Location, Well CSVs for additional fields
 */

import { prisma } from '../src/db.js';
import * as fs from 'fs';
import * as path from 'path';


// ----- CSV Parsing -----
function parseCSV(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header
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
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ----- Helpers -----
function toInt(val: string | undefined): number | null {
  if (!val || val === '') return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function toFloat(val: string | undefined): number | null {
  if (!val || val === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function toDate(val: string | undefined): Date | null {
  if (!val || val === '') return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function mapWellType(val: string | undefined): string | null {
  if (!val) return null;
  const map: Record<string, string> = {
    'OG': 'OG', 'SWD': 'SWD', 'WI': 'WI', 'GASD': 'GASD', 'ST': 'ST',
    'GASC': 'GASC', 'WS': 'WS', 'CO2I': 'CO2I', 'AI': 'AI', 'GI': 'GI',
  };
  return map[val.toUpperCase()] || 'other';
}

function mapWellStatus(val: string | undefined): string | null {
  if (!val) return null;
  const map: Record<string, string> = {
    'A': 'A', 'DRY': 'DRY', 'PA': 'PA', 'PNC': 'PNC', 'IA': 'IA',
    'AB': 'AB', 'LOC': 'LOC', 'DRL': 'DRL', 'TA': 'TA',
  };
  return map[val.toUpperCase()] || 'other';
}

async function main() {
  console.log('=== Location Data Import from Azure ===\n');

  // ----- Step 1: Load CSVs -----
  const basePath = 'C:\\Users\\mbart\\OneDrive\\Desktop\\NOTREBLE';
  const claudiusPath = 'C:\\Users\\mbart\\Downloads\\claudius_locations_wells.csv';

  console.log('Loading CSVs...');
  const companyRows = parseCSV(path.join(basePath, 'Company_202602230955.csv'));
  const routeRows = parseCSV(path.join(basePath, 'Route_202602191533.csv'));
  const locationRows = parseCSV(path.join(basePath, 'Location_202602191538.csv'));
  const wellRows = parseCSV(path.join(basePath, 'Well_202602230918.csv'));
  const claudiusRows = parseCSV(claudiusPath);

  console.log(`  Companies: ${companyRows.length}`);
  console.log(`  Routes: ${routeRows.length}`);
  console.log(`  Locations: ${locationRows.length}`);
  console.log(`  Wells: ${wellRows.length}`);
  console.log(`  Claudius enriched: ${claudiusRows.length}`);

  // ----- Step 2: Build Azure Company → Sundog Company mapping -----
  console.log('\nMapping Azure companies to Sundog companies...');

  // Get all Sundog companies (QB-imported)
  const sundogCompanies = await prisma.company.findMany({
    select: { id: true, name: true, qbCustomerFullName: true },
  });

  // Build lookup: lowercase QB name → company id
  const qbNameToCompanyId = new Map<string, string>();
  const nameToCompanyId = new Map<string, string>();
  for (const c of sundogCompanies) {
    if (c.qbCustomerFullName) {
      qbNameToCompanyId.set(c.qbCustomerFullName.toLowerCase().trim(), c.id);
    }
    nameToCompanyId.set(c.name.toLowerCase().trim(), c.id);
  }

  // Map Azure Company.Id → Sundog company.id
  const azureCompanyIdToSundog = new Map<string, string>();
  let matched = 0, unmatched = 0;
  const unmatchedNames: string[] = [];

  for (const row of companyRows) {
    const azureId = row['Id'];
    const qbName = (row['QuickBooksName'] || '').trim();
    const name = (row['Name'] || '').trim();
    const isDeleted = row['IsDeleted'] === '1';

    if (isDeleted) continue; // skip deleted companies

    // Try matching by QB name first, then by regular name
    let sundogId = qbName ? qbNameToCompanyId.get(qbName.toLowerCase()) : undefined;
    if (!sundogId) sundogId = nameToCompanyId.get(name.toLowerCase());
    if (!sundogId && qbName) sundogId = nameToCompanyId.get(qbName.toLowerCase());

    if (sundogId) {
      azureCompanyIdToSundog.set(azureId, sundogId);
      matched++;
    } else {
      unmatched++;
      unmatchedNames.push(`  Azure #${azureId}: "${name}" (QB: "${qbName}")`);
    }
  }

  console.log(`  Matched: ${matched}, Unmatched: ${unmatched}`);
  if (unmatchedNames.length > 0 && unmatchedNames.length <= 20) {
    console.log('  Unmatched companies:');
    for (const n of unmatchedNames) console.log(n);
  }

  // ----- Step 3: Build Route lookup -----
  const routeById = new Map<string, { name: string; companyId: string; area: string; status: string }>();
  for (const r of routeRows) {
    routeById.set(r['Id'], {
      name: r['Name'] || '',
      companyId: r['CompanyId'] || '',
      area: r['Area'] || '',
      status: r['Status'] || '0',
    });
  }

  // ----- Step 4: Build Location lookup from raw Location CSV -----
  const locationById = new Map<string, {
    name: string; routeId: string; companyId: string; clientName: string;
    afeName: string; afeNumber: string; costCenterName: string; costCenterNumber: string;
    status: string; isDeleted: string; routeMileage: string; tier1: string;
  }>();
  for (const l of locationRows) {
    locationById.set(l['Id'], {
      name: l['Name'] || '',
      routeId: l['RouteId'] || '',
      companyId: l['CompanyId'] || '',
      clientName: l['ClientName'] || '',
      afeName: l['AfeName'] || '',
      afeNumber: l['AfeNumber'] || '',
      costCenterName: l['CostCenterName'] || '',
      costCenterNumber: l['CostCenterNumber'] || '',
      status: l['Status'] || '0',
      isDeleted: l['IsDeleted'] || '0',
      routeMileage: l['RouteMileage'] || '',
      tier1: l['Tier1'] || '',
    });
  }

  // ----- Step 5: Process claudius concat — build Field / Pad / Well records -----
  console.log('\nProcessing claudius enriched data...');

  // Collect unique field names from DMR data
  const fieldNames = new Map<string, { county: string }>(); // fieldName → first county seen
  // Collect unique locations → Pads
  const padsByLocId = new Map<string, {
    locationId: string;
    name: string;
    companyId: string; // Azure company ID
    routeId: string;
    routeName: string;
    clientName: string;
    fieldName: string; // DMR field name (may be empty)
    county: string;
    latitude: number | null;
    longitude: number | null;
    section: number | null;
    township: number | null;
    range: number | null;
    afeName: string;
    afeNumber: string;
    costCenterName: string;
    costCenterNumber: string;
    status: string;
    isDeleted: string;
    routeMileage: string;
  }>();

  // Collect wells
  interface WellRecord {
    wellId: string;
    locationId: string;
    wellName: string;
    apiRef: string;
    apiNo: string;
    wellStatus: string;
    wellIsDeleted: string;
    operator: string;
    fieldName: string;
    county: string;
    wellType: string;
    dmrStatus: string;
    spudDate: string;
    qq: string;
    sec: string;
    twp: string;
    rng: string;
    feetNs: string;
    fnsl: string;
    feetEw: string;
    fewl: string;
    latitude: string;
    longitude: string;
    dmrMatch: string;
  }
  const wellsByLocId = new Map<string, WellRecord[]>();

  for (const row of claudiusRows) {
    const locId = row['location_id'];
    const wellId = row['well_id'];
    const fieldName = (row['field_name'] || '').trim();
    const county = (row['county'] || '').trim();
    const companyId = row['company_id'] || '';
    const routeId = row['route_id'] || '';
    const dmrMatch = row['dmr_match'] || '';

    // Collect DMR field names
    if (fieldName && !fieldNames.has(fieldName.toUpperCase())) {
      fieldNames.set(fieldName.toUpperCase(), { county });
    }

    // Build pad record (first occurrence wins for location-level data)
    if (!padsByLocId.has(locId)) {
      const route = routeById.get(routeId);
      const locData = locationById.get(locId);

      padsByLocId.set(locId, {
        locationId: locId,
        name: row['location_name'] || '',
        companyId: companyId,
        routeId: routeId,
        routeName: route?.name || '',
        clientName: row['client_name'] || '',
        fieldName: fieldName,
        county: county,
        latitude: toFloat(row['latitude']),
        longitude: toFloat(row['longitude']),
        section: toInt(row['sec']),
        township: toInt(row['twp']),
        range: toInt(row['rng']),
        afeName: locData?.afeName || '',
        afeNumber: locData?.afeNumber || '',
        costCenterName: locData?.costCenterName || '',
        costCenterNumber: locData?.costCenterNumber || '',
        status: row['location_status'] || '0',
        isDeleted: row['location_is_deleted'] || '0',
        routeMileage: locData?.routeMileage || '',
      });
    }

    // Update pad with DMR data if this well has better geo data
    const pad = padsByLocId.get(locId)!;
    if (dmrMatch !== 'no_wells' && dmrMatch !== 'none') {
      if (!pad.latitude && toFloat(row['latitude'])) {
        pad.latitude = toFloat(row['latitude']);
        pad.longitude = toFloat(row['longitude']);
      }
      if (!pad.county && county) pad.county = county;
      if (!pad.fieldName && fieldName) pad.fieldName = fieldName;
      if (!pad.section && toInt(row['sec'])) {
        pad.section = toInt(row['sec']);
        pad.township = toInt(row['twp']);
        pad.range = toInt(row['rng']);
      }
    }

    // Collect wells (only if there's an actual well_id)
    if (wellId && dmrMatch !== 'no_wells') {
      if (!wellsByLocId.has(locId)) wellsByLocId.set(locId, []);
      wellsByLocId.get(locId)!.push({
        wellId,
        locationId: locId,
        wellName: row['well_name'] || '',
        apiRef: row['api_ref'] || '',
        apiNo: row['api_no'] || '',
        wellStatus: row['well_status'] || '0',
        wellIsDeleted: row['well_is_deleted'] || '0',
        operator: row['operator'] || '',
        fieldName: fieldName,
        county: county,
        wellType: row['well_type'] || '',
        dmrStatus: row['dmr_status'] || '',
        spudDate: row['spud_date'] || '',
        qq: row['qq'] || '',
        sec: row['sec'] || '',
        twp: row['twp'] || '',
        rng: row['rng'] || '',
        feetNs: row['feet_ns'] || '',
        fnsl: row['fnsl'] || '',
        feetEw: row['feet_ew'] || '',
        fewl: row['fewl'] || '',
        latitude: row['latitude'] || '',
        longitude: row['longitude'] || '',
        dmrMatch: dmrMatch,
      });
    }
  }

  console.log(`  Unique DMR field names: ${fieldNames.size}`);
  console.log(`  Unique locations (pads): ${padsByLocId.size}`);
  let totalWells = 0;
  for (const wells of wellsByLocId.values()) totalWells += wells.length;
  console.log(`  Wells with data: ${totalWells}`);

  // ----- Step 6: Clear existing seed data -----
  console.log('\nClearing seed location data...');

  // Delete in order: work points → wells → pads → fields (respect FKs)
  const wpDel = await prisma.workPoint.deleteMany({});
  console.log(`  Deleted ${wpDel.count} work points`);
  const wellDel = await prisma.well.deleteMany({});
  console.log(`  Deleted ${wellDel.count} wells`);
  const padDel = await prisma.pad.deleteMany({});
  console.log(`  Deleted ${padDel.count} pads`);
  const fieldDel = await prisma.field.deleteMany({});
  console.log(`  Deleted ${fieldDel.count} fields`);

  // ----- Step 7: Create Fields from DMR field names -----
  console.log('\nCreating fields from DMR data...');

  // Also create a "UNKNOWN" field for locations without DMR match
  const fieldIdMap = new Map<string, string>(); // uppercase field name → Prisma id

  // Create UNKNOWN field first
  const unknownField = await prisma.field.create({
    data: { name: 'UNASSIGNED', county: null, state: 'ND', notes: 'Locations without a DMR field match' },
  });
  fieldIdMap.set('UNASSIGNED', unknownField.id);

  for (const [fname, data] of fieldNames) {
    const field = await prisma.field.create({
      data: { name: fname, county: data.county || null, state: 'ND' },
    });
    fieldIdMap.set(fname, field.id);
  }
  console.log(`  Created ${fieldNames.size + 1} fields (including UNASSIGNED)`);

  // ----- Step 8: Create Pads from Locations -----
  console.log('\nCreating pads from locations...');

  const padIdMap = new Map<string, string>(); // Azure location ID → Prisma pad id
  let padsCreated = 0;
  let padsSkipped = 0;

  for (const [locId, pad] of padsByLocId) {
    // Resolve field
    const fieldKey = pad.fieldName ? pad.fieldName.toUpperCase() : 'UNASSIGNED';
    const fieldId = fieldIdMap.get(fieldKey) || fieldIdMap.get('UNASSIGNED')!;

    // Resolve company (operator)
    const sundogCompanyId = azureCompanyIdToSundog.get(pad.companyId) || null;

    // Route info for customData
    const route = routeById.get(pad.routeId);

    const created = await prisma.pad.create({
      data: {
        name: pad.name || `Location ${locId}`,
        fieldId: fieldId,
        currentOperatorId: sundogCompanyId,
        section: pad.section,
        township: pad.township,
        range: pad.range,
        latitude: pad.latitude,
        longitude: pad.longitude,
        county: pad.county || null,
        isActive: pad.status !== '1' && pad.isDeleted !== '1',
        customData: {
          azureLocationId: parseInt(locId),
          azureRouteId: pad.routeId ? parseInt(pad.routeId) : null,
          routeName: route?.name || null,
          routeArea: route?.area || null,
          clientName: pad.clientName || null,
          routeMileage: pad.routeMileage ? parseFloat(pad.routeMileage) : null,
          afeName: pad.afeName || null,
          afeNumber: pad.afeNumber || null,
          costCenterName: pad.costCenterName || null,
          costCenterNumber: pad.costCenterNumber || null,
        },
      },
    });
    padIdMap.set(locId, created.id);
    padsCreated++;
  }
  console.log(`  Created ${padsCreated} pads, skipped ${padsSkipped}`);

  // ----- Step 9: Create Wells -----
  console.log('\nCreating wells...');

  let wellsCreated = 0;
  let wellsSkipped = 0;
  const seenApiNumbers = new Set<string>(); // track unique API numbers

  for (const [locId, wells] of wellsByLocId) {
    const padId = padIdMap.get(locId);
    if (!padId) {
      wellsSkipped += wells.length;
      continue;
    }

    // Get the pad's field
    const pad = padsByLocId.get(locId);
    const fieldKey = pad?.fieldName ? pad.fieldName.toUpperCase() : 'UNASSIGNED';
    const fieldId = fieldIdMap.get(fieldKey) || fieldIdMap.get('UNASSIGNED')!;

    // Resolve operator from well's operator name or fall back to pad's company
    const sundogCompanyId = azureCompanyIdToSundog.get(pad?.companyId || '') || null;

    for (const w of wells) {
      if (w.wellIsDeleted === '1') {
        wellsSkipped++;
        continue;
      }

      // Handle duplicate API numbers
      const apiNo = w.apiNo || null;
      if (apiNo && seenApiNumbers.has(apiNo)) {
        // Duplicate API number — skip (already imported)
        wellsSkipped++;
        continue;
      }
      if (apiNo) seenApiNumbers.add(apiNo);

      // Well-specific field (may differ from pad if DMR matched differently)
      const wellFieldName = w.fieldName ? w.fieldName.toUpperCase() : fieldKey;
      const wellFieldId = fieldIdMap.get(wellFieldName) || fieldId;

      try {
        await prisma.well.create({
          data: {
            padId: padId,
            fieldId: wellFieldId,
            currentOperatorId: sundogCompanyId,
            apiNumber: apiNo,
            wellName: w.wellName || null,
            wellType: mapWellType(w.wellType) as any || null,
            wellStatus: mapWellStatus(w.dmrStatus || '') as any || null,
            spudDate: toDate(w.spudDate),
            quarterQuarter: w.qq || null,
            section: toInt(w.sec),
            township: toInt(w.twp),
            range: toInt(w.rng),
            feetNs: toInt(w.feetNs),
            nsLine: w.fnsl || null,
            feetEw: toInt(w.feetEw),
            ewLine: w.fewl || null,
            latitude: toFloat(w.latitude),
            longitude: toFloat(w.longitude),
            county: w.county || null,
            isActiveForService: true,
            dmrImportDate: new Date(),
            dmrRawData: {
              azureWellId: parseInt(w.wellId),
              azureLocationId: parseInt(locId),
              apiRef: w.apiRef || null,
              dmrMatch: w.dmrMatch,
              operator: w.operator || null,
            },
            customData: {
              azureWellId: parseInt(w.wellId),
            },
          },
        });
        wellsCreated++;
      } catch (err: any) {
        if (err.code === 'P2002') {
          // Unique constraint violation (duplicate API number race)
          wellsSkipped++;
        } else {
          console.error(`  Error creating well ${w.wellName} (API: ${apiNo}):`, err.message);
          wellsSkipped++;
        }
      }
    }
  }
  console.log(`  Created ${wellsCreated} wells, skipped ${wellsSkipped}`);

  // ----- Step 10: Also import wells from raw Well CSV that may not be in claudius -----
  // The claudius concat may not include all wells (only those matched to locations)
  // Check the raw Well CSV for any wells not yet imported
  console.log('\nChecking raw Well CSV for additional wells...');

  const importedWellAzureIds = new Set<string>();
  for (const wells of wellsByLocId.values()) {
    for (const w of wells) importedWellAzureIds.add(w.wellId);
  }

  let additionalWells = 0;
  for (const row of wellRows) {
    const wellId = row['Id'];
    const isDeleted = row['IsDeleted'] === '1';
    if (isDeleted || importedWellAzureIds.has(wellId)) continue;

    const locId = row['LocationId'];
    const padId = padIdMap.get(locId);
    if (!padId) continue; // location not imported

    const pad = padsByLocId.get(locId);
    const fieldKey = pad?.fieldName ? pad.fieldName.toUpperCase() : 'UNASSIGNED';
    const fieldId = fieldIdMap.get(fieldKey) || fieldIdMap.get('UNASSIGNED')!;
    const sundogCompanyId = azureCompanyIdToSundog.get(pad?.companyId || '') || null;

    try {
      await prisma.well.create({
        data: {
          padId: padId,
          fieldId: fieldId,
          currentOperatorId: sundogCompanyId,
          wellName: row['WellName'] || null,
          apiNumber: null, // No DMR data for these
          isActiveForService: true,
          customData: { azureWellId: parseInt(wellId) },
        },
      });
      additionalWells++;
    } catch (err: any) {
      // Skip on error
    }
  }
  console.log(`  Added ${additionalWells} additional wells from raw CSV`);

  // ----- Summary -----
  const finalFields = await prisma.field.count();
  const finalPads = await prisma.pad.count();
  const finalWells = await prisma.well.count();

  console.log('\n=== Import Complete ===');
  console.log(`  Fields: ${finalFields}`);
  console.log(`  Pads: ${finalPads}`);
  console.log(`  Wells: ${finalWells}`);
  console.log(`  Companies matched: ${matched}/${matched + unmatched}`);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
