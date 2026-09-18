/**
 * shopAging.ts — the aging lists that replaced the board's aging pills (WI-03).
 *
 * The pills were a wall-display ornament: they told you something was old but
 * not which things, and you couldn't act on them. These are the same fact as a
 * filterable list, on an authenticated device, scoped to a branch.
 *
 * THREE BUCKETS, and they partition the live board rather than overlapping:
 *
 *   open     units rendering as Received or In Service. Post-WI-01 that
 *            includes qc_testing, since re-test is no longer its own column.
 *   on_hold  parked for any reason (see services/shopHoldReason.ts).
 *   waiting  work finished, gear still sitting here waiting on the customer.
 *
 * WHERE THE CLOCK STARTS differs by bucket, deliberately:
 *
 *   open     from WO intake. "How long have we had this?" — the question the
 *            customer asks. Uses intakeDate so the number matches the board's
 *            `daysOpen` exactly; two surfaces disagreeing about a unit's age is
 *            worse than either definition being marginally better.
 *   on_hold  from entry into the current status. A unit that worked for a week
 *            and has been stuck on parts for two days is two days stuck, and
 *            that is the number that decides whether to chase the vendor.
 *   waiting  same, from entry into shop_complete: days since we told them it
 *            was ready.
 *
 * THRESHOLD SEMANTICS: `olderThanDays: 30` means age >= 30, matching the "30+"
 * label the user reads. Strict > would make a list labelled "30+" exclude the
 * 30-day-old unit sitting right at the line.
 */

import { prisma } from '../index.js';
import type { ShopItemStatus } from '../db.js';
import { HOLD_STATUSES, resolveHoldReason, type ResolvedHoldReason } from './shopHoldReason.js';

export type AgingBucket = 'open' | 'on_hold' | 'waiting';

export const AGING_BUCKETS: AgingBucket[] = ['open', 'on_hold', 'waiting'];

/** Selectable "older than" thresholds. 0 means no filter — show everything. */
export const AGING_THRESHOLDS = [0, 7, 30, 60, 90] as const;
export type AgingThreshold = (typeof AGING_THRESHOLDS)[number];

const BUCKET_STATUSES: Record<AgingBucket, ShopItemStatus[]> = {
  // Received + In Service, as the board collapses them post-WI-01.
  open: ['received', 'diagnosing', 'in_work', 'qc_testing'],
  on_hold: HOLD_STATUSES,
  waiting: ['shop_complete'],
};

export const BUCKET_LABEL: Record<AgingBucket, string> = {
  open: 'Open',
  on_hold: 'On Hold',
  waiting: 'Waiting on Pickup',
};

export function isAgingBucket(v: unknown): v is AgingBucket {
  return typeof v === 'string' && (AGING_BUCKETS as string[]).includes(v);
}

export function normalizeThreshold(v: unknown): AgingThreshold {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return (AGING_THRESHOLDS as readonly number[]).includes(n) ? (n as AgingThreshold) : 0;
}

export interface AgingRow {
  itemId: string;
  workOrderId: string;
  workOrderNumber: string;
  customer: string;
  equipment: string;
  serialNumber: string;
  status: ShopItemStatus;
  ageDays: number;
  siteName: string;
  assigned: string | null;
  /** Populated for the on_hold bucket; null elsewhere. */
  holdReason: ResolvedHoldReason | null;
}

export interface AgingResult {
  bucket: AgingBucket;
  olderThanDays: AgingThreshold;
  /** Units at or past the threshold. */
  count: number;
  /** Units in the bucket regardless of threshold — the "of N" denominator. */
  totalInBucket: number;
  /** Oldest first, capped (see ROW_CAP). */
  rows: AgingRow[];
  /** True when rows were truncated, so the UI can say so instead of implying completeness. */
  truncated: boolean;
}

export interface AgingQuery {
  bucket: AgingBucket;
  olderThanDays: AgingThreshold;
  /** null = every site (supervisor "All"); otherwise restrict to this site. */
  siteId: string | null;
  /** When set, only units assigned to this user ("my tickets"). */
  assignedToId?: string | null;
}

/** A widget shows a list, not a database. Anything past this is a report. */
const ROW_CAP = 100;

const MS_PER_DAY = 86_400_000;

function wholeDaysSince(from: Date, now: number): number {
  return Math.max(0, Math.floor((now - from.getTime()) / MS_PER_DAY));
}

/**
 * The shape buildAgingRows needs. Deliberately narrower than the Prisma row so
 * the aging maths is testable without a database -- the boundary behaviour
 * (exactly 7, exactly 90, 91) is the part worth pinning down, and it has
 * nothing to do with how the rows were fetched.
 */
export interface AgingSource {
  id: string;
  status: ShopItemStatus;
  serialNumber: string;
  equipmentCategory: string;
  equipmentDescription: string | null;
  createdAt: Date;
  holdReason: import('../db.js').ShopHoldReason | null;
  holdNote: string | null;
  workOrderId: string;
  site: { name: string };
  assignedTo: { name: string } | null;
  workOrder: { workOrderNumber: string; intakeDate: Date; company: { name: string } };
  statusHistory: Array<{ toStatus: ShopItemStatus; createdAt: Date }>;
}

/** Pure: source rows -> aged rows. See the header for where each clock starts. */
export function buildAgingRows(
  items: AgingSource[],
  bucket: AgingBucket,
  now: Date = new Date(),
): AgingRow[] {
  const nowMs = now.getTime();
  return items.map((it) => {
    const ageFrom =
      bucket === 'open'
        ? it.workOrder.intakeDate
        : (it.statusHistory.find((h) => h.toStatus === it.status)?.createdAt ?? it.createdAt);

    return {
      itemId: it.id,
      workOrderId: it.workOrderId,
      workOrderNumber: it.workOrder.workOrderNumber,
      customer: it.workOrder.company.name,
      equipment: it.equipmentDescription || it.equipmentCategory,
      serialNumber: it.serialNumber,
      status: it.status,
      ageDays: wholeDaysSince(ageFrom, nowMs),
      siteName: it.site.name,
      assigned: it.assignedTo?.name ?? null,
      holdReason: bucket === 'on_hold' ? resolveHoldReason(it) : null,
    };
  });
}

/**
 * Pure: apply the "older than N" filter, oldest first.
 *
 * `>=`, not `>`: a list the user picked "30+ days" from must contain the unit
 * that is exactly 30 days old. 0 means no filter at all.
 */
export function applyAgeThreshold(rows: AgingRow[], olderThanDays: number): AgingRow[] {
  return rows
    .filter((r) => r.ageDays >= olderThanDays)
    .sort((a, b) => b.ageDays - a.ageDays);
}

export async function getShopAging(q: AgingQuery, now: Date = new Date()): Promise<AgingResult> {
  const statuses = BUCKET_STATUSES[q.bucket];

  const items = await prisma.shopWorkOrderItem.findMany({
    where: {
      status: { in: statuses },
      // Sub-components ride with their parent assembly and are not separately
      // countable pieces — same exclusion the board makes.
      parentItemId: null,
      ...(q.siteId ? { siteId: q.siteId } : {}),
      ...(q.assignedToId ? { assignedToId: q.assignedToId } : {}),
    },
    select: {
      id: true,
      status: true,
      serialNumber: true,
      equipmentCategory: true,
      equipmentDescription: true,
      createdAt: true,
      holdReason: true,
      holdNote: true,
      workOrderId: true,
      site: { select: { name: true } },
      assignedTo: { select: { name: true } },
      workOrder: {
        select: { workOrderNumber: true, intakeDate: true, company: { select: { name: true } } },
      },
      // Only the entry into the CURRENT status matters for time-in-state, and
      // the newest such row is the current stint (a unit can re-enter a status).
      statusHistory: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { toStatus: true, createdAt: true },
      },
    },
  });

  const rows = buildAgingRows(items, q.bucket, now);
  const past = applyAgeThreshold(rows, q.olderThanDays);

  return {
    bucket: q.bucket,
    olderThanDays: q.olderThanDays,
    count: past.length,
    totalInBucket: rows.length,
    rows: past.slice(0, ROW_CAP),
    truncated: past.length > ROW_CAP,
  };
}
