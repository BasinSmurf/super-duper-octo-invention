/**
 * ND OGD Wells shapefile → import-ready CSV
 *
 * The ND DMR/OGD publishes the well database as an ESRI shapefile ZIP
 * (OGD_Wells.zip containing OGD_Wells.dbf + .shp/.shx/...). The well attributes
 * we care about live in the .dbf. This script reads the .dbf straight out of the
 * zip and writes a CSV whose headers the DMR importer already understands
 * (both scripts/import-dmr.ts and the browser route routes/dmr-import.ts).
 *
 * Zero dependencies — pure Node built-ins (so it runs anywhere `npx tsx` does,
 * no `npm install` required). Hand-rolled ZIP + dBASE readers; the OGD file is a
 * plain (non-zip64) archive with a single DEFLATE/stored .dbf member.
 *
 * Usage:
 *   npx tsx scripts/ogd-to-csv.ts <OGD_Wells.zip | OGD_Wells.dbf> [output.csv]
 *
 * Then feed the CSV to either importer:
 *   - Browser: Locations → DMR → Upload CSV
 *   - CLI:     npx tsx scripts/import-dmr.ts <output.csv>
 *
 * The importer maps the raw OGD headers (well_name, field_name, sec, twp, rng,
 * status, td, spud_date, …) and normalizes the API to the 14-digit short form,
 * so no column renaming is needed here — a faithful dump just works.
 */

import { readFileSync, writeFileSync } from 'fs';
import { inflateRawSync } from 'zlib';
import { resolve, basename } from 'path';

// ── Minimal ZIP reader: pull one member's bytes out of a .zip ──────────────
// Reads sizes/offsets from the central directory (robust against streamed
// "data descriptor" entries whose local header sizes are zeroed).
function extractZipMember(zip: Buffer, predicate: (name: string) => boolean): Buffer {
  // End Of Central Directory record: signature 0x06054b50, scan from the tail.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP (no End Of Central Directory record).');

  const cdCount = zip.readUInt16LE(eocd + 10);
  let cd = zip.readUInt32LE(eocd + 16); // offset of central directory

  for (let n = 0; n < cdCount; n++) {
    if (zip.readUInt32LE(cd) !== 0x02014b50) {
      throw new Error(`Corrupt central directory entry #${n}.`);
    }
    const method = zip.readUInt16LE(cd + 10);
    const compSize = zip.readUInt32LE(cd + 20);
    const nameLen = zip.readUInt16LE(cd + 28);
    const extraLen = zip.readUInt16LE(cd + 30);
    const commentLen = zip.readUInt16LE(cd + 32);
    const localOff = zip.readUInt32LE(cd + 42);
    const name = zip.toString('utf8', cd + 46, cd + 46 + nameLen);

    if (predicate(name)) {
      // Jump to the local file header to find where the data actually starts.
      if (zip.readUInt32LE(localOff) !== 0x04034b50) {
        throw new Error(`Corrupt local header for ${name}.`);
      }
      const lNameLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = zip.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(raw);          // stored
      if (method === 8) return inflateRawSync(raw);        // deflate
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    }
    cd += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('No matching member found in ZIP.');
}

// ── Minimal dBASE (.dbf) reader ────────────────────────────────────────────
interface DbfField { name: string; type: string; length: number; }

function parseDbf(buf: Buffer): { fields: DbfField[]; rows: string[][] } {
  const recordCount = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);

  // Field descriptors: 32 bytes each from offset 32 until the 0x0D terminator.
  const fields: DbfField[] = [];
  let pos = 32;
  while (buf[pos] !== 0x0d) {
    const rawName = buf.toString('ascii', pos, pos + 11);
    const name = rawName.replace(/\0.*$/, '').trim();
    const type = String.fromCharCode(buf[pos + 11]);
    const length = buf[pos + 16];
    fields.push({ name, type, length });
    pos += 32;
  }

  const rows: string[][] = [];
  for (let r = 0; r < recordCount; r++) {
    const recStart = headerLen + r * recordLen;
    if (recStart >= buf.length) break;
    if (buf[recStart] === 0x2a) continue; // 0x2A = deleted record
    let off = recStart + 1; // skip the deletion flag
    const row: string[] = [];
    for (const f of fields) {
      // OGD .cpg declares UTF-8; char fields are space/null padded.
      let val = buf.toString('utf8', off, off + f.length).replace(/\0/g, '').trim();
      if (f.type === 'D' && /^\d{8}$/.test(val)) {
        val = `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`; // YYYYMMDD → ISO
      } else if (f.type === 'F' && val !== '') {
        // dBASE floats are stored as ASCII scientific notation (4.69e+01); render plain.
        const n = parseFloat(val);
        if (Number.isFinite(n)) val = String(n);
      }
      row.push(val);
      off += f.length;
    }
    rows.push(row);
  }
  return { fields, rows };
}

// ── CSV writing ────────────────────────────────────────────────────────────
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ── Main ─────────────────────────────────────────────────────────────────
function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: npx tsx scripts/ogd-to-csv.ts <OGD_Wells.zip | OGD_Wells.dbf> [output.csv]');
    process.exit(1);
  }
  const inPath = resolve(input);
  const file = readFileSync(inPath);

  let dbf: Buffer;
  if (/\.zip$/i.test(inPath)) {
    console.log(`Reading ZIP: ${inPath}`);
    dbf = extractZipMember(file, (name) => /\.dbf$/i.test(name));
    console.log(`  extracted .dbf member (${dbf.length.toLocaleString()} bytes)`);
  } else {
    dbf = file;
  }

  const { fields, rows } = parseDbf(dbf);
  console.log(`Fields: ${fields.map(f => f.name).join(', ')}`);
  console.log(`Records: ${rows.length.toLocaleString()}`);

  const out = resolve(process.argv[3] || inPath.replace(/\.(zip|dbf)$/i, '') + '_import.csv');
  const lines: string[] = [];
  lines.push(fields.map(f => csvCell(f.name)).join(','));
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  writeFileSync(out, lines.join('\r\n') + '\r\n', 'utf8');

  console.log(`\nWrote ${rows.length.toLocaleString()} rows → ${out}`);
  console.log(`Next: upload it in Locations → DMR → Upload CSV, or run`);
  console.log(`  npx tsx scripts/import-dmr.ts "${out}"`);
}

main();
