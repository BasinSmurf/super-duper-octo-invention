/**
 * rentalsBoard.ts — shared rentals-kiosk board builder.
 *
 * Three columns: Scheduled, Active, Recently Closed. Recently Closed is an
 * interim 14-day window for now — once billing-cadence lands with a real
 * "fully billed" signal (Invoice.rentalAgreementId + periodEnd), swap the
 * completed-agreement filter below for that instead of the time window.
 *
 * The board slices two ways, and both are filters over the same three columns
 * rather than different boards:
 *
 *   site         which shop runs the rental. `null` means "every site", which
 *                is what the in-app board defaults to; a kiosk is always
 *                pinned to its own site.
 *   pickupType   dispatch (Basin delivers) vs walk_in (customer carries out).
 *                A dispatcher's wall and the front counter want opposite
 *                halves of the same list, so this is the kiosk-role axis.
 */

import { prisma } from '../index.js';
import type { RentalPickupType } from '../db.js';
import type { RentalComposition } from './rentalComposition.js';

const RECENTLY_CLOSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const rentalBoardCardInclude = {
  company: { select: { id: true, name: true } },
  pad: { select: { id: true, name: true } },
  well: { select: { id: true, wellName: true } },
  site: { select: { id: true, name: true, shortCode: true } },
  _count: { select: { items: true } },
} as const;

export interface RentalsBoardFilter {
  /** Restrict to one shop. Omit/null for every site. */
  siteId?: string | null;
  /** Restrict to one pickup type. Omit/null for both. */
  pickupType?: RentalPickupType | null;
}

/** The two pickup types, as the kiosk roles that pin a display to each. */
export const KIOSK_ROLE_PICKUP_TYPE: Record<string, RentalPickupType> = {
  RENTALS_DISPATCH: 'dispatch',
  RENTALS_WALKIN: 'walk_in',
};

/**
 * Parse a `?pickupType=` query value. Anything that isn't one of the two
 * enum values reads as "no filter" rather than erroring — a wall display
 * showing everything is a better failure than one showing a stack trace.
 */
export function parsePickupType(raw: unknown): RentalPickupType | null {
  return raw === 'dispatch' || raw === 'walk_in' ? raw : null;
}

/** The filters a kiosk gets: its own site, and the type its role names. */
export function kioskBoardFilter(kiosk: { siteId: string; role: string }): RentalsBoardFilter {
  return {
    siteId: kiosk.siteId,
    // A non-rentals role (a shop BOARD token pointed here by mistake) yields no
    // type filter rather than an error: too much on screen is visibly wrong to
    // whoever provisioned it, an empty board just looks broken.
    pickupType: KIOSK_ROLE_PICKUP_TYPE[kiosk.role] ?? null,
  };
}

/**
 * Turn a filter into the shared WHERE fragment for all three columns.
 *
 * An unset filter is OMITTED rather than expressed as `{ in: [...] }` over
 * every value. That distinction matters for site: "every site" has to include
 * the agreements whose site_id is still null (written before rentals carried a
 * site), and an `in` over the known site ids would silently drop exactly those.
 */
export function boardScopeWhere(filter: RentalsBoardFilter): {
  siteId?: string;
  pickupType?: RentalPickupType;
} {
  return {
    ...(filter.siteId ? { siteId: filter.siteId } : {}),
    ...(filter.pickupType ? { pickupType: filter.pickupType } : {}),
  };
}

export interface RentalBoardCard {
  id: string;
  agreementNumber: string | null;
  companyName: string;
  padName: string | null;
  wellName: string | null;
  status: string;
  startDate: string;
  endDate: string | null;
  itemCount: number;
  isManned: boolean;
  isRigJob: boolean;
  monitorsIncluded: boolean;
  composition: RentalComposition | null;
  pickupType: RentalPickupType;
  /** Null for agreements written before rentals carried a site. */
  siteName: string | null;
  siteShortCode: string | null;
}

export interface RentalsBoardResult {
  scheduled: RentalBoardCard[];
  active: RentalBoardCard[];
  recentlyClosed: RentalBoardCard[];
}

function toCard(a: {
  id: string; agreementNumber: string | null; status: string;
  startDate: Date; endDate: Date | null;
  isManned: boolean; isRigJob: boolean; monitorsIncluded: boolean;
  composition: unknown;
  pickupType: RentalPickupType;
  company: { name: string } | null;
  pad: { name: string } | null;
  well: { wellName: string | null } | null;
  site: { name: string; shortCode: string } | null;
  _count: { items: number };
}): RentalBoardCard {
  return {
    id: a.id,
    agreementNumber: a.agreementNumber,
    companyName: a.company?.name ?? 'Unknown',
    padName: a.pad?.name ?? null,
    wellName: a.well?.wellName ?? null,
    status: a.status,
    startDate: a.startDate.toISOString().slice(0, 10),
    endDate: a.endDate ? a.endDate.toISOString().slice(0, 10) : null,
    itemCount: a._count.items,
    isManned: a.isManned,
    isRigJob: a.isRigJob,
    monitorsIncluded: a.monitorsIncluded,
    composition: (a.composition as RentalComposition | null) ?? null,
    pickupType: a.pickupType,
    siteName: a.site?.name ?? null,
    siteShortCode: a.site?.shortCode ?? null,
  };
}

export async function buildRentalsBoard(
  filter: RentalsBoardFilter = {},
): Promise<RentalsBoardResult> {
  const recentlyClosedCutoff = new Date(Date.now() - RECENTLY_CLOSED_WINDOW_MS);

  const scope = boardScopeWhere(filter);

  const [scheduled, active, recentlyClosed] = await Promise.all([
    prisma.rentalAgreement.findMany({
      where: { ...scope, status: 'scheduled' },
      include: rentalBoardCardInclude,
      orderBy: { startDate: 'asc' },
    }),
    prisma.rentalAgreement.findMany({
      where: { ...scope, status: 'active' },
      include: rentalBoardCardInclude,
      orderBy: { startDate: 'asc' },
    }),
    prisma.rentalAgreement.findMany({
      where: { ...scope, status: 'completed', updatedAt: { gte: recentlyClosedCutoff } },
      include: rentalBoardCardInclude,
      orderBy: { updatedAt: 'desc' },
    }),
  ]);

  return {
    scheduled: scheduled.map(toCard),
    active: active.map(toCard),
    recentlyClosed: recentlyClosed.map(toCard),
  };
}
