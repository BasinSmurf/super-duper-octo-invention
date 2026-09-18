/**
 * Spatial proximity engine — "thing is next to other thing"
 *
 * Oilfield reality the matching had to learn the hard way:
 *   - A well's lat/long is its SURFACE location. True pad-mates share it to ~4
 *     decimals (within ~100 ft); horizontal laterals diverge downhole but the
 *     wellheads sit together on one pad.
 *   - The NAME is a trap. "BERGSTROM" wells are scattered 60+ miles across the
 *     basin. Name proximity != physical proximity.
 *   - Section/Township/Range is a coarse 1-mile bucket; the surface coordinate is
 *     the fine signal that separates two pads sharing a section.
 *
 * So "next to" is spatial clustering of surface holes, NOT string matching. A pad
 * is a tight cluster of surface coordinates. Section is used only as a free side
 * effect of the grid bucketing — clusters may cross a section line if the
 * coordinates warrant it (pads occasionally straddle one).
 *
 * Primary application: the import left pads badly fragmented (≈67% single-well
 * pads, avg <2 wells/pad) because each well was activated onto its own pad. This
 * engine clusters padded wells by surface proximity and proposes collapsing the
 * fragments back into real multi-well pads.
 */

import { prisma, Prisma } from '../db.js';

// Feet per degree of latitude (≈ 69 statute miles). Longitude shrinks by cos(lat).
const FT_PER_DEG_LAT = 364320;
const ftPerDegLon = (lat: number) => Math.cos((lat * Math.PI) / 180) * FT_PER_DEG_LAT;

// Calibrated against real data: pad-mates sit ~60-100ft apart; a big wellhead row
// spans up to ~1000ft; distinct pads are ~1500ft+ apart. At 500ft the single-
// linkage clusters stay under a quarter-quarter (1320ft) with zero false bridges;
// above ~750ft chaining strings separate pads together along access roads.
export const DEFAULT_PAD_RADIUS_FT = 500;
// Hard footprint cap: a cluster wider than one QQ (1320ft, the well-spacing unit)
// is almost certainly two pads chained — drop it from auto-suggestions.
const MAX_PAD_SPAN_FT = 1320;
// A cluster this tight is unambiguously one pad — surface it as high-confidence.
const CONFIDENT_SPAN_FT = 600;

/** Accurate ground distance in feet (equirectangular, mid-latitude). */
function distanceFt(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const midLat = (aLat + bLat) / 2;
  const dy = (aLat - bLat) * FT_PER_DEG_LAT;
  const dx = (aLon - bLon) * ftPerDegLon(midLat);
  return Math.hypot(dx, dy);
}

interface GeoPoint { id: string; lat: number; lon: number; }

/**
 * Single-linkage spatial clustering: two points are linked when they're within
 * radiusFt; a cluster is a connected component. Grid-bucketed (cell = radiusFt in
 * a local feet projection) + union-find, so it's ~O(n) instead of O(n²) and
 * handles tens of thousands of points in milliseconds.
 */
function clusterByProximity<T extends GeoPoint>(points: T[], radiusFt: number): T[][] {
  const n = points.length;
  if (n === 0) return [];

  // Local equal-distance projection to feet around the mean latitude. Regional
  // distortion (ND spans ~3° lat) is negligible for clustering.
  const refLat = points.reduce((s, p) => s + p.lat, 0) / n;
  const ftLon = ftPerDegLon(refLat);
  const xs = points.map((p) => p.lon * ftLon);
  const ys = points.map((p) => p.lat * FT_PER_DEG_LAT);

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const cell = radiusFt;
  const key = (i: number) => `${Math.floor(xs[i] / cell)}:${Math.floor(ys[i] / cell)}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = key(i);
    const b = grid.get(k);
    if (b) b.push(i); else grid.set(k, [i]);
  }

  const r2 = radiusFt * radiusFt;
  for (let i = 0; i < n; i++) {
    const ci = Math.floor(xs[i] / cell), cj = Math.floor(ys[i] / cell);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const b = grid.get(`${ci + di}:${cj + dj}`);
        if (!b) continue;
        for (const j of b) {
          if (j <= i) continue;
          const dx = xs[i] - xs[j], dy = ys[i] - ys[j];
          if (dx * dx + dy * dy <= r2) union(i, j);
        }
      }
    }
  }

  const groups = new Map<number, T[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(points[i]); else groups.set(root, [points[i]]);
  }
  return [...groups.values()];
}

/** Max pairwise distance within a small point set (cluster footprint), in feet. */
function spanFt(points: GeoPoint[]): number {
  let max = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      max = Math.max(max, distanceFt(points[i].lat, points[i].lon, points[j].lat, points[j].lon));
  return Math.round(max);
}

function mode<T>(vals: (T | null | undefined)[]): T | null {
  const counts = new Map<T, number>();
  for (const v of vals) if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null, bestC = 0;
  for (const [v, c] of counts) if (c > bestC) { best = v; bestC = c; }
  return best;
}

// ── Pad consolidation ────────────────────────────────────────────────────────

interface PadWellRow {
  id: string; lat: number; lon: number; padId: string;
  wellName: string | null; section: number | null; township: number | null; range: number | null;
}

export interface PadMergeSuggestion {
  /** Pad to keep (most wells in the cluster; ties → most recently verified, else oldest). */
  winnerPadId: string;
  winnerPadName: string;
  /** Dominant well-name base in the cluster. Pad names in this dataset are often
   *  garbage (ticket-derived, e.g. "B&G Truck 393"); this is the name the merged
   *  pad SHOULD carry. */
  suggestedName: string;
  /** Pads whose wells fold into the winner. */
  loserPads: Array<{ padId: string; padName: string; wellCount: number }>;
  totalWells: number;
  centroid: { lat: number; lon: number };
  section: number | null; township: number | null; range: number | null;
  spanFt: number;
  /** Tight footprint → unambiguously one pad. UI can auto-select these. */
  confident: boolean;
  /** Distinct well-name bases in the cluster. >1 means mixed names (different
   *  leases physically near each other) — a coords-only cluster the human should
   *  eyeball before merging. */
  distinctNameBases: number;
  sampleWellNames: string[];
}

/** Strip trailing well-number/suffix to a coarse base ("BIG BEND 11-2MBH" → "BIG BEND"). */
function nameBase(name: string | null): string {
  if (!name) return '';
  const up = name.toUpperCase().replace(/\s+/g, ' ').trim();
  return up.replace(/[\s-]+\d.*$/, '').trim() || up;
}

/**
 * Cluster every padded well by surface proximity and surface the clusters that
 * span MORE THAN ONE pad — those pads are physically the same location split
 * across fragments and should be merged.
 */
export async function suggestPadMerges(
  radiusFt = DEFAULT_PAD_RADIUS_FT,
  maxSpanFt = MAX_PAD_SPAN_FT,
): Promise<PadMergeSuggestion[]> {
  const rows = await prisma.$queryRaw<PadWellRow[]>`
    SELECT id, latitude::float8 AS lat, longitude::float8 AS lon, pad_id AS "padId",
           well_name AS "wellName", section, township, range
    FROM wells
    WHERE pad_id IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
  `;

  const clusters = clusterByProximity(rows, radiusFt);

  // Pads referenced by multi-pad clusters → fetch names + verification + age once.
  const multi = clusters.filter((c) => new Set(c.map((w) => w.padId)).size > 1);
  const padIds = [...new Set(multi.flatMap((c) => c.map((w) => w.padId)))];
  if (padIds.length === 0) return [];
  const pads = await prisma.pad.findMany({
    where: { id: { in: padIds } },
    select: { id: true, name: true, manuallyVerified: true, isActive: true, createdAt: true },
  });
  const padById = new Map(pads.map((p) => [p.id, p]));

  const suggestions: PadMergeSuggestion[] = [];
  for (const cluster of multi) {
    const byPad = new Map<string, PadWellRow[]>();
    for (const w of cluster) {
      const g = byPad.get(w.padId);
      if (g) g.push(w); else byPad.set(w.padId, [w]);
    }
    // Winner: prefer an ACTIVE pad (don't resurrect a deliberately-retired one as
    // the survivor); then most wells; then manuallyVerified; then oldest (stable,
    // keeps the longest history).
    const ranked = [...byPad.entries()].sort((a, b) => {
      const pa = padById.get(a[0]), pb = padById.get(b[0]);
      if (!!pb?.isActive !== !!pa?.isActive) return pb?.isActive ? 1 : -1;
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      if (!!pb?.manuallyVerified !== !!pa?.manuallyVerified) return pb?.manuallyVerified ? 1 : -1;
      return (pa?.createdAt?.getTime() ?? 0) - (pb?.createdAt?.getTime() ?? 0);
    });
    const [winnerId] = ranked[0];
    const losers = ranked.slice(1);

    const span = spanFt(cluster);
    if (span > maxSpanFt) continue; // too wide → likely multiple pads chained; skip

    suggestions.push({
      winnerPadId: winnerId,
      winnerPadName: padById.get(winnerId)?.name ?? '(unnamed)',
      suggestedName: mode(cluster.map((w) => nameBase(w.wellName)).filter(Boolean)) ?? (padById.get(winnerId)?.name ?? '(unnamed)'),
      loserPads: losers.map(([id, ws]) => ({ padId: id, padName: padById.get(id)?.name ?? '(unnamed)', wellCount: ws.length })),
      totalWells: cluster.length,
      centroid: {
        lat: +(cluster.reduce((s, w) => s + w.lat, 0) / cluster.length).toFixed(6),
        lon: +(cluster.reduce((s, w) => s + w.lon, 0) / cluster.length).toFixed(6),
      },
      section: mode(cluster.map((w) => w.section)),
      township: mode(cluster.map((w) => w.township)),
      range: mode(cluster.map((w) => w.range)),
      spanFt: span,
      confident: span <= CONFIDENT_SPAN_FT,
      distinctNameBases: new Set(cluster.map((w) => nameBase(w.wellName)).filter(Boolean)).size,
      sampleWellNames: [...new Set(cluster.map((w) => w.wellName).filter(Boolean) as string[])].slice(0, 8),
    });
  }

  // High-confidence, biggest consolidations first; mixed-name clusters sink.
  suggestions.sort((a, b) =>
    Number(b.confident) - Number(a.confident) ||
    a.distinctNameBases - b.distinctNameBases ||
    b.loserPads.length - a.loserPads.length ||
    b.totalWells - a.totalWells
  );
  return suggestions;
}

/**
 * Merge fragmented pads into one: reassign every pad-scoped relation from the
 * losers to the winner, then soft-deactivate the losers with a reversible
 * breadcrumb. The winner inherits section/STR/coords if it was missing them.
 */
export async function mergePads(winnerPadId: string, loserPadIds: string[], newName?: string): Promise<{ merged: number; wellsMoved: number }> {
  const losers = loserPadIds.filter((id) => id && id !== winnerPadId);
  if (losers.length === 0) throw new Error('No distinct loser pads to merge');

  const winner = await prisma.pad.findUnique({ where: { id: winnerPadId } });
  if (!winner) throw new Error('Winner pad not found');
  const existing = await prisma.pad.findMany({ where: { id: { in: losers } }, select: { id: true } });
  if (existing.length !== losers.length) throw new Error('One or more loser pads not found');

  const result = await prisma.$transaction(async (tx) => {
    const moved = await tx.well.updateMany({ where: { padId: { in: losers } }, data: { padId: winnerPadId } });
    await tx.facility.updateMany({ where: { padId: { in: losers } }, data: { padId: winnerPadId } });
    await tx.workPoint.updateMany({ where: { padId: { in: losers } }, data: { padId: winnerPadId } });
    await tx.operatorHistory.updateMany({ where: { padId: { in: losers } }, data: { padId: winnerPadId } });
    await tx.serviceTicket.updateMany({ where: { padId: { in: losers } }, data: { padId: winnerPadId } });
    await tx.rentalAgreement.updateMany({ where: { padId: { in: losers } }, data: { padId: winnerPadId } });
    await tx.serializedEquipment.updateMany({ where: { currentPadId: { in: losers } }, data: { currentPadId: winnerPadId } });
    await tx.routeStop.updateMany({ where: { padId: { in: losers } }, data: { padId: winnerPadId } });
    await tx.shopWorkOrder.updateMany({ where: { sourceLocationId: { in: losers } }, data: { sourceLocationId: winnerPadId } });
    await tx.shopWorkOrder.updateMany({ where: { returnLocationId: { in: losers } }, data: { returnLocationId: winnerPadId } });

    // Backfill winner's legal location / coords from a representative member well
    // if blank, and optionally rename it to the sensible cluster name.
    const winnerData: Record<string, unknown> = {};
    if (!winner.isActive) winnerData.isActive = true; // survivor must be active
    if (newName && newName.trim() && newName.trim() !== winner.name) winnerData.name = newName.trim();
    if (winner.latitude == null || winner.section == null) {
      const w = await tx.well.findFirst({
        where: { padId: winnerPadId, latitude: { not: null } },
        select: { latitude: true, longitude: true, section: true, township: true, range: true, county: true },
      });
      if (w) {
        if (winner.latitude == null) { winnerData.latitude = w.latitude; winnerData.longitude = w.longitude; }
        if (winner.section == null) { winnerData.section = w.section; winnerData.township = w.township; winnerData.range = w.range; }
        if (winner.county == null) winnerData.county = w.county;
      }
    }
    if (Object.keys(winnerData).length > 0) {
      await tx.pad.update({ where: { id: winnerPadId }, data: winnerData });
    }

    for (const id of losers) {
      const loser = await tx.pad.findUnique({ where: { id }, select: { customData: true } });
      await tx.pad.update({
        where: { id },
        data: {
          isActive: false,
          customData: {
            ...((loser?.customData as object) || {}),
            mergedInto: winnerPadId,
            mergedAt: new Date().toISOString(),
            mergedVia: 'proximity_consolidation',
          },
        },
      });
    }
    return { merged: losers.length, wellsMoved: moved.count };
  });

  return result;
}

// ── Nearby lookup ──────────────────────────────────────────────────────────
