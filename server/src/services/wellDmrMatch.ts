/**
 * Well ↔ DMR reference backfill / dedupe matcher
 *
 * Many active `wells` were imported (DoForms / Azure) as names-on-pads with no
 * API#, lat/long, or legal location. Now that `dmr_reference_wells` is fully
 * populated from the ND OGD shapefile, we can match those orphaned wells back to
 * their DMR row and backfill identity + classification.
 *
 * Matching signal is the well NAME (operator/field are unreliable — operator
 * buyouts and "UNASSIGNED" fields are common). Names embed STR which makes them
 * highly unique. Strategy:
 *   - unique normalized-name match  → auto-applyable (high confidence)
 *   - ambiguous / no exact match    → human review with fuzzy candidates
 *
 * Backfill = identity + classification only. current_operator / field / pad are
 * left untouched on purpose (DMR operator can be stale post-buyout).
 */

import Fuse from 'fuse.js';
import { prisma, Prisma } from '../db.js';

// DMR code → Prisma enum (membership; unknown/blank → 'other').
const WELL_TYPE_MAP: Record<string, string> = {
  OG: 'OG', SWD: 'SWD', WI: 'WI', GASD: 'GASD', ST: 'ST',
  GASC: 'GASC', WS: 'WS', CO2I: 'CO2I', AI: 'AI', GI: 'GI',
};
const WELL_STATUS_MAP: Record<string, string> = {
  A: 'A', DRY: 'DRY', PA: 'PA', PNC: 'PNC', IA: 'IA',
  Confidential: 'Confidential', AB: 'AB', LOC: 'LOC', DRL: 'DRL', TA: 'TA',
};

function mapWellType(code: string | null): string {
  return (code && WELL_TYPE_MAP[code]) || 'other';
}
function mapWellStatus(code: string | null): string {
  return (code && WELL_STATUS_MAP[code]) || 'other';
}

/** Normalize a well name for exact matching: uppercase, trim, collapse whitespace. */
export function normalizeName(s: string | null): string {
  return (s || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Strip the trailing well-number/suffix to get a base name for candidate lookup. */
export function wellNameBase(name: string | null): string {
  if (!name) return '';
  const base = name.replace(/[\s-]+\d+.*$/, '').trim();
  return base || name;
}

/**
 * Collapse whitespace runs and trim. The state's own nomenclature is not
 * clean — NDIC ships names like "FBIR LAWRENCE  24X-26A" with a double space
 * — so adopting a DMR name verbatim just moves their inconsistency into our
 * data. The LETTERING is authoritative; the spacing is not.
 */
export function normalizeWellName(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

type DmrRow = Prisma.DmrReferenceWellGetPayload<{}>;

/**
 * Build the identity+classification backfill patch from a DMR row.
 * Operator/field untouched — those are ours to decide. The NAME is not: once
 * a well is matched to an API, the state's designation for that API is what
 * the well is called. Leaving a human-typed name in place is how we ended up
 * with rows like "FBIR WALKER 31X36DX2" sitting on API 33025033990000, which
 * NDIC calls 31X-36DXA — a name that claims to be a well we do not have.
 */
function backfillData(dmr: DmrRow) {
  const name = normalizeWellName(dmr.wellName);
  return {
    ...(name ? { wellName: name, wellNameBase: wellNameBase(name) } : {}),
    dmrFileNumber: dmr.dmrFileNumber,
    apiNumber: dmr.apiNumber,
    apiShort: dmr.apiShort,
    totalDepth: dmr.totalDepth,
    spudDate: dmr.spudDate,
    quarterQuarter: dmr.quarterQuarter,
    section: dmr.section,
    township: dmr.township,
    range: dmr.range,
    feetNs: dmr.feetNs,
    nsLine: dmr.nsLine,
    feetEw: dmr.feetEw,
    ewLine: dmr.ewLine,
    latitude: dmr.latitude,
    longitude: dmr.longitude,
    wellType: mapWellType(dmr.wellType) as any,
    wellStatus: mapWellStatus(dmr.wellStatus) as any,
    county: dmr.county,
    dmrReferenceId: dmr.id,
    dmrImportDate: new Date(),
    dmrRawData: dmr.rawData ?? undefined,
  };
}

/**
 * Apply a single match: backfill the well from the DMR row and link the DMR row
 * back to the well. Throws on apiNumber collision (P2002) so the caller can report
 * — the thrown error carries `.conflictingWell` (who's already holding that API)
 * when it can be resolved, as a backstop for the getReviewQueue apiTakenBy flag
 * going stale between page load and click (a race, not the common case).
 */
export async function applyMatch(wellId: string, dmrReferenceId: string) {
  const [well, dmr] = await Promise.all([
    prisma.well.findUnique({ where: { id: wellId }, select: { id: true, currentOperatorId: true } }),
    prisma.dmrReferenceWell.findUnique({ where: { id: dmrReferenceId } }),
  ]);
  if (!well) throw new Error('Well not found');
  if (!dmr) throw new Error('DMR reference well not found');

  try {
    await prisma.$transaction([
      prisma.well.update({ where: { id: wellId }, data: backfillData(dmr) }),
      prisma.dmrReferenceWell.update({
        where: { id: dmrReferenceId },
        data: { matchedWellId: wellId, matchedCompanyId: well.currentOperatorId ?? undefined },
      }),
    ]);
  } catch (e: any) {
    if (e?.code === 'P2002' && dmr.apiNumber) {
      const conflictingWell = await prisma.well.findFirst({
        where: { apiNumber: dmr.apiNumber },
        select: { id: true, wellName: true, currentOperator: { select: { name: true } } },
      });
      if (conflictingWell) {
        e.conflictingWell = {
          wellId: conflictingWell.id, wellName: conflictingWell.wellName,
          operatorName: conflictingWell.currentOperator?.name ?? null,
        };
      }
    }
    throw e;
  }
}

/** Mark a well as reviewed-but-skipped so it drops out of the review queue. */
export async function skipWell(wellId: string) {
  const well = await prisma.well.findUnique({ where: { id: wellId }, select: { customData: true } });
  const customData = { ...((well?.customData as object) || {}), dmrMatchSkipped: true };
  await prisma.well.update({ where: { id: wellId }, data: { customData } });
}

const UNMATCHED_FILTER = Prisma.sql`
  api_number IS NULL
  AND COALESCE(custom_data->>'dmrMatchSkipped', '') <> 'true'
  AND custom_data->>'mergedInto' IS NULL
  AND asset_category = 'site'
`;

export interface ExistingWellCandidate {
  id: string; wellName: string | null; apiNumber: string | null;
  fieldName: string | null; padName: string | null; operatorName: string | null;
  score: number; exact: boolean;
}

/**
 * Reverse of the review-queue match: given DMR rows about to be materialized
 * into NEW wells, find existing unattached wells (api_number IS NULL) whose
 * name plausibly matches — so activation can ask "is this the same physical
 * well?" instead of silently minting a duplicate orphan.
 *
 * Fuzzy hits are frequently NOT the same wellbore ("BOB 1-1-2434-1" vs the
 * horizontal re-entry "BOB 1-1-2434-1H" score as ~90% similar but are
 * different APIs) — every hit, exact or fuzzy, comes back for human
 * confirmation. Nothing here auto-links.
 */
export async function findExistingWellCandidates(
  rows: Array<{ id: string; wellName: string | null }>
): Promise<Map<string, ExistingWellCandidate[]>> {
  const out = new Map<string, ExistingWellCandidate[]>();
  const named = rows.filter((r) => r.wellName);
  if (named.length === 0) return out;

  const idRows = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM wells WHERE ${UNMATCHED_FILTER}`
  );
  if (idRows.length === 0) return out;

  const pool = await prisma.well.findMany({
    where: { id: { in: idRows.map((r) => r.id) } },
    select: {
      id: true, wellName: true, apiNumber: true,
      field: { select: { name: true } },
      pad: { select: { name: true } },
      currentOperator: { select: { name: true } },
    },
  });

  const fuse = new Fuse(pool, { keys: ['wellName'], threshold: 0.3, includeScore: true });

  for (const row of named) {
    const nn = normalizeName(row.wellName);
    const ranked = fuse.search(nn)
      .filter((r) => (r.score ?? 1) <= 0.35 || normalizeName(r.item.wellName) === nn)
      .slice(0, 5);
    if (ranked.length === 0) continue;
    out.set(row.id, ranked.map((r) => ({
      id: r.item.id, wellName: r.item.wellName, apiNumber: r.item.apiNumber,
      fieldName: r.item.field?.name ?? null, padName: r.item.pad?.name ?? null,
      operatorName: r.item.currentOperator?.name ?? null,
      score: r.score ?? 1, exact: normalizeName(r.item.wellName) === nn,
    })));
  }
  return out;
}

/** Counts that drive the backfill UI. Buckets partition `unmatched` cleanly:
 *  duplicates ∪ autoApplicable ∪ needsReview = unmatched. */
export async function getStats() {
  const [m] = await prisma.$queryRaw<Array<{
    unmatched: number; auto_applicable: number; duplicates: number; needs_review: number; skipped: number;
  }>>(Prisma.sql`
    WITH base AS (
      SELECT id, name_norm AS nn
      FROM wells WHERE ${UNMATCHED_FILTER}
    ),
    dgrp AS (
      SELECT name_norm AS nn, COUNT(*) AS c, MAX(api_number) AS only_api
      FROM dmr_reference_wells GROUP BY 1
    ),
    apid AS (
      SELECT DISTINCT name_norm AS nn
      FROM wells WHERE api_number IS NOT NULL
    ),
    taken AS (
      SELECT DISTINCT api_number FROM wells WHERE api_number IS NOT NULL
    ),
    j AS (
      -- api_taken: this well's UNIQUE DMR match resolves to an API that's already
      -- assigned to some other well. Auto-apply can't claim it (unique-API → 409),
      -- so it's NOT auto-applicable — it's a cross-name duplicate for review.
      SELECT b.id, d.c AS dmr_c, (a.nn IS NOT NULL) AS has_sibling,
             (d.c = 1 AND t.api_number IS NOT NULL) AS api_taken
      FROM base b
      LEFT JOIN dgrp d ON d.nn = b.nn
      LEFT JOIN apid a ON a.nn = b.nn
      LEFT JOIN taken t ON d.c = 1 AND t.api_number = d.only_api
    )
    SELECT
      COUNT(*)::int AS unmatched,
      COUNT(*) FILTER (WHERE dmr_c = 1 AND NOT has_sibling AND NOT api_taken)::int AS auto_applicable,
      COUNT(*) FILTER (WHERE has_sibling)::int AS duplicates,
      COUNT(*) FILTER (WHERE NOT has_sibling AND (dmr_c IS NULL OR dmr_c > 1 OR (dmr_c = 1 AND api_taken)))::int AS needs_review,
      (SELECT COUNT(*)::int FROM wells WHERE api_number IS NULL AND custom_data->>'dmrMatchSkipped' = 'true') AS skipped
    FROM j;
  `);
  const dups = await getDupRows();
  return {
    unmatched: m?.unmatched ?? 0,
    autoApplicable: m?.auto_applicable ?? 0,
    duplicates: m?.duplicates ?? 0,
    duplicatesClean: dups.filter((d) => !d.has_relations).length,
    duplicatesWithRelations: dups.filter((d) => d.has_relations).length,
    needsReview: m?.needs_review ?? 0,
    skipped: m?.skipped ?? 0,
    orphaned: await getOrphanCount(),
  };
}

interface DupRow { loser_id: string; winner_id: string; has_relations: boolean; }

/** Unmatched wells that duplicate an already-API'd well (same normalized name),
 *  paired with the canonical winner and whether the loser carries work-links. */
async function getDupRows(): Promise<DupRow[]> {
  return prisma.$queryRaw<DupRow[]>(Prisma.sql`
    WITH apid AS (
      SELECT name_norm AS nn, MIN(id) AS winner_id
      FROM wells WHERE api_number IS NOT NULL GROUP BY 1
    )
    SELECT w.id AS loser_id, a.winner_id,
      ( EXISTS (SELECT 1 FROM service_tickets t  WHERE t.well_id = w.id)
        OR EXISTS (SELECT 1 FROM rental_agreements r WHERE r.well_id = w.id)
        OR EXISTS (SELECT 1 FROM serialized_equipment e WHERE e.current_well_id = w.id)
        OR EXISTS (SELECT 1 FROM fit_test_records f WHERE f.well_id = w.id)
        OR EXISTS (SELECT 1 FROM route_stops s WHERE s.well_id = w.id)
        OR EXISTS (SELECT 1 FROM ticket_line_items l WHERE l.well_id_override = w.id)
      ) AS has_relations
    FROM wells w
    JOIN apid a ON a.nn = w.name_norm
    WHERE w.api_number IS NULL
      AND w.asset_category = 'site'
      AND COALESCE(w.custom_data->>'dmrMatchSkipped', '') <> 'true'
      AND w.custom_data->>'mergedInto' IS NULL
      AND w.id <> a.winner_id;
  `);
}

/**
 * Merge a duplicate (loser) well into the canonical (winner) well: reassign every
 * child relation, then soft-deactivate the loser with a breadcrumb. The winner keeps
 * its API/identity. Reversible.
 *
 * `mergedVia` breadcrumbs where the merge was triggered from — the DMR dedupe
 * queue defaults to 'dmr_dedupe'; the general well-detail merge action passes
 * 'manual_merge' so the two are distinguishable later.
 */
export async function mergeWell(loserId: string, winnerId: string, mergedVia = 'dmr_dedupe') {
  if (loserId === winnerId) throw new Error('Cannot merge a well into itself');
  const loser = await prisma.well.findUnique({ where: { id: loserId }, select: { id: true, customData: true } });
  const winner = await prisma.well.findUnique({ where: { id: winnerId }, select: { id: true } });
  if (!loser) throw new Error('Loser well not found');
  if (!winner) throw new Error('Winner well not found');

  const customData = {
    ...((loser.customData as object) || {}),
    mergedInto: winnerId,
    mergedAt: new Date().toISOString(),
    mergedVia,
  };

  await prisma.$transaction([
    prisma.workPoint.updateMany({ where: { wellId: loserId }, data: { wellId: winnerId } }),
    prisma.operatorHistory.updateMany({ where: { wellId: loserId }, data: { wellId: winnerId } }),
    prisma.serviceTicket.updateMany({ where: { wellId: loserId }, data: { wellId: winnerId } }),
    prisma.rentalAgreement.updateMany({ where: { wellId: loserId }, data: { wellId: winnerId } }),
    prisma.serializedEquipment.updateMany({ where: { currentWellId: loserId }, data: { currentWellId: winnerId } }),
    prisma.fitTestRecord.updateMany({ where: { wellId: loserId }, data: { wellId: winnerId } }),
    prisma.ticketLineItem.updateMany({ where: { wellIdOverride: loserId }, data: { wellIdOverride: winnerId } }),
    prisma.routeStop.updateMany({ where: { wellId: loserId }, data: { wellId: winnerId } }),
    prisma.dmrReferenceWell.updateMany({ where: { matchedWellId: loserId }, data: { matchedWellId: winnerId } }),
    prisma.well.update({ where: { id: loserId }, data: { isActiveForService: false, customData } }),
  ]);
}
/**
 * Free-text search across the FULL dmr_reference_wells table (well name, API#,
 * field name) — not the tight base-name pool used by getReviewQueue's automatic
 * fuzzy candidates. Exists for the case those candidates miss: a real rename or
 * typo (e.g. active well "Albin 13x" is actually DMR's "Alberto 13x") is too far
 * apart in name for the Fuse threshold to surface it as a suggestion, but a human
 * who knows the field can find it by hand. Excludes DMR rows already claimed by
 * another well (matchedWellId IS NULL), same as the automatic candidates.
 */
export async function searchDmrCandidates(term: string, limit = 20): Promise<ReviewCandidate[]> {
  const q = term.trim();
  if (!q) return [];
  const rows = await prisma.dmrReferenceWell.findMany({
    where: {
      matchedWellId: null,
      OR: [
        { wellName: { contains: q, mode: 'insensitive' } },
        { apiNumber: { contains: q, mode: 'insensitive' } },
        { fieldName: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: limit,
    orderBy: { wellName: 'asc' },
    select: {
      id: true, apiNumber: true, wellName: true, fieldName: true,
      operatorName: true, county: true, section: true, township: true, range: true,
      latitude: true, longitude: true,
    },
  });
  const apis = rows.map((r) => r.apiNumber).filter((a): a is string => !!a);
  const takenBy = apis.length
    ? await prisma.well.findMany({
        where: { apiNumber: { in: apis } },
        select: { id: true, apiNumber: true, wellName: true, currentOperator: { select: { name: true } } },
      })
    : [];
  const takenByApi = new Map(takenBy.map((tw) => [tw.apiNumber as string, tw]));

  return rows.map((r) => {
    const taken = r.apiNumber ? takenByApi.get(r.apiNumber) : undefined;
    return {
      ...r,
      latitude: r.latitude != null ? Number(r.latitude) : null,
      longitude: r.longitude != null ? Number(r.longitude) : null,
      score: 0,
      exact: false,
      apiTakenBy: taken ? { wellId: taken.id, wellName: taken.wellName, operatorName: taken.currentOperator?.name ?? null } : null,
    };
  });
}

/**
 * Wells with zero rows across every table that can point at a well. Shared by
 * getReviewQueue (to flag which unmatched rows are safe to delete outright),
 * cleanupOrphanWells (to actually delete them), and the general well-detail
 * "has history" pill / delete-well action. Checks RentalAgreement's legacy
 * singular wellId AND its wellIds JSON array — a well referenced only via the
 * array must not look history-free.
 */
export async function wellsWithoutHistory(wellIds: string[]): Promise<Set<string>> {
  if (wellIds.length === 0) return new Set();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT w.id FROM wells w
    WHERE w.id IN (${Prisma.join(wellIds)})
      AND NOT EXISTS (SELECT 1 FROM service_tickets t     WHERE t.well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM rental_agreements r   WHERE r.well_id = w.id OR r.well_ids @> jsonb_build_array(w.id))
      AND NOT EXISTS (SELECT 1 FROM serialized_equipment e WHERE e.current_well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM fit_test_records f    WHERE f.well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM ticket_line_items l   WHERE l.well_id_override = w.id)
      AND NOT EXISTS (SELECT 1 FROM route_stops s         WHERE s.well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM operator_history o    WHERE o.well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM work_points p         WHERE p.well_id = w.id)
  `);
  return new Set(rows.map((r) => r.id));
}

/** Count of wells safe to delete outright: no DMR match, no history anywhere. */
async function getOrphanCount(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ c: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS c FROM wells w
    WHERE w.dmr_reference_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM service_tickets t     WHERE t.well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM rental_agreements r   WHERE r.well_id = w.id OR r.well_ids @> jsonb_build_array(w.id))
      AND NOT EXISTS (SELECT 1 FROM serialized_equipment e WHERE e.current_well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM fit_test_records f    WHERE f.well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM ticket_line_items l   WHERE l.well_id_override = w.id)
      AND NOT EXISTS (SELECT 1 FROM route_stops s         WHERE s.well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM operator_history o    WHERE o.well_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM work_points p         WHERE p.well_id = w.id)
  `);
  return row?.c ?? 0;
}

/**
 * Delete wells that have no DMR match and no history anywhere — the DMR API#
 * is the one true key going forward, so a well with neither is inert and safe
 * to discard. `wellIds` scopes to a specific set (per-row delete from the
 * review queue) after re-verifying each is still genuinely orphaned; omit it
 * to run the bulk "clean up everything orphaned" action.
 */
export async function cleanupOrphanWells(wellIds?: string[]): Promise<{ deleted: number }> {
  const scopeClause = wellIds && wellIds.length > 0
    ? Prisma.sql`AND w.id IN (${Prisma.join(wellIds)})`
    : Prisma.sql``;
  const [row] = await prisma.$queryRaw<Array<{ deleted: number }>>(Prisma.sql`
    WITH orphans AS (
      SELECT w.id FROM wells w
      WHERE w.dmr_reference_id IS NULL
        ${scopeClause}
        AND NOT EXISTS (SELECT 1 FROM service_tickets t     WHERE t.well_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM rental_agreements r   WHERE r.well_id = w.id OR r.well_ids @> jsonb_build_array(w.id))
        AND NOT EXISTS (SELECT 1 FROM serialized_equipment e WHERE e.current_well_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM fit_test_records f    WHERE f.well_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM ticket_line_items l   WHERE l.well_id_override = w.id)
        AND NOT EXISTS (SELECT 1 FROM route_stops s         WHERE s.well_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM operator_history o    WHERE o.well_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM work_points p         WHERE p.well_id = w.id)
    ),
    del AS (DELETE FROM wells WHERE id IN (SELECT id FROM orphans) RETURNING id)
    SELECT (SELECT COUNT(*) FROM del)::int AS deleted;
  `);
  return { deleted: row?.deleted ?? 0 };
}

export interface ReviewCandidate {
  id: string; apiNumber: string | null; wellName: string | null;
  fieldName: string | null; operatorName: string | null; county: string | null;
  section: number | null; township: number | null; range: number | null;
  latitude: number | null; longitude: number | null;
  score: number; exact: boolean;
  // Set when this candidate's API is already sitting on a DIFFERENT well —
  // via a legacy import or manual entry that never went through matchedWellId,
  // so the matchedWellId:null pool filter alone doesn't catch it. Applying
  // would 409 on the unique constraint; surfaced so a human can tell whether
  // that OTHER well has the wrong data instead of getting a bare error.
  apiTakenBy?: { wellId: string; wellName: string | null; operatorName: string | null } | null;
}
export interface ReviewItem {
  wellId: string; wellName: string | null;
  field: string | null; operator: string | null;
  kind: 'duplicate' | 'dmr_match';
  // kind === 'duplicate': merge into this existing API'd well
  duplicateOf?: { wellId: string; wellName: string | null; apiNumber: string | null; hasRelations: boolean };
  // kind === 'dmr_match': pick a DMR reference to backfill from, or — when
  // hasHistory is false — delete outright as an inert orphan.
  candidates: ReviewCandidate[];
  hasHistory?: boolean;
}

/**
 * Page of unmatched wells, each with up to 5 fuzzy DMR candidates ranked by name.
 * Candidate pool is pre-filtered by base-name ILIKE so we don't fuse over 43k rows.
 */
export async function getReviewQueue(opts: { limit?: number; offset?: number; search?: string }) {
  const limit = Math.min(opts.limit ?? 25, 200);
  const offset = opts.offset ?? 0;
  const search = (opts.search || '').trim();

  // Select unmatched-well ids via raw SQL — a Prisma JSON `NOT path` filter would
  // silently drop rows where custom_data IS NULL (i.e. all of them). The COALESCE
  // filter in UNMATCHED_FILTER is null-safe.
  const searchClause = search
    ? Prisma.sql`AND well_name ILIKE ${'%' + search + '%'}`
    : Prisma.sql``;
  const [{ c: total }] = await prisma.$queryRaw<Array<{ c: number }>>(
    Prisma.sql`SELECT COUNT(*)::int AS c FROM wells WHERE ${UNMATCHED_FILTER} ${searchClause}`
  );
  const idRows = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM wells WHERE ${UNMATCHED_FILTER} ${searchClause}
               ORDER BY well_name ASC LIMIT ${limit} OFFSET ${offset}`
  );
  const ids = idRows.map((r) => r.id);
  const fetched = ids.length
    ? await prisma.well.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, wellName: true,
          field: { select: { name: true } },
          currentOperator: { select: { name: true } },
        },
      })
    : [];
  const byId = new Map(fetched.map((w) => [w.id, w]));
  const wells = ids.map((id) => byId.get(id)!).filter(Boolean);

  // Which of this page's wells are duplicates of an API'd well? (one query)
  const dupMap = new Map((await getDupRows()).map((d) => [d.loser_id, d]));
  const winnerIds = [...new Set(wells.map((w) => dupMap.get(w.id)?.winner_id).filter(Boolean) as string[])];
  const winners = winnerIds.length
    ? await prisma.well.findMany({ where: { id: { in: winnerIds } }, select: { id: true, wellName: true, apiNumber: true } })
    : [];
  const winnerById = new Map(winners.map((w) => [w.id, w]));

  // Batched history check for this page's non-duplicate wells, so the client
  // can offer "delete outright" on genuinely inert unmatched wells.
  const nonDupIds = wells.filter((w) => !dupMap.has(w.id)).map((w) => w.id);
  const noHistoryIds = await wellsWithoutHistory(nonDupIds);

  const items: ReviewItem[] = [];
  for (const w of wells) {
    const dup = dupMap.get(w.id);
    if (dup) {
      const win = winnerById.get(dup.winner_id);
      items.push({
        wellId: w.id, wellName: w.wellName,
        field: w.field?.name ?? null, operator: w.currentOperator?.name ?? null,
        kind: 'duplicate',
        duplicateOf: { wellId: dup.winner_id, wellName: win?.wellName ?? null, apiNumber: win?.apiNumber ?? null, hasRelations: dup.has_relations },
        candidates: [],
      });
      continue;
    }
    const base = wellNameBase(w.wellName);
    const nn = normalizeName(w.wellName);
    // A base that's short or number-led (e.g. "14" stripped from "14-32B") nets
    // thousands of unrelated rows and produces garbage fuzzy matches. Only widen
    // to a base-name search when the base is a real alphabetic token; otherwise
    // require the FULL normalized name to appear, which keeps the pool tight.
    const usableBase = base.length >= 4 && /[a-z]/i.test(base);
    const term = usableBase ? base : nn;
    // Exclude DMR rows already claimed THROUGH THIS SYSTEM (matchedWellId set).
    // This does NOT catch every API collision — a well's api_number can be set
    // by a legacy import that never touched matchedWellId at all, so the
    // apiTakenBy check below is still needed after ranking.
    const pool = term
      ? await prisma.dmrReferenceWell.findMany({
          where: {
            matchedWellId: null,
            OR: [{ wellNameBase: { contains: term, mode: 'insensitive' } }, { wellName: { contains: term, mode: 'insensitive' } }],
          },
          take: 60,
          select: {
            id: true, apiNumber: true, wellName: true, fieldName: true,
            operatorName: true, county: true, section: true, township: true, range: true,
            latitude: true, longitude: true,
          },
        })
      : [];

    // Match on well NAME only (matching field name cross-links unrelated wells that
    // share a field). Tight threshold + a hard score cutoff so only genuinely
    // similar names survive — better to show nothing than a misleading match.
    const fuse = new Fuse(pool, { keys: ['wellName'], threshold: 0.3, includeScore: true });
    const ranked = (nn ? fuse.search(nn) : [])
      .filter((r) => (r.score ?? 1) <= 0.35 || normalizeName(r.item.wellName) === nn)
      .slice(0, 5);

    // A DMR row can have matchedWellId:null (nothing officially "claimed" it
    // through this system) while its API is already sitting on some other
    // well's raw api_number column — set by a legacy import or manual entry
    // that bypassed matchedWellId entirely. Catch that here so we don't show
    // an "exact" candidate that will 409 the moment someone clicks Apply.
    const candidateApis = ranked.map((r) => r.item.apiNumber).filter((a): a is string => !!a);
    const takenBy = candidateApis.length
      ? await prisma.well.findMany({
          where: { apiNumber: { in: candidateApis } },
          select: { id: true, apiNumber: true, wellName: true, currentOperator: { select: { name: true } } },
        })
      : [];
    const takenByApi = new Map(takenBy.map((tw) => [tw.apiNumber as string, tw]));

    const candidates: ReviewCandidate[] = ranked.map((r) => {
      const taken = r.item.apiNumber ? takenByApi.get(r.item.apiNumber) : undefined;
      return {
        ...r.item,
        latitude: r.item.latitude != null ? Number(r.item.latitude) : null,
        longitude: r.item.longitude != null ? Number(r.item.longitude) : null,
        score: r.score ?? 1,
        exact: normalizeName(r.item.wellName) === nn,
        apiTakenBy: taken ? { wellId: taken.id, wellName: taken.wellName, operatorName: taken.currentOperator?.name ?? null } : null,
      };
    });

    items.push({
      wellId: w.id,
      wellName: w.wellName,
      field: w.field?.name ?? null,
      operator: w.currentOperator?.name ?? null,
      kind: 'dmr_match',
      candidates,
      hasHistory: !noHistoryIds.has(w.id),
    });
  }

  return { total, limit, offset, items };
}
