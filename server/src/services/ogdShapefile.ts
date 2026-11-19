/**
 * ND OGD Wells shapefile reader.
 *
 * The ND DMR publishes its whole well database as an ESRI shapefile ZIP at a
 * fixed address (OGD_WELLS_URL — stable for 1+ year as of 2026-11). The well
 * attributes live in the .dbf member; the geometry (.shp) is not needed since
 * the .dbf carries latitude/longitude columns.
 *
 * Zero dependencies — hand-rolled ZIP + dBASE readers over Node built-ins. The
 * OGD file is a plain (non-zip64) archive with a DEFLATE .dbf member.
 *
 * Used by the "Get newest from DMR" route (routes/dmr-import.ts) and the
 * offline converter (scripts/ogd-to-csv.ts).
 */

import { inflateRawSync } from 'zlib';

export const OGD_WELLS_URL = 'https://gis.dmr.nd.gov/downloads/oilgas/shapefile/OGD_Wells.zip';

/** True when the buffer starts with a ZIP local-file / empty / spanned signature. */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/**
 * Pull one member's bytes out of a .zip. Reads sizes/offsets from the central
 * directory (robust against streamed "data descriptor" entries whose local
 * header sizes are zeroed).
 */
export function extractZipMember(zip: Buffer, predicate: (name: string) => boolean): Buffer {
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
      if (zip.readUInt32LE(localOff) !== 0x04034b50) {
        throw new Error(`Corrupt local header for ${name}.`);
      }
      const lNameLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = zip.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(raw);   // stored
      if (method === 8) return inflateRawSync(raw); // deflate
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    }
    cd += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('No matching member found in ZIP.');
}

export interface DbfField { name: string; type: string; length: number; }

/**
 * Minimal dBASE (.dbf) reader. Returns field descriptors and every non-deleted
 * record as trimmed strings — dates as ISO YYYY-MM-DD, floats rendered plain.
 */
export function parseDbf(buf: Buffer): { fields: DbfField[]; rows: string[][] } {
  const recordCount = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);

  // Field descriptors: 32 bytes each from offset 32 until the 0x0D terminator.
  const fields: DbfField[] = [];
  let pos = 32;
  while (pos < headerLen && buf[pos] !== 0x0d) {
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

/** OGD_Wells.zip bytes → header names + string rows (the .dbf attribute table). */
export function readOgdWellsZip(zip: Buffer): { headers: string[]; rows: string[][] } {
  if (!looksLikeZip(zip)) throw new Error('Downloaded file is not a ZIP archive.');
  const dbf = extractZipMember(zip, (name) => /\.dbf$/i.test(name));
  const { fields, rows } = parseDbf(dbf);
  return { headers: fields.map((f) => f.name), rows };
}

/**
 * Download the current OGD_Wells.zip from the fixed DMR address. Returns the
 * bytes plus the server's Last-Modified (the DMR regenerates the file nightly).
 */
export async function downloadOgdWellsZip(
  url: string = OGD_WELLS_URL,
  timeoutMs = 120_000,
): Promise<{ zip: Buffer; lastModified: string | null; bytes: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`DMR download failed: HTTP ${res.status} ${res.statusText} from ${url}`);
  const zip = Buffer.from(await res.arrayBuffer());
  return { zip, lastModified: res.headers.get('last-modified'), bytes: zip.length };
}
