/**
 * Company dedupe / merge
 *
 * Operators imported from DMR (`co-…`) and customers imported from QuickBooks
 * (`qb-…`) routinely produce two Company rows for the same real-world entity
 * (e.g. "Kraken Oil & Gas" exists as both). Separately, field offices get
 * entered as their own customers ("Hydra Services LLC - Kraken"). This collapses
 * the duplicates into one canonical company, reassigning every relation.
 *
 * Signal:
 *   - exact normalized-name match → auto-mergeable ("the duh ones"), UNLESS both
 *     sides carry a QuickBooks customer id (a conflict a human must resolve).
 *   - fuzzy name / field-office tag → surfaced for human review.
 *
 * QB rule (per AR): there must be one QB id to rule them all. If only one side
 * has a `qbCustomerListId`, the survivor keeps/inherits it. If BOTH have one,
 * it's a conflict — never auto-merged; on a manual merge we keep the winner's
 * and record the loser's on the winner so it's never silently lost.
 *
 * Merges are reversible: the loser is soft-deactivated (`isActive = false`) with
 * a `customData.mergedInto` breadcrumb; the winner records `customData.mergedFrom`.
 */

import { prisma, Prisma } from '../db.js';

export const MERGE_VIA = 'company_dedupe';

/** Uppercase, collapse whitespace, trim — the exact-match key. */
export function normalizeName(s: string | null): string {
  return (s || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

// Org-form tokens stripped when computing a fuzzy "core" name. These carry no
// identity ("LLC", "Operating") and otherwise drown out the real signal.
const STOP = new Set([
  'LLC', 'L.L.C', 'INC', 'INC.', 'LP', 'L.P', 'LLP', 'CORP', 'CORPORATION',
  'CO', 'CO.', 'COMPANY', 'RESOURCES', 'RESOURCE', 'OPERATING', 'OPERATIONS',
  'OIL', 'GAS', 'ENERGY', 'PETROLEUM', 'EXPLORATION', 'PRODUCTION', 'PARTNERS',
  'HOLDINGS', 'USA', 'US', 'LTD', 'THE', 'AND', '&',
]);

/** Trailing " - X" or "(X)" field-office tag, if any (e.g. "… - Kraken" → "KRAKEN"). */
export function officeTag(name: string | null): string | null {
  if (!name) return null;
  const paren = name.match(/\(([^)]+)\)\s*$/);
  if (paren) return normalizeName(paren[1]);
  const dash = name.match(/\s[-–—]\s+(.+)$/);
  if (dash) return normalizeName(dash[1]);
  return null;
}

/** Strip the office tag + org-form tokens + punctuation to a comparable core. */
export function coreName(name: string | null): string {
  if (!name) return '';
  let s = name.replace(/\(([^)]+)\)\s*$/, ' ').replace(/\s[-–—]\s+.+$/, ' ');
  const tokens = normalizeName(s).replace(/[.,/]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t) => !STOP.has(t));
  return (kept.length ? kept : tokens).join(' ');
}

interface CompanyLite {
  id: string;
  name: string;
  companyType: string;
  qbCustomerListId: string | null;
  createdAt: Date;
  isActive: boolean;
}

// A merged-away loser is soft-deactivated (isActive=false), so `isActive: true`
// already excludes them — no JSON `mergedInto` filter needed (and a Prisma JSON
// `NOT path` filter would silently drop every custom_data IS NULL row anyway,
// per the warning in wellDmrMatch.ts). `mergeSkipped` lives on still-active rows,
// so it's filtered in JS where needed.
async function loadActiveCompanies(): Promise<CompanyLite[]> {
  return prisma.company.findMany({
    where: { isActive: true },
    select: { id: true, name: true, companyType: true, qbCustomerListId: true, createdAt: true, isActive: true },
    orderBy: { name: 'asc' },
  });
}

/**
 * Relation richness per company id — drives winner selection and the review UI.
 * Counts the customer/operator relations that matter most; not exhaustive.
 */
export async function relationCountsFor(ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const bump = (id: string | null, n: number) => {
    if (id) counts.set(id, (counts.get(id) ?? 0) + n);
  };
  const [tickets, invoices, rentals, shopWos, pads, wells] = await Promise.all([
    prisma.serviceTicket.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } }),
    prisma.invoice.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } }),
    prisma.rentalAgreement.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } }),
    prisma.shopWorkOrder.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } }),
    prisma.pad.groupBy({ by: ['currentOperatorId'], where: { currentOperatorId: { in: ids } }, _count: { _all: true } }),
    prisma.well.groupBy({ by: ['currentOperatorId'], where: { currentOperatorId: { in: ids } }, _count: { _all: true } }),
  ]);
  for (const r of tickets) bump(r.companyId, r._count._all);
  for (const r of invoices) bump(r.companyId, r._count._all);
  for (const r of rentals) bump(r.companyId, r._count._all);
  for (const r of shopWos) bump(r.companyId, r._count._all);
  for (const r of pads) bump(r.currentOperatorId, r._count._all);
  for (const r of wells) bump(r.currentOperatorId, r._count._all);
  return counts;
}

/** Pick the survivor of a duplicate group: QB id wins, then richer, then older. */
function pickWinner(group: CompanyLite[], rel: Map<string, number>): CompanyLite {
  return [...group].sort((a, b) => {
    const qa = a.qbCustomerListId ? 1 : 0;
    const qb = b.qbCustomerListId ? 1 : 0;
    if (qa !== qb) return qb - qa;
    const ra = rel.get(a.id) ?? 0;
    const rb = rel.get(b.id) ?? 0;
    if (ra !== rb) return rb - ra;
    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0];
}

/** Does this group hold two or more DISTINCT non-null QB ids? */
function hasQbConflict(group: CompanyLite[]): boolean {
  const ids = new Set(group.map((c) => c.qbCustomerListId).filter(Boolean) as string[]);
  return ids.size > 1;
}

export interface ExactDupGroup {
  norm: string;
  winnerId: string;
  qbConflict: boolean;
  members: Array<{ id: string; name: string; companyType: string; qbCustomerListId: string | null; relationCount: number; isWinner: boolean }>;
}

/** Active companies that share a normalized name, grouped with a chosen winner. */
export async function getExactDupGroups(): Promise<ExactDupGroup[]> {
  const companies = await loadActiveCompanies();
  const byNorm = new Map<string, CompanyLite[]>();
  for (const c of companies) {
    const n = normalizeName(c.name);
    if (!n) continue;
    (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(c);
  }
  const dupGroups = [...byNorm.entries()].filter(([, g]) => g.length > 1);
  const rel = await relationCountsFor(dupGroups.flatMap(([, g]) => g.map((c) => c.id)));

  return dupGroups.map(([norm, group]) => {
    const winner = pickWinner(group, rel);
    return {
      norm,
      winnerId: winner.id,
      qbConflict: hasQbConflict(group),
      members: group.map((c) => ({
        id: c.id,
        name: c.name,
        companyType: c.companyType,
        qbCustomerListId: c.qbCustomerListId,
        relationCount: rel.get(c.id) ?? 0,
        isWinner: c.id === winner.id,
      })),
    };
  });
}

export interface MergeStats {
  activeCompanies: number;
  exactGroups: number;
  exactAutoMergeable: number; // loser rows safe to auto-merge (no QB conflict)
  exactQbConflicts: number;   // loser rows blocked on a QB conflict
  fuzzyCandidates: number;    // companies with a fuzzy/field-office candidate
}

export async function getStats(): Promise<MergeStats> {
  const [groups, fuzzy, active] = await Promise.all([
    getExactDupGroups(),
    getFuzzyReview({ limit: 1000, offset: 0 }),
    prisma.company.count({ where: { isActive: true } }),
  ]);
  let auto = 0;
  let conflict = 0;
  for (const g of groups) {
    const losers = g.members.length - 1;
    if (g.qbConflict) conflict += losers;
    else auto += losers;
  }
  return {
    activeCompanies: active,
    exactGroups: groups.length,
    exactAutoMergeable: auto,
    exactQbConflicts: conflict,
    fuzzyCandidates: fuzzy.total,
  };
}

export interface MergeResult {
  loserId: string;
  winnerId: string;
  qbConflict: boolean;
  qbInherited: boolean;
}

/**
 * Merge loser into winner: reassign every relation, apply the QB rule, then
 * soft-deactivate the loser with a breadcrumb. Runs in one transaction.
 *
 * @param force allow a merge even when both sides have a QB id (records both).
 */
export async function mergeCompany(loserId: string, winnerId: string, opts: { force?: boolean } = {}): Promise<MergeResult> {
  if (loserId === winnerId) throw new Error('Cannot merge a company into itself');
  const [loser, winner] = await Promise.all([
    prisma.company.findUnique({ where: { id: loserId } }),
    prisma.company.findUnique({ where: { id: winnerId } }),
  ]);
  if (!loser) throw new Error('Loser company not found');
  if (!winner) throw new Error('Winner company not found');
  if ((winner.customData as any)?.mergedInto) throw new Error('Winner company has itself already been merged away');

  const loserQb = loser.qbCustomerListId;
  const winnerQb = winner.qbCustomerListId;
  const qbConflict = !!loserQb && !!winnerQb && loserQb !== winnerQb;
  if (qbConflict && !opts.force) {
    const err: any = new Error('Both companies have a QuickBooks id — confirm which survives (force) before merging.');
    err.code = 'QB_CONFLICT';
    throw err;
  }
  const qbInherited = !winnerQb && !!loserQb;

  const now = new Date().toISOString();
  const loserData: Prisma.CompanyUpdateInput = {
    isActive: false,
    customData: {
      ...((loser.customData as object) || {}),
      mergedInto: winnerId,
      mergedAt: now,
      mergedVia: MERGE_VIA,
    },
  };

  const winnerData: Prisma.CompanyUpdateInput = {
    customData: {
      ...((winner.customData as object) || {}),
      mergedFrom: [
        ...(((winner.customData as any)?.mergedFrom as any[]) || []),
        { id: loserId, name: loser.name, at: now, qbCustomerListId: loserQb },
      ],
    },
  };
  // QB: inherit the loser's id if we have none; on a forced conflict keep ours
  // (the loser's is preserved in mergedFrom above).
  if (qbInherited) {
    winnerData.qbCustomerListId = loserQb;
    winnerData.qbCustomerFullName = loser.qbCustomerFullName ?? winner.qbCustomerFullName;
    winnerData.qbSyncStatus = loser.qbSyncStatus ?? winner.qbSyncStatus;
  }
  // If the winner's parent is the company being merged away, re-point it up.
  if (winner.parentCompanyId === loserId) {
    winnerData.parentCompany = loser.parentCompanyId
      ? { connect: { id: loser.parentCompanyId } }
      : { disconnect: true };
  }

  await prisma.$transaction([
    prisma.operatorAlias.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.customerBillingProfile.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.customerContact.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.pad.updateMany({ where: { currentOperatorId: loserId }, data: { currentOperatorId: winnerId } }),
    prisma.well.updateMany({ where: { currentOperatorId: loserId }, data: { currentOperatorId: winnerId } }),
    prisma.facility.updateMany({ where: { currentOperatorId: loserId }, data: { currentOperatorId: winnerId } }),
    prisma.operatorHistory.updateMany({ where: { previousOperatorId: loserId }, data: { previousOperatorId: winnerId } }),
    prisma.operatorHistory.updateMany({ where: { newOperatorId: loserId }, data: { newOperatorId: winnerId } }),
    prisma.serviceTicket.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.rentalAgreement.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.repairOrder.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.billingGroup.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.serializedEquipment.updateMany({ where: { currentCustomerId: loserId }, data: { currentCustomerId: winnerId } }),
    prisma.dmrReferenceWell.updateMany({ where: { matchedCompanyId: loserId }, data: { matchedCompanyId: winnerId } }),
    prisma.serviceRoute.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.trainingRosterRecord.updateMany({ where: { employerCompanyId: loserId }, data: { employerCompanyId: winnerId } }),
    prisma.shopWorkOrder.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.invoice.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.payment.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.user.updateMany({ where: { companyId: loserId }, data: { companyId: winnerId } }),
    prisma.company.updateMany({ where: { parentCompanyId: loserId }, data: { parentCompanyId: winnerId } }),
    // Soft (non-FK) DoForms import pointer — repoint so it doesn't dangle.
    prisma.legacyTicket.updateMany({ where: { matchedCompanyId: loserId }, data: { matchedCompanyId: winnerId } }),
    prisma.company.update({ where: { id: winnerId }, data: winnerData }),
    prisma.company.update({ where: { id: loserId }, data: loserData }),
  ]);

  return { loserId, winnerId, qbConflict, qbInherited };
}

/** Auto-merge every exact-name duplicate group that has no QB conflict. */
export async function autoMergeExact(): Promise<{ merged: number; skippedConflicts: number; errors: number }> {
  const groups = await getExactDupGroups();
  let merged = 0;
  let skippedConflicts = 0;
  let errors = 0;
  for (const g of groups) {
    if (g.qbConflict) {
      skippedConflicts += g.members.length - 1;
      continue;
    }
    for (const m of g.members) {
      if (m.id === g.winnerId) continue;
      try {
        await mergeCompany(m.id, g.winnerId);
        merged++;
      } catch {
        errors++;
      }
    }
  }
  return { merged, skippedConflicts, errors };
}

/** Drop a company out of the fuzzy review queue. */
export async function skipCompany(companyId: string): Promise<void> {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { customData: true } });
  await prisma.company.update({
    where: { id: companyId },
    data: { customData: { ...((c?.customData as object) || {}), mergeSkipped: true } },
  });
}

export interface ReviewCandidate {
  id: string;
  name: string;
  companyType: string;
  qbCustomerListId: string | null;
  relationCount: number;
  score: number;
  reason: 'exact' | 'field_office' | 'fuzzy';
}
export interface ReviewItem {
  companyId: string;
  name: string;
  companyType: string;
  qbCustomerListId: string | null;
  relationCount: number;
  kind: 'exact_conflict' | 'fuzzy';
  candidates: ReviewCandidate[];
}

/** Exact-name groups that are blocked on a QB conflict — each non-winner gets the
 *  group's other members as merge candidates (human resolves direction). */
async function getExactConflictReview(search: string): Promise<ReviewItem[]> {
  const groups = (await getExactDupGroups()).filter((g) => g.qbConflict);
  const items: ReviewItem[] = [];
  for (const g of groups) {
    if (search && !g.norm.includes(normalizeName(search))) continue;
    for (const m of g.members) {
      items.push({
        companyId: m.id,
        name: m.name,
        companyType: m.companyType,
        qbCustomerListId: m.qbCustomerListId,
        relationCount: m.relationCount,
        kind: 'exact_conflict',
        candidates: g.members
          .filter((o) => o.id !== m.id)
          .map((o) => ({
            id: o.id,
            name: o.name,
            companyType: o.companyType,
            qbCustomerListId: o.qbCustomerListId,
            relationCount: o.relationCount,
            score: 0,
            reason: 'exact' as const,
          })),
      });
    }
  }
  return items;
}

/**
 * Fuzzy / field-office candidates. Companies that look like the same entity are
 * grouped into clusters by two signals: a shared stripped "core" name
 * ("Continental Resources" ↔ "Continental Resources, Inc") and a field-office
 * tag ("Hydra Services LLC - Kraken" → "Kraken Oil & Gas"). Each cluster gets a
 * single canonical winner (QB id → most linked records → oldest), and we emit
 * one row per non-winner pointing at it — so the merge direction is pre-decided
 * and pairs aren't shown twice. Exact-name members are left to the auto/conflict
 * paths and skipped here.
 */
export async function getFuzzyReview(opts: { limit: number; offset: number; search?: string }): Promise<{ total: number; items: ReviewItem[] }> {
  const companies = (await prisma.company.findMany({
    where: { isActive: true },
    select: { id: true, name: true, companyType: true, qbCustomerListId: true, createdAt: true, customData: true },
    orderBy: { name: 'asc' },
  })).filter((c) => (c.customData as any)?.mergeSkipped !== true);

  const byId = new Map(companies.map((c) => [c.id, c]));
  const normOf = new Map(companies.map((c) => [c.id, normalizeName(c.name)]));
  const coreOf = new Map(companies.map((c) => [c.id, coreName(c.name)]));
  const byNorm = new Map<string, string[]>();
  const byCore = new Map<string, string[]>();
  for (const c of companies) {
    const n = normOf.get(c.id)!;
    const k = coreOf.get(c.id)!;
    (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(c.id);
    if (k) (byCore.get(k) ?? byCore.set(k, []).get(k)!).push(c.id);
  }

  // Union-find over companies: union same-core ids, then union each office-tag
  // company with the company its tag names.
  const parent = new Map(companies.map((c) => [c.id, c.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  for (const ids of byCore.values()) {
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }
  for (const c of companies) {
    const tag = officeTag(c.name);
    if (!tag) continue;
    for (const m of [...(byNorm.get(tag) || []), ...(byCore.get(tag) || [])]) union(c.id, m);
  }

  // Group by cluster root; keep clusters with ≥2 members.
  const clusters = new Map<string, string[]>();
  for (const c of companies) {
    const r = find(c.id);
    (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(c.id);
  }

  const relAll = await relationCountsFor(companies.map((c) => c.id));
  const winnerOf = (ids: string[]) =>
    pickWinner(ids.map((id) => byId.get(id)! as unknown as CompanyLite), relAll).id;

  // One row per non-winner member; candidate = the cluster winner.
  const rows: ReviewItem[] = [];
  for (const ids of clusters.values()) {
    if (ids.length < 2) continue;
    const winnerId = winnerOf(ids);
    const winner = byId.get(winnerId)!;
    const winnerNorm = normOf.get(winnerId)!;
    const winnerCore = coreOf.get(winnerId)!;
    for (const id of ids) {
      if (id === winnerId) continue;
      // exact-name members are handled by the auto-merge / QB-conflict paths
      if (normOf.get(id) === winnerNorm) continue;
      const m = byId.get(id)!;
      const tag = officeTag(m.name);
      const isOffice = !!tag && (tag === winnerNorm || tag === winnerCore);
      rows.push({
        companyId: m.id,
        name: m.name,
        companyType: m.companyType,
        qbCustomerListId: m.qbCustomerListId,
        relationCount: relAll.get(m.id) ?? 0,
        kind: 'fuzzy',
        candidates: [{
          id: winner.id,
          name: winner.name,
          companyType: winner.companyType,
          qbCustomerListId: winner.qbCustomerListId,
          relationCount: relAll.get(winner.id) ?? 0,
          score: isOffice ? 0.05 : 0.2,
          reason: isOffice ? 'field_office' : 'fuzzy',
        }],
      });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const filtered = opts.search?.trim()
    ? rows.filter((r) => r.name.toLowerCase().includes(opts.search!.trim().toLowerCase()))
    : rows;

  return { total: filtered.length, items: filtered.slice(opts.offset, opts.offset + opts.limit) };
}

/** Combined review queue: QB-conflict exact dups first, then fuzzy candidates. */
export async function getReviewQueue(opts: { limit?: number; offset?: number; search?: string }) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const offset = opts.offset ?? 0;
  const search = (opts.search || '').trim();

  const conflicts = await getExactConflictReview(search);
  // Conflicts are few; show them all up front, then page fuzzy beneath.
  if (offset < conflicts.length) {
    const slice = conflicts.slice(offset, offset + limit);
    const remaining = limit - slice.length;
    let fuzzyItems: ReviewItem[] = [];
    let fuzzyTotal = 0;
    if (remaining > 0) {
      const f = await getFuzzyReview({ limit: remaining, offset: 0, search });
      fuzzyItems = f.items;
      fuzzyTotal = f.total;
    } else {
      fuzzyTotal = (await getFuzzyReview({ limit: 1, offset: 0, search })).total;
    }
    return { total: conflicts.length + fuzzyTotal, limit, offset, items: [...slice, ...fuzzyItems] };
  }
  const fuzzyOffset = offset - conflicts.length;
  const f = await getFuzzyReview({ limit, offset: fuzzyOffset, search });
  return { total: conflicts.length + f.total, limit, offset, items: f.items };
}
