/**
 * DMR Reference Wells CSV Import Script
 *
 * Usage: npx tsx scripts/import-dmr.ts <path-to-csv>
 *
 * Imports the ND DMR well database (43k+ wells) into the dmr_reference_wells table.
 * Handles incremental re-imports by matching on API number.
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { bulkUpsertDmr, normalizeApi } from '../src/services/dmrBulkUpsert.js';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { resolve } from 'path';


// Map CSV column headers to our fields
// Supports: standard DMR CSV, claudius/Azure export CSV, and .dbf-converted CSV
const COLUMN_MAP: Record<string, string> = {
  // Standard DMR format
  'File No': 'dmrFileNumber',
  'fileno': 'dmrFileNumber',
  'API No': 'apiNumber',
  'api': 'apiNumber',
  'Operator': 'operatorName',
  'operator': 'operatorName',
  'Well Name': 'wellName',
  'wellname': 'wellName',
  'Total Depth': 'totalDepth',
  'totaldepth': 'totalDepth',
  'Spud Date': 'spudDate',
  'spuddate': 'spudDate',
  'Field': 'fieldName',
  'field': 'fieldName',
  'QQ': 'quarterQuarter',
  'qq': 'quarterQuarter',
  'Section': 'section',
  'section': 'section',
  'Township': 'township',
  'twp': 'township',
  'Range': 'range',
  'range': 'range',
  'Feet N/S': 'feetNs',
  'feetns': 'feetNs',
  'N/S Line': 'nsLine',
  'nsline': 'nsLine',
  'Feet E/W': 'feetEw',
  'feetew': 'feetEw',
  'E/W Line': 'ewLine',
  'ewline': 'ewLine',
  'Latitude': 'latitude',
  'latitude': 'latitude',
  'Longitude': 'longitude',
  'longitude': 'longitude',
  'Well Type': 'wellType',
  'welltype': 'wellType',
  'Well Status': 'wellStatus',
  'wellstatus': 'wellStatus',
  'County': 'county',
  'county': 'county',
  'Symbol': 'symbol',
  'symbol': 'symbol',
  // Claudius/Azure export format (claudius_locations_wells.csv)
  'api_no': 'apiNumber',
  'well_name': 'wellName',
  'field_name': 'fieldName',
  'well_type': 'wellType',
  'dmr_status': 'wellStatus',
  'spud_date': 'spudDate',
  'sec': 'section',
  'feet_ns': 'feetNs',
  'fnsl': 'nsLine',
  'feet_ew': 'feetEw',
  'fewl': 'ewLine',
  'rng': 'range',
  // Also pick up the location_name as a fallback well name
  'location_name': '_locationName',
  // ND OGD shapefile export format (OGD_Wells.dbf → CSV)
  'status': 'wellStatus',
  'td': 'totalDepth',
  'fileno': 'dmrFileNumber',
  'County': 'county',
};

// Claudius CSV has a 'dmr_match' column — skip rows with these values
const SKIP_DMR_MATCH = new Set(['no_wells', 'none']);

function parseWellNameBase(wellName: string | null): string | null {
  if (!wellName) return null;
  // Strip trailing numbers, dashes, and well number patterns
  // e.g., "JERSEY 1-6H" -> "JERSEY", "FAIRBANKS 21X-35H2" -> "FAIRBANKS"
  const base = wellName.replace(/[\s-]+\d+.*$/, '').trim();
  return base || wellName;
}

function parseDate(val: string | null): Date | null {
  if (!val || val.trim() === '') return null;
  // Handle YYYYMMDD format (dBASE date fields)
  if (/^\d{8}$/.test(val.trim())) {
    const y = val.slice(0, 4), m = val.slice(4, 6), dd = val.slice(6, 8);
    const d = new Date(`${y}-${m}-${dd}`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function parseInt2(val: string | null): number | null {
  if (!val || val.trim() === '') return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function parseFloat2(val: string | null): number | null {
  if (!val || val.trim() === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

async function importDmr(csvPath: string) {
  console.log(`Importing DMR data from: ${csvPath}`);
  const batchDate = new Date();

  const rl = createInterface({
    input: createReadStream(resolve(csvPath)),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let headerMap: Record<number, string> = {};
  let lineNum = 0;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const batch: any[] = [];

  for await (const line of rl) {
    lineNum++;

    if (lineNum === 1) {
      // Parse headers
      headers = line.split(',').map(h => h.trim().replace(/^"/, '').replace(/"$/, ''));
      for (let i = 0; i < headers.length; i++) {
        const mapped = COLUMN_MAP[headers[i]];
        if (mapped) headerMap[i] = mapped;
      }
      console.log(`Headers: ${headers.join(', ')}`);
      console.log(`Mapped: ${Object.values(headerMap).join(', ')}`);
      continue;
    }

    // Simple CSV parse (handles quoted fields with commas)
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());

    // Build row object
    const raw: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      raw[headers[i]] = values[i] || '';
    }

    const row: Record<string, any> = {};
    for (let i = 0; i < values.length; i++) {
      const field = headerMap[i];
      if (field) row[field] = values[i];
    }

    // Claudius CSV: skip rows where dmr_match indicates no well data
    const dmrMatchIdx = headers.indexOf('dmr_match');
    if (dmrMatchIdx >= 0) {
      const dmrMatch = (values[dmrMatchIdx] || '').trim();
      if (SKIP_DMR_MATCH.has(dmrMatch)) {
        skipped++;
        continue;
      }
    }

    // Normalize API to the canonical 14-digit digits-only form (10-digit
    // sources get zero-padded) so any api format upserts onto the same row.
    const apiNumber = normalizeApi(row.apiNumber || null);
    if (!apiNumber) {
      skipped++;
      continue;
    }

    // Claudius CSV: use location_name as wellName fallback
    if (!row.wellName && row._locationName) {
      row.wellName = row._locationName;
    }

    batch.push({
      dmrFileNumber: parseInt2(row.dmrFileNumber),
      apiNumber,
      apiShort: apiNumber,
      operatorName: row.operatorName || null,
      wellName: row.wellName || null,
      wellNameBase: parseWellNameBase(row.wellName),
      totalDepth: parseInt2(row.totalDepth),
      spudDate: parseDate(row.spudDate),
      fieldName: row.fieldName || null,
      quarterQuarter: row.quarterQuarter || null,
      section: parseInt2(row.section),
      township: parseInt2(row.township),
      range: parseInt2(row.range),
      feetNs: parseInt2(row.feetNs),
      nsLine: row.nsLine || null,
      feetEw: parseInt2(row.feetEw),
      ewLine: row.ewLine || null,
      latitude: parseFloat2(row.latitude),
      longitude: parseFloat2(row.longitude),
      wellType: row.wellType || null,
      wellStatus: row.wellStatus || null,
      county: row.county || null,
      symbol: row.symbol || null,
      rawData: raw,
      importBatchDate: batchDate,
    });
  }

  // Bulk upsert (batched INSERT … ON CONFLICT) — seconds instead of minutes.
  console.log(`  Parsed ${batch.length} rows, upserting…`);
  const result = await bulkUpsertDmr(batch);
  imported = result.created;
  updated = result.updated;
  errors = result.errors;

  console.log(`\nImport complete:`);
  console.log(`  Total rows: ${batch.length + skipped}`);
  console.log(`  New wells: ${imported}`);
  console.log(`  Updated:   ${updated}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Errors:    ${errors}`);
}

// Main
const csvFile = process.argv[2];
if (!csvFile) {
  console.error('Usage: npx tsx scripts/import-dmr.ts <path-to-csv>');
  process.exit(1);
}

importDmr(csvFile)
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Fatal error:', e);
    prisma.$disconnect();
    process.exit(1);
  });
