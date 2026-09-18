/**
 * Convert .dbf (dBASE III) files to CSV for DMR import.
 *
 * Usage: npx tsx scripts/convert-dbf.ts <input.dbf> [output.csv]
 *
 * Maps Montana/ND DMR shapefile .dbf columns to the standard
 * CSV format expected by import-dmr.ts.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';

// Map .dbf field names → CSV header names (import-dmr.ts compatible)
const DBF_TO_CSV: Record<string, string> = {
  'API_WellNo': 'API No',
  'CoName':     'Operator',
  'Well_Nm':    'Well Name',
  'Status':     'Well Status',
  'Type':       'Well Type',
  'MapSymbol':  'Symbol',
  'Wh_Sec':     'Section',
  'Wh_Twpn':    'Township',
  'Wh_RngN':    'Range',
  'Wh_Qtr':     'QQ',
  'Completed':  'Spud Date',
  'DTD':        'Total Depth',
  'Reg_Field':  'Field',
  'Prod_Field': 'Prod Field',
  'St_FldNo':   'State Field No',
  'Field_No':   'Field No',
  'Wh_Twpd':    'Twp Direction',
  'Wh_RngD':    'Rng Direction',
  'DOR_ID':     'DOR ID',
};

interface DbfField {
  name: string;
  type: string;
  length: number;
  decimals: number;
}

function parseDbf(filePath: string): { fields: DbfField[]; records: Record<string, string>[] } {
  const buf = readFileSync(filePath);

  const numRecords = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);

  // Parse field descriptors (start at byte 32, each 32 bytes)
  const fields: DbfField[] = [];
  let offset = 32;
  while (offset < headerLen - 1 && buf[offset] !== 0x0D) {
    const name = buf.subarray(offset, offset + 11).toString('ascii').replace(/\0/g, '').trim();
    const type = String.fromCharCode(buf[offset + 11]);
    const length = buf[offset + 16];
    const decimals = buf[offset + 17];
    fields.push({ name, type, length, decimals });
    offset += 32;
  }

  console.log(`DBF: ${numRecords} records, ${fields.length} fields, ${recordLen} bytes/record`);
  console.log(`Fields: ${fields.map(f => f.name).join(', ')}`);

  // Read records
  const records: Record<string, string>[] = [];
  const dataStart = headerLen;
  let deleted = 0;

  for (let r = 0; r < numRecords; r++) {
    const recOffset = dataStart + (r * recordLen);
    if (buf[recOffset] === 0x2A) { deleted++; continue; } // deleted record

    let fieldOffset = recOffset + 1; // skip deletion flag
    const row: Record<string, string> = {};
    for (const f of fields) {
      row[f.name] = buf.subarray(fieldOffset, fieldOffset + f.length).toString('ascii').trim();
      fieldOffset += f.length;
    }
    records.push(row);
  }

  if (deleted > 0) console.log(`  Skipped ${deleted} deleted records`);
  return { fields, records };
}

function escapeCSV(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: npx tsx scripts/convert-dbf.ts <input.dbf> [output.csv]');
    process.exit(1);
  }

  const resolved = resolve(inputPath);
  const outputPath = process.argv[3]
    ? resolve(process.argv[3])
    : resolved.replace(/\.dbf$/i, '.csv');

  console.log(`Converting: ${resolved}`);
  console.log(`Output:     ${outputPath}`);

  const { fields, records } = parseDbf(resolved);

  // Build CSV headers — use mapped names where available
  const csvHeaders = fields.map(f => DBF_TO_CSV[f.name] || f.name);
  const lines: string[] = [csvHeaders.map(escapeCSV).join(',')];

  for (const rec of records) {
    const vals = fields.map(f => escapeCSV(rec[f.name] || ''));
    lines.push(vals.join(','));
  }

  writeFileSync(outputPath, lines.join('\n'), 'utf-8');
  console.log(`\nWrote ${records.length} records to ${basename(outputPath)}`);
}

main();
