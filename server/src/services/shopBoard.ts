/**
 * shopBoard.ts — shared shop-kanban builder.
 *
 * One card per JOB-LINE: items are grouped by (work order, column, status) so
 * a customer who drops 100 identical units in one WO shows as a single card
 * reading "100 pcs" instead of 100 cards. A job only splits into multiple
 * cards when its items genuinely sit at different stages. Column placement is
 * driven by ShopItemStatus. `returned` items leave the board entirely (master
 * doc §12 decision) and are surfaced as a rolling "closed this week" count.
 * Aging thresholds come from the admin-tunable BoardConfig singleton.
 */

import { prisma } from '../index.js';
import type { Prisma, ShopItemStatus } from '../db.js';
import { resolveHoldReason, type ResolvedHoldReason } from './shopHoldReason.js';

export type ShopBoardColumn =
  | 'incoming'
  | 'received'
  | 'needs_review'
  | 'waiting_approval'
  | 'waiting_parts'
  | 'on_hold'
  | 'in_service'
  | 'qa_testing'
  | 'ready_pickup'
  | 'departing';

// The 8 normal workflow columns — incoming/departing are transit-only.
const WORKFLOW_COLUMNS: ShopBoardColumn[] = [
  'received', 'needs_review', 'waiting_approval', 'waiting_parts', 'on_hold',
  'in_service', 'qa_testing', 'ready_pickup',
];

// null === leaves the board (returned/closed → counted, not carded).
const COLUMN_FOR_STATUS: Record<ShopItemStatus, ShopBoardColumn | null> = {
  received: 'received',
  diagnosing: 'needs_review',
  awaiting_approval: 'waiting_approval',
  awaiting_parts: 'waiting_parts',
  warranty_out: 'waiting_parts',
  outside_service: 'waiting_parts',
  in_work: 'in_service',
  // WI-02 generic park. Its own granular column so a station kiosk can slice it;
  // the wall board folds it into the collapsed "On Hold" display column.
  on_hold: 'on_hold',
  qc_testing: 'qa_testing',
  shop_complete: 'ready_pickup',
  returned: null,
  // condemned is terminal (DEAD record written) — leaves the board like returned.
  condemned: null,
};

// Hours-in-status before a card flags as aging. Seeded into BoardConfig;
// these are the fallback when the config row is missing a key.
export const DEFAULT_AGING_THRESHOLDS: Record<string, number> = {
  received: 24,
  diagnosing: 24,
  awaiting_approval: 48,
  awaiting_parts: 72,
  warranty_out: 168,
  outside_service: 168,
  in_work: 24,
  qc_testing: 24,
  shop_complete: 48,
  on_hold: 72,
};

/**
 * Which half of the shop a board is showing.
 *
 *   'customer' — everything dropped off by a paying customer (the wall board
 *                that has always existed).
 *   'internal' — Basin's own gear, serviced in house (ShopWorkOrder.isInternal).
 *   'all'      — no split. Station benches use this: a bench works whatever is
 *                physically in front of it and doesn't care who owns it.
 *
 * 'customer' and 'internal' partition the shop exactly — every item belongs to
 * one and only one, because isInternal is a non-null boolean on every WO.
 */
export type BoardScope = 'customer' | 'internal' | 'all';

/** Parse a `?scope=` query value, falling back to `fallback` for anything else. */
export function parseBoardScope(raw: unknown, fallback: BoardScope): BoardScope {
  return raw === 'customer' || raw === 'internal' || raw === 'all' ? raw : fallback;
}

/**
 * The `where` fragment that narrows a board query to its scope. Spread into a
 * ShopWorkOrderItem where clause; `all` contributes nothing.
 */
export function scopeWhere(scope: BoardScope): Prisma.ShopWorkOrderItemWhereInput {
  if (scope === 'all') return {};
  return { workOrder: { is: { isInternal: scope === 'internal' } } };
}

export const boardItemInclude = {
  workOrder: {
    select: {
      id: true,
      workOrderNumber: true,
      priority: true,
      promisedDate: true,
      intakeDate: true,
      status: true,
      company: { select: { id: true, name: true } },
    },
  },
  product: { select: { name: true } },
  assignedTo: { select: { id: true, name: true } },
  statusHistory: {
    orderBy: { createdAt: 'desc' as const },
    take: 20,
    select: { toStatus: true, createdAt: true },
  },
  // Open transfer (if any) for this specific item — drives the transit columns.
  transferItems: {
    where: { event: { receivedAt: null } },
    select: { event: { select: { toSiteId: true } } },
  },
} satisfies Prisma.ShopWorkOrderItemInclude;

type BoardItem = Prisma.ShopWorkOrderItemGetPayload<{ include: typeof boardItemInclude }>;

export interface BoardCard {
  id: string;
  workOrderId: string;
  workOrderNumber: string;
  column: ShopBoardColumn;
  status: ShopItemStatus;
  customer: string;
  equipment: string;
  title: string;
  serviceType: string;
  assigned: string;
  priority: 'critical' | 'rush' | 'normal';
  priorityRaw: number;
  value: number;
  daysOpen: number;
  hoursInStatus: number;
  due: string | null;
  flags: string[];
  /** How many physical units this card represents. */
  pieceCount: number;
  /** The item IDs squashed into this card — used by batch actions (claim). */
  itemIds: string[];
  /** Personal-monitor storage bins on this card (e.g. ["Bin 7"]); [] otherwise. */
  bins: string[];
  /**
   * WI-02: why this card is parked, or null when it isn't. Derived from status
   * for the parts/approval/vendor holds; read from the item only for the
   * generic `on_hold` status. See services/shopHoldReason.ts.
   */
  holdReason: ResolvedHoldReason | null;
}

/** Read a personal-monitor's stored bin location off its customData JSON. */
export function binLocationOf(customData: unknown): string | null {
  if (customData && typeof customData === 'object' && !Array.isArray(customData)) {
    const v = (customData as Record<string, unknown>).binLocation;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Bins currently held by an active (non-returned, non-condemned) personal
 * monitor. Occupancy is computed live off item status rather than cleared on
 * pickup — once an item hits `returned`/`condemned` it drops out of this map
 * on its own, with no extra bookkeeping needed on the release/void/force-close
 * paths that already flip status to `returned`.
 */
export async function getOccupiedBins(): Promise<Map<string, { workOrderNumber: string; itemId: string }>> {
  const items = await prisma.shopWorkOrderItem.findMany({
    where: { equipmentCategory: 'personal_monitor', status: { notIn: ['returned', 'condemned'] } },
    select: { id: true, customData: true, workOrder: { select: { workOrderNumber: true } } },
  });
  const map = new Map<string, { workOrderNumber: string; itemId: string }>();
  for (const it of items) {
    const bin = binLocationOf(it.customData);
    if (bin) map.set(bin, { workOrderNumber: it.workOrder.workOrderNumber, itemId: it.id });
  }
  return map;
}

/** Load the admin-tuned aging thresholds, falling back to the defaults. */
export async function getAgingThresholds(): Promise<Record<string, number>> {
  const cfg = await prisma.boardConfig.findFirst();
  if (cfg && cfg.agingThresholds && typeof cfg.agingThresholds === 'object') {
    return { ...DEFAULT_AGING_THRESHOLDS, ...(cfg.agingThresholds as Record<string, number>) };
  }
  return DEFAULT_AGING_THRESHOLDS;
}

/**
 * Admin-set per-display-column color overrides, surfaced in every board
 * response so kiosks (which can't reach the JWT-only /board-config) get them.
 * Returns only the stored overrides ({} when none) — the client merges these
 * over its built-in defaults, which remain the single source of truth.
 */
export async function getColumnColors(): Promise<Record<string, string | null>> {
  const cfg = await prisma.boardConfig.findFirst();
  const stored = cfg?.columnColors;
  return stored && typeof stored === 'object' ? (stored as Record<string, string | null>) : {};
}

function priorityBucket(priority: number): 'critical' | 'rush' | 'normal' {
  if (priority <= 2) return 'critical';
  if (priority <= 4) return 'rush';
  return 'normal';
}

const CATEGORY_LABEL: Record<string, string> = {
  fire_extinguisher: 'Fire Extinguisher',
  area_monitor: 'Area Monitor',
  personal_monitor: 'Personal Monitor',
  gas_monitor: 'Gas Monitor',
  fall_arrest: 'Fall Arrest',
  scba: 'SCBA',
  ue_cylinder: 'UE Cylinder',
  other: 'Other',
};
function humanizeCategory(raw: string): string {
  return CATEGORY_LABEL[raw] ?? raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

interface BoardResult {
  cards: BoardCard[];
  summary: {
    openCount: number;
    openValue: number;
    flaggedCount: number;
    waitingPartsValue: number;
    closedThisWeek: number;
    bottleneck: { column: ShopBoardColumn; count: number } | null;
  };
}

/**
 * Turn a set of work-order items into board cards + summary stats.
 *
 * The transit columns are driven by open transfer events (an event with
 * receivedAt null), which both a manual inter-site transfer and a
 * field-inspection spawn create — so they populate on their own, with no
 * per-board configuration.
 *
 * `boardSiteId` decides how transit is framed. On a per-site board it is
 * directional: items in transit *to* this site land in `incoming`, items
 * physically here whose transfer is heading *out* land in `departing`. On the
 * all-sites board (null) there is no "toward me" to measure against, so a unit
 * with an open transfer is simply in transit and lands in `incoming` — which
 * the client titles "In Transit" when the board has no site. Either way the
 * column only exists while something is in it; the client drops transit
 * columns that hold no cards.
 */
export function buildBoard(
  items: BoardItem[],
  thresholds: Record<string, number>,
  boardSiteId?: string | null,
): BoardResult {
  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // First pass: bucket live items by (work order, column, status). Returned
  // items leave the board and feed the rolling "closed this week" count.
  const groups = new Map<string, BoardItem[]>();
  let closedThisWeek = 0;

  for (const it of items) {
    const statusColumn = COLUMN_FOR_STATUS[it.status];
    if (statusColumn === null) {
      if (now - it.updatedAt.getTime() <= WEEK_MS) closedThisWeek++;
      continue;
    }

    // Transit overrides the status column. On a per-site board an item not
    // physically here was loaded because it's in transit toward here
    // (incoming); an item here with an open transfer is leaving (departing).
    // On the all-sites board both are the same fact about the same unit, so it
    // gets the one transit column rather than being double-counted.
    let column: ShopBoardColumn = statusColumn;
    const inTransitTo = it.transferItems[0]?.event.toSiteId ?? null;
    if (boardSiteId) {
      if (it.siteId !== boardSiteId) column = 'incoming';
      else if (inTransitTo) column = 'departing';
    } else if (inTransitTo) {
      column = 'incoming';
    }

    // Reason joins the group key so a card never averages two different holds
    // together. Same principle as the existing status split: a job only becomes
    // two cards when its units genuinely differ.
    const key = `${it.workOrderId}|${column}|${it.status}|${it.holdReason ?? ''}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(it);
    else groups.set(key, [it]);
  }

  // Second pass: collapse each bucket into one card.
  const cards: BoardCard[] = [];
  for (const [key, bucket] of groups) {
    const column = key.split('|')[1] as ShopBoardColumn;
    const head = bucket[0];
    const status = head.status;
    const wo = head.workOrder;

    // Oldest time-in-status across the group drives aging.
    let maxHoursInStatus = 0;
    for (const it of bucket) {
      const enteredStatusAt =
        it.statusHistory.find(h => h.toStatus === it.status)?.createdAt ?? it.createdAt;
      maxHoursInStatus = Math.max(maxHoursInStatus, (now - enteredStatusAt.getTime()) / 3_600_000);
    }

    const daysOpen = Math.max(0, Math.floor((now - wo.intakeDate.getTime()) / 86_400_000));

    const threshold = thresholds[status];
    const flags: string[] = [];
    if (threshold != null && maxHoursInStatus > threshold) flags.push('aging');
    if (status === 'awaiting_parts') flags.push('parts');
    if (status === 'warranty_out' || status === 'outside_service') flags.push('outside');
    if (status === 'awaiting_approval') flags.push('approval');
    if (status === 'qc_testing') flags.push('qa');
    if (status === 'shop_complete') flags.push('pickup');

    const value = bucket.reduce(
      (s, it) => s + (it.estimatedCost ? parseFloat(it.estimatedCost.toString()) : 0),
      0,
    );

    // Equipment label: just the category (monitor/SCBA/etc.). Service type
    // and serials live on the detail page — not card real estate.
    const categories = new Set(bucket.map(it => it.equipmentCategory).filter(Boolean) as string[]);
    const equipment =
      categories.size === 0 ? 'Equipment'
      : categories.size === 1 ? humanizeCategory([...categories][0])
      : `${categories.size} types`;

    // Assignment: the shared tech when uniform, else "N techs".
    const techNames = new Set(bucket.map(it => it.assignedTo?.name).filter(Boolean) as string[]);
    const assigned =
      techNames.size === 0 ? 'Unassigned'
      : techNames.size === 1 ? [...techNames][0]
      : `${techNames.size} techs`;

    // Service-type label: the shared kind of work when uniform, else "N services".
    const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const serviceTypes = new Set(bucket.map(it => it.serviceType).filter(Boolean) as string[]);
    const serviceType =
      serviceTypes.size === 0 ? 'Service'
      : serviceTypes.size === 1 ? humanize([...serviceTypes][0])
      : `${serviceTypes.size} services`;

    // Title: the shared reported issue if any (used in tooltips/detail).
    const issues = new Set(bucket.map(it => it.reportedIssue).filter(Boolean) as string[]);
    const title = issues.size === 1 ? [...issues][0] : serviceType;

    // Personal-monitor bin locations on this card — so the shop can spot where
    // a unit is parked straight from the board.
    const bins = Array.from(new Set(
      bucket
        .filter(it => it.equipmentCategory === 'personal_monitor')
        .map(it => binLocationOf(it.customData))
        .filter((b): b is string => !!b),
    ));

    cards.push({
      id: key,
      holdReason: resolveHoldReason(head),
      workOrderId: head.workOrderId,
      workOrderNumber: wo.workOrderNumber,
      column,
      status,
      customer: wo.company.name,
      equipment,
      title,
      serviceType,
      assigned,
      priority: priorityBucket(wo.priority),
      priorityRaw: wo.priority,
      value,
      daysOpen,
      hoursInStatus: Math.round(maxHoursInStatus),
      due: wo.promisedDate ? wo.promisedDate.toISOString().slice(0, 10) : null,
      flags,
      pieceCount: bucket.length,
      itemIds: bucket.map(it => it.id),
      bins,
    });
  }

  const openValue = cards.reduce((s, c) => s + c.value, 0);
  const flaggedCount = cards.filter(c => c.flags.includes('aging')).length;
  const waitingPartsValue = cards
    .filter(c => c.column === 'waiting_parts')
    .reduce((s, c) => s + c.value, 0);

  // "Open jobs" = distinct work orders on the board (not card or piece count).
  const openCount = new Set(cards.map(c => c.workOrderId)).size;

  // Bottleneck is a workflow signal — counts pieces, not cards, and transit
  // columns don't count.
  const colCounts: Record<string, number> = {};
  for (const c of cards) {
    if (WORKFLOW_COLUMNS.includes(c.column)) {
      colCounts[c.column] = (colCounts[c.column] || 0) + c.pieceCount;
    }
  }
  let bottleneck: { column: ShopBoardColumn; count: number } | null = null;
  for (const [col, count] of Object.entries(colCounts)) {
    if (!bottleneck || count > bottleneck.count) {
      bottleneck = { column: col as ShopBoardColumn, count };
    }
  }

  return {
    cards,
    summary: {
      openCount,
      openValue,
      flaggedCount,
      waitingPartsValue,
      closedThisWeek,
      bottleneck,
    },
  };
}
