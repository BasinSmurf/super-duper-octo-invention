/**
 * Bulk upsert for dmr_reference_wells.
 *
 * The old import did a findUnique + update/create PER ROW — ~87k sequential
 * round-trips for the 43.5k-row OGD file, which takes minutes and times out the
 * browser upload. This batches into multi-row `INSERT … ON CONFLICT (api_number)
 * DO UPDATE`, turning the whole import into ~44 statements (seconds).
 *
 * Merge semantics (not overwrite): on conflict, each data column takes the
 * incoming value when present and KEEPS the existing value when the incoming
 * one is null — so a sparse pull (no lat/long column, no status, etc.) fills
 * gaps and updates statuses without wiping data a richer earlier pull loaded.
 *
 * matched_well_id / matched_company_id are intentionally NOT in the column list,
 * so existing match links survive a re-import. created_at is preserved on update.
 */

import { randomUUID } from 'node:crypto';
import { prisma, Prisma } from '../db.js';

/**
 * Canonical API-number key: digits only, with 10–13 digit forms right-padded
 * with zeros to the full 14-digit form ("3305301234" → "33053012340000").
 * ND sources disagree — DMR CSVs carry dashed 10-digit APIs, the OGD shapefile
 * carries 14-digit — and before this the same well imported under two keys,
 * stacking a duplicate row per format. Real sidetrack/event suffixes (non-zero
 * last 4) still key separately, as they should.
 */
export function normalizeApi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.length >= 10 && digits.length < 14) return digits.padEnd(14, '0');
  return digits;
}

export interface DmrUpsertRow {
  dmrFileNumber: number | null;
  apiNumber: string;
  apiShort: string | null;
  operatorName: string | null;
  wellName: string | null;
  wellNameBase: string | null;
  totalDepth: number | null;
  spudDate: Date | null;
  fieldName: string | null;
  quarterQuarter: string | null;
  section: number | null;
  township: number | null;
  range: number | null;
  feetNs: number | null;
  nsLine: string | null;
  feetEw: number | null;
  ewLine: string | null;
  latitude: number | null;
  longitude: number | null;
  wellType: string | null;
  wellStatus: string | null;
  county: string | null;
  symbol: string | null;
  rawData: unknown;
  importBatchDate: Date;
}

// 1000 rows × 27 binds = 27k params, well under Postgres' 65535 limit.
const BATCH = 1000;

/**
 * Collapse rows that share an apiNumber within one file (later non-null value
 * wins per field). Duplicate keys in a single multi-row INSERT would otherwise
 * blow up with "ON CONFLICT DO UPDATE command cannot affect row a second time"
 * and dump the whole chunk onto the slow per-row fallback.
 */
// Exported for tests: this and normalizeApi are the two functions standing
// between a re-import and duplicate reference wells, so they are pinned.
export function dedupeBatch(rows: DmrUpsertRow[]): { rows: DmrUpsertRow[]; mergedInFile: number } {
  const byApi = new Map<string, DmrUpsertRow>();
  for (const r of rows) {
    const prev = byApi.get(r.apiNumber);
    if (!prev) { byApi.set(r.apiNumber, r); continue; }
    for (const k of Object.keys(r) as (keyof DmrUpsertRow)[]) {
      const v = r[k];
      if (v !== null && v !== undefined) (prev as any)[k] = v;
    }
  }
  return { rows: [...byApi.values()], mergedInFile: rows.length - byApi.size };
}

async function upsertChunk(chunk: DmrUpsertRow[], now: Date): Promise<{ created: number; updated: number }> {
  const tuples = chunk.map((r) => Prisma.sql`(${randomUUID()}, ${r.dmrFileNumber}, ${r.apiNumber}, ${r.apiShort}, ${r.operatorName}, ${r.wellName}, ${r.wellNameBase}, ${r.totalDepth}, ${r.spudDate}, ${r.fieldName}, ${r.quarterQuarter}, ${r.section}, ${r.township}, ${r.range}, ${r.feetNs}, ${r.nsLine}, ${r.feetEw}, ${r.ewLine}, ${r.latitude}, ${r.longitude}, ${r.wellType}, ${r.wellStatus}, ${r.county}, ${r.symbol}, ${r.rawData == null ? null : JSON.stringify(r.rawData)}::jsonb, ${r.importBatchDate}, ${now}, ${now})`);

  const rows = await prisma.$queryRaw<Array<{ inserted: boolean }>>(Prisma.sql`
    INSERT INTO dmr_reference_wells (
      id, dmr_file_number, api_number, api_short, operator_name, well_name, well_name_base,
      total_depth, spud_date, field_name, quarter_quarter, section, township, "range",
      feet_ns, ns_line, feet_ew, ew_line, latitude, longitude, well_type, well_status,
      county, symbol, raw_data, import_batch_date, created_at, updated_at
    )
    VALUES ${Prisma.join(tuples)}
    ON CONFLICT (api_number) DO UPDATE SET
      dmr_file_number   = COALESCE(EXCLUDED.dmr_file_number, dmr_reference_wells.dmr_file_number),
      api_short         = COALESCE(EXCLUDED.api_short, dmr_reference_wells.api_short),
      operator_name     = COALESCE(EXCLUDED.operator_name, dmr_reference_wells.operator_name),
      well_name         = COALESCE(EXCLUDED.well_name, dmr_reference_wells.well_name),
      well_name_base    = COALESCE(EXCLUDED.well_name_base, dmr_reference_wells.well_name_base),
      total_depth       = COALESCE(EXCLUDED.total_depth, dmr_reference_wells.total_depth),
      spud_date         = COALESCE(EXCLUDED.spud_date, dmr_reference_wells.spud_date),
      field_name        = COALESCE(EXCLUDED.field_name, dmr_reference_wells.field_name),
      quarter_quarter   = COALESCE(EXCLUDED.quarter_quarter, dmr_reference_wells.quarter_quarter),
      section           = COALESCE(EXCLUDED.section, dmr_reference_wells.section),
      township          = COALESCE(EXCLUDED.township, dmr_reference_wells.township),
      "range"           = COALESCE(EXCLUDED."range", dmr_reference_wells."range"),
      feet_ns           = COALESCE(EXCLUDED.feet_ns, dmr_reference_wells.feet_ns),
      ns_line           = COALESCE(EXCLUDED.ns_line, dmr_reference_wells.ns_line),
      feet_ew           = COALESCE(EXCLUDED.feet_ew, dmr_reference_wells.feet_ew),
      ew_line           = COALESCE(EXCLUDED.ew_line, dmr_reference_wells.ew_line),
      latitude          = COALESCE(EXCLUDED.latitude, dmr_reference_wells.latitude),
      longitude         = COALESCE(EXCLUDED.longitude, dmr_reference_wells.longitude),
      well_type         = COALESCE(EXCLUDED.well_type, dmr_reference_wells.well_type),
      well_status       = COALESCE(EXCLUDED.well_status, dmr_reference_wells.well_status),
      county            = COALESCE(EXCLUDED.county, dmr_reference_wells.county),
      symbol            = COALESCE(EXCLUDED.symbol, dmr_reference_wells.symbol),
      raw_data          = COALESCE(EXCLUDED.raw_data, dmr_reference_wells.raw_data),
      import_batch_date = EXCLUDED.import_batch_date,
      updated_at        = EXCLUDED.updated_at
    RETURNING (xmax = 0) AS inserted
  `);

  let created = 0, updated = 0;
  for (const row of rows) { if (row.inserted) created++; else updated++; }
  return { created, updated };
}

/**
 * Upsert all rows (in-file duplicates merged first). Returns counts. A batch
 * that fails (e.g. an unexpected bad value) falls back to per-row upserts so
 * one bad row can't sink 1000 good ones.
 */
export async function bulkUpsertDmr(input: DmrUpsertRow[]): Promise<{ created: number; updated: number; errors: number; mergedInFile: number }> {
  const now = new Date();
  const { rows, mergedInFile } = dedupeBatch(input);
  let created = 0, updated = 0, errors = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    try {
      const r = await upsertChunk(chunk, now);
      created += r.created; updated += r.updated;
    } catch {
      // Fallback: per-row, so a single bad row only costs itself.
      for (const r of chunk) {
        try {
          const existing = await prisma.dmrReferenceWell.findUnique({ where: { apiNumber: r.apiNumber }, select: { id: true } });
          const data = {
            dmrFileNumber: r.dmrFileNumber, apiShort: r.apiShort, operatorName: r.operatorName,
            wellName: r.wellName, wellNameBase: r.wellNameBase, totalDepth: r.totalDepth, spudDate: r.spudDate,
            fieldName: r.fieldName, quarterQuarter: r.quarterQuarter, section: r.section, township: r.township,
            range: r.range, feetNs: r.feetNs, nsLine: r.nsLine, feetEw: r.feetEw, ewLine: r.ewLine,
            latitude: r.latitude, longitude: r.longitude, wellType: r.wellType, wellStatus: r.wellStatus,
            county: r.county, symbol: r.symbol, rawData: (r.rawData ?? undefined) as any, importBatchDate: r.importBatchDate,
          };
          if (existing) {
            // Mirror the SQL COALESCE semantics: only send non-null values so a
            // sparse row can't wipe fields the existing record already has.
            const patch: Record<string, any> = { importBatchDate: r.importBatchDate };
            for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined) patch[k] = v;
            await prisma.dmrReferenceWell.update({ where: { apiNumber: r.apiNumber }, data: patch });
            updated++;
          } else {
            await prisma.dmrReferenceWell.create({ data: { apiNumber: r.apiNumber, ...data } });
            created++;
          }
        } catch { errors++; }
      }
    }
  }
  return { created, updated, errors, mergedInFile };
}
