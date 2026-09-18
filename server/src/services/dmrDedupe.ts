/**
 * One-shot self-heal for dmr_reference_wells rows that stacked up before API
 * normalization existed. Different ND sources key the same well differently —
 * dashed 10-digit ("33-053-01234"), bare 10-digit, full 14-digit — and each
 * historical import format inserted its own row. This pass:
 *
 *   1. Renames rows whose api_number isn't the canonical 14-digit form (and
 *      wouldn't collide with anything) in one bulk UPDATE.
 *   2. Merges rows that DO collide on the canonical form (plus legacy rows with
 *      no API at all, joined in by dmr_file_number): keeper = matched > most
 *      complete > newest; missing fields fill from the duplicates; match links
 *      and wells.dmr_reference_id pointers are preserved/repointed; duplicates
 *      are deleted.
 *
 * Runs at the start of every CSV import (fast no-op once clean) and standalone
 * via scripts/dedupe-dmr.ts for prod cleanup without uploading a file.
 */

import { prisma, Prisma } from '../db.js';
import { normalizeApi } from './dmrBulkUpsert.js';

// type alias (not interface) so it satisfies Prisma's InputJsonObject for audit logging
export type DmrDedupeResult = {
  renamed: number;           // api_number normalized in place (no collision)
  groupsMerged: number;      // duplicate clusters collapsed to one row
  duplicatesRemoved: number; // rows deleted by those merges
};

type SlimRow = { id: string; api_number: string | null; dmr_file_number: number | null };
type FullRow = Prisma.DmrReferenceWellGetPayload<{}>;

// Fields eligible for fill-from-duplicate merging (paired fields handled separately).
const MERGE_FIELDS = [
  'dmrFileNumber', 'apiShort', 'operatorName', 'totalDepth', 'spudDate', 'fieldName',
  'quarterQuarter', 'section', 'township', 'range', 'feetNs', 'nsLine', 'feetEw', 'ewLine',
  'wellType', 'wellStatus', 'county', 'symbol', 'rawData',
] as const;

function nonNullCount(r: FullRow): number {
  let n = 0;
  for (const f of MERGE_FIELDS) if ((r as any)[f] !== null && (r as any)[f] !== undefined) n++;
  if (r.latitude !== null) n++;
  if (r.wellName !== null) n++;
  return n;
}

/** Merge a duplicate cluster into one record. `rows` must be in keeper-preference order. */
function mergeGroup(rows: FullRow[], napi: string | null) {
  const keeper = rows[0];
  const merged: Record<string, any> = { ...keeper };
  merged.apiNumber = napi;
  merged.apiShort = napi ?? keeper.apiShort;
  for (const f of MERGE_FIELDS) {
    if (merged[f] === null || merged[f] === undefined) {
      for (const r of rows) { const v = (r as any)[f]; if (v !== null && v !== undefined) { merged[f] = v; break; } }
    }
  }
  // Paired fields travel together so we never stitch lat from one source onto
  // long from another (or a well name onto a base parsed from a different name).
  if (merged.latitude === null || merged.longitude === null) {
    const src = rows.find(r => r.latitude !== null && r.longitude !== null) ?? rows.find(r => r.latitude !== null || r.longitude !== null);
    if (src) { merged.latitude = src.latitude; merged.longitude = src.longitude; }
  }
  if (merged.wellName === null) {
    const src = rows.find(r => r.wellName !== null);
    if (src) { merged.wellName = src.wellName; merged.wellNameBase = src.wellNameBase; }
  }
  // Match links: prefer the pair from the first row that has a well match.
  const matchSrc = rows.find(r => r.matchedWellId !== null);
  merged.matchedWellId = matchSrc?.matchedWellId ?? null;
  merged.matchedCompanyId = matchSrc?.matchedCompanyId ?? rows.find(r => r.matchedCompanyId !== null)?.matchedCompanyId ?? null;
  merged.importBatchDate = rows.reduce<Date | null>((m, r) => (r.importBatchDate && (!m || r.importBatchDate > m) ? r.importBatchDate : m), null);
  merged.createdAt = rows.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), keeper.createdAt);
  return merged;
}

const CHUNK = 300; // 300 × 30 binds = 9k params, well under the 65535 limit

async function insertMerged(tx: Prisma.TransactionClient, rows: Record<string, any>[], now: Date) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const tuples = rows.slice(i, i + CHUNK).map((r) => Prisma.sql`(${r.id}, ${r.dmrFileNumber}, ${r.apiNumber}, ${r.apiShort}, ${r.operatorName}, ${r.wellName}, ${r.wellNameBase}, ${r.totalDepth}, ${r.spudDate}, ${r.fieldName}, ${r.quarterQuarter}, ${r.section}, ${r.township}, ${r.range}, ${r.feetNs}, ${r.nsLine}, ${r.feetEw}, ${r.ewLine}, ${r.latitude === null ? null : Number(r.latitude)}, ${r.longitude === null ? null : Number(r.longitude)}, ${r.wellType}, ${r.wellStatus}, ${r.county}, ${r.symbol}, ${r.rawData == null ? null : JSON.stringify(r.rawData)}::jsonb, ${r.matchedWellId}, ${r.matchedCompanyId}, ${r.importBatchDate}, ${r.createdAt}, ${now})`);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO dmr_reference_wells (
        id, dmr_file_number, api_number, api_short, operator_name, well_name, well_name_base,
        total_depth, spud_date, field_name, quarter_quarter, section, township, "range",
        feet_ns, ns_line, feet_ew, ew_line, latitude, longitude, well_type, well_status,
        county, symbol, raw_data, matched_well_id, matched_company_id, import_batch_date, created_at, updated_at
      ) VALUES ${Prisma.join(tuples)}
    `);
  }
}

export async function dedupeDmrReferenceWells(): Promise<DmrDedupeResult> {
  const slim = await prisma.$queryRaw<SlimRow[]>(Prisma.sql`
    SELECT id, api_number, dmr_file_number FROM dmr_reference_wells
  `);

  // Group rows by canonical API. Legacy rows with no API join a group through
  // their DMR file number when it maps to exactly one canonical API.
  const byNapi = new Map<string, SlimRow[]>();
  const noApi: SlimRow[] = [];
  const napiOf = new Map<string, string>(); // row id → napi
  for (const s of slim) {
    const napi = normalizeApi(s.api_number);
    if (napi) {
      napiOf.set(s.id, napi);
      const g = byNapi.get(napi);
      if (g) g.push(s); else byNapi.set(napi, [s]);
    } else {
      noApi.push(s);
    }
  }
  const filenoToNapi = new Map<number, string | null>(); // null = ambiguous
  for (const [napi, rows] of byNapi) {
    for (const r of rows) {
      if (r.dmr_file_number === null) continue;
      const cur = filenoToNapi.get(r.dmr_file_number);
      if (cur === undefined) filenoToNapi.set(r.dmr_file_number, napi);
      else if (cur !== napi) filenoToNapi.set(r.dmr_file_number, null);
    }
  }
  const byFilenoOnly = new Map<number, SlimRow[]>(); // no-API clusters
  for (const s of noApi) {
    if (s.dmr_file_number === null) continue; // nothing to key on — leave it
    const napi = filenoToNapi.get(s.dmr_file_number);
    if (napi) byNapi.get(napi)!.push(s);
    else if (napi === undefined) {
      const g = byFilenoOnly.get(s.dmr_file_number);
      if (g) g.push(s); else byFilenoOnly.set(s.dmr_file_number, [s]);
    }
    // ambiguous fileno (maps to 2+ APIs): don't guess, leave the row alone
  }

  // Collision groups → merge. Clean singletons with a stale key → rename.
  const groups: Array<{ napi: string | null; ids: string[] }> = [];
  const renameIds: string[] = [];
  const renameKeys: string[] = [];
  for (const [napi, rows] of byNapi) {
    if (rows.length > 1) groups.push({ napi, ids: rows.map(r => r.id) });
    else if (rows[0].api_number !== napi) { renameIds.push(rows[0].id); renameKeys.push(napi); }
  }
  for (const [, rows] of byFilenoOnly) {
    if (rows.length > 1) groups.push({ napi: null, ids: rows.map(r => r.id) });
  }

  let renamed = 0;
  for (let i = 0; i < renameIds.length; i += 5000) {
    renamed += await prisma.$executeRaw(Prisma.sql`
      UPDATE dmr_reference_wells d
      SET api_number = m.napi, api_short = m.napi, updated_at = now()
      FROM (SELECT unnest(${renameIds.slice(i, i + 5000)}::text[]) AS id,
                   unnest(${renameKeys.slice(i, i + 5000)}::text[]) AS napi) m
      WHERE d.id = m.id
    `);
  }

  if (groups.length === 0) return { renamed, groupsMerged: 0, duplicatesRemoved: 0 };

  // Fetch full rows for every cluster, merge in memory.
  const allIds = groups.flatMap(g => g.ids);
  const fullById = new Map<string, FullRow>();
  for (let i = 0; i < allIds.length; i += 5000) {
    const rows = await prisma.dmrReferenceWell.findMany({ where: { id: { in: allIds.slice(i, i + 5000) } } });
    for (const r of rows) fullById.set(r.id, r);
  }

  const mergedRows: Record<string, any>[] = [];
  const loserToKeeper: Array<{ loser: string; keeper: string }> = [];
  const deleteIds: string[] = [];
  for (const g of groups) {
    const rows = g.ids.map(id => fullById.get(id)!).filter(Boolean);
    if (rows.length < 2) continue;
    rows.sort((a, b) =>
      (b.matchedWellId ? 1 : 0) - (a.matchedWellId ? 1 : 0) ||
      nonNullCount(b) - nonNullCount(a) ||
      b.updatedAt.getTime() - a.updatedAt.getTime()
    );
    mergedRows.push(mergeGroup(rows, g.napi));
    deleteIds.push(...rows.map(r => r.id));
    for (const r of rows.slice(1)) loserToKeeper.push({ loser: r.id, keeper: rows[0].id });
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Wells created from a duplicate row keep a working back-pointer.
    for (let i = 0; i < loserToKeeper.length; i += 5000) {
      const part = loserToKeeper.slice(i, i + 5000);
      await tx.$executeRaw(Prisma.sql`
        UPDATE wells w SET dmr_reference_id = m.keeper
        FROM (SELECT unnest(${part.map(p => p.loser)}::text[]) AS loser,
                     unnest(${part.map(p => p.keeper)}::text[]) AS keeper) m
        WHERE w.dmr_reference_id = m.loser
      `);
    }
    for (let i = 0; i < deleteIds.length; i += 5000) {
      await tx.dmrReferenceWell.deleteMany({ where: { id: { in: deleteIds.slice(i, i + 5000) } } });
    }
    await insertMerged(tx, mergedRows, now);
  }, { timeout: 300_000, maxWait: 30_000 });

  return { renamed, groupsMerged: mergedRows.length, duplicatesRemoved: deleteIds.length - mergedRows.length };
}
