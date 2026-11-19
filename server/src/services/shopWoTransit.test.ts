/**
 * The auto-transit branch of createShopWorkOrderWithItems.
 *
 * The claim under test is that "no transfer event was created" is THREE
 * distinct situations that used to collapse into one silent path:
 *
 *   destination == intake site  -> correct, and correctly silent. The tech is
 *                                 standing in the shop; an open transfer would
 *                                 put a phantom card in its own Incoming column.
 *   destination unresolvable    -> a real problem, now recorded on the WO.
 *   destination deactivated     -> likewise, and distinguishable from the above,
 *                                 because a bad short code is a client bug and
 *                                 a dead site is an admin action.
 *
 * Driven through a fake transaction client rather than a database: the branch
 * is pure decision logic over one site lookup, and what matters is which writes
 * come out the other side.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The guard's database behavior isn't under test in this transit fixture.
vi.mock('../utils/companyGuards.js', () => ({
  assertCompanyActive: vi.fn(async () => {}),
}));

const { createShopWorkOrderWithItems } = await import('./shopWoCreate.js');

const INTAKE_SITE = 'site-williston';
const DEST_SITE = 'site-dickinson';

type SiteRow = { id: string; active: boolean; shortCode: string };

/**
 * Records every write the helper attempts. Only the tables the transit branch
 * touches are modelled with any fidelity; the rest return the minimum the
 * caller destructures.
 */
function fakeTx(sites: SiteRow[]) {
  const woUpdates: any[] = [];
  const transferCreates: any[] = [];

  const tx = {
    $executeRaw: vi.fn(async () => 1),
    site: {
      findUnique: vi.fn(async ({ where }: any) => {
        const found = where.id
          ? sites.find((s) => s.id === where.id)
          : sites.find((s) => s.shortCode === where.shortCode);
        return found ? { id: found.id, active: found.active } : null;
      }),
      findFirst: vi.fn(async () => sites.find((s) => s.active) ?? null),
    },
    shopWorkOrder: {
      create: vi.fn(async ({ data }: any) => ({
        id: data.id ?? 'wo-generated',
        workOrderNumber: data.workOrderNumber,
      })),
      update: vi.fn(async (args: any) => {
        woUpdates.push(args.data);
        return {};
      }),
    },
    shopWorkOrderItem: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ id: `item-${data.itemNumber}` })),
    },
    shopItemStatusLog: { create: vi.fn(async () => ({})) },
    shopTransferEvent: {
      create: vi.fn(async (args: any) => {
        transferCreates.push(args.data);
        return {};
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: 'user-tech', isActive: true })),
    },
  };

  return { tx, woUpdates, transferCreates };
}

const basePayload = (transitToShortCode?: string) => ({
  companyId: 'co-1',
  intakeSiteId: INTAKE_SITE,
  contactsOptional: true,
  dropOffContact: { name: 'Field Tech', preferred: 'call' },
  transportedById: 'user-tech',
  ...(transitToShortCode === undefined ? {} : { transitToShortCode }),
  items: [{ serialNumber: 'SN-1', equipmentCategory: 'fire_extinguisher' }],
});

async function run(sites: SiteRow[], transitToShortCode?: string) {
  const { tx, woUpdates, transferCreates } = fakeTx(sites);
  const result = await createShopWorkOrderWithItems(tx as any, {
    id: 'wo-1',
    workOrderNumber: 'SW-1001',
    userId: 'user-tech',
    payload: basePayload(transitToShortCode) as any,
  });
  return { result, woUpdates, transferCreates };
}

const WILLISTON: SiteRow = { id: INTAKE_SITE, active: true, shortCode: 'WIL' };
const DICKINSON: SiteRow = { id: DEST_SITE, active: true, shortCode: 'DIK' };

/** Only the transit-failure stamp, ignoring the totalItems bookkeeping update. */
const failureStamp = (woUpdates: any[]) =>
  woUpdates.find((u) => 'transitFailedReason' in u);

beforeEach(() => vi.clearAllMocks());

describe('a destination that resolves to another active site', () => {
  it('creates the transfer event and caches the destination on the WO', async () => {
    const { result, woUpdates, transferCreates } = await run([WILLISTON, DICKINSON], 'DIK');

    expect(transferCreates).toHaveLength(1);
    expect(transferCreates[0]).toMatchObject({
      workOrderId: 'wo-1',
      fromSiteId: INTAKE_SITE,
      toSiteId: DEST_SITE,
      transportedById: 'user-tech',
    });
    // The WO-level cache has to agree with the event, the same invariant manual
    // transfers maintain -- the board reads one, aging reads the other.
    expect(woUpdates.some((u) => u.transitToSiteId === DEST_SITE)).toBe(true);
    expect(result.transitWarning).toBeUndefined();
    expect(failureStamp(woUpdates)).toBeUndefined();
  });
});

describe('a destination that IS the intake site', () => {
  it('stays silent -- nothing is in transit, so nothing is recorded', async () => {
    const { result, woUpdates, transferCreates } = await run([WILLISTON, DICKINSON], 'WIL');

    expect(transferCreates).toHaveLength(0);
    // The whole point: this is the one no-op that must NOT look like a problem.
    expect(result.transitWarning).toBeUndefined();
    expect(failureStamp(woUpdates)).toBeUndefined();
    expect(woUpdates.some((u) => u.transitToSiteId)).toBe(false);
  });
});

describe('a destination that cannot be resolved', () => {
  it('records unknown_short_code and still returns the work order', async () => {
    const { result, woUpdates, transferCreates } = await run([WILLISTON], 'ZZZ');

    expect(transferCreates).toHaveLength(0);
    // Created, not rejected. This path replays through /sync/push, where a
    // throw would dead-letter the mutation and lose the WO over a transit bug.
    expect(result.id).toBe('wo-1');
    expect(result.totalItems).toBe(1);

    expect(result.transitWarning).toMatchObject({
      shortCode: 'ZZZ',
      reason: 'unknown_short_code',
    });
    expect(result.transitWarning!.message).toContain('SW-1001');
    expect(failureStamp(woUpdates)).toMatchObject({
      transitFailedShortCode: 'ZZZ',
      transitFailedReason: 'unknown_short_code',
    });
    expect(failureStamp(woUpdates)!.transitFailedAt).toBeInstanceOf(Date);
  });

  it('treats a whitespace-only short code as unresolvable, not as a site', async () => {
    const { result, transferCreates } = await run([WILLISTON, DICKINSON], '   ');

    expect(transferCreates).toHaveLength(0);
    expect(result.transitWarning?.reason).toBe('unknown_short_code');
  });
});

describe('a destination site that has been deactivated', () => {
  it('records site_inactive, distinctly from a bad code', async () => {
    const { result, woUpdates, transferCreates } = await run(
      [WILLISTON, { ...DICKINSON, active: false }],
      'DIK',
    );

    expect(transferCreates).toHaveLength(0);
    expect(result.transitWarning).toMatchObject({
      shortCode: 'DIK',
      reason: 'site_inactive',
    });
    expect(failureStamp(woUpdates)).toMatchObject({
      transitFailedReason: 'site_inactive',
    });
  });
});

describe('no destination requested at all', () => {
  it('is untouched by any of this', async () => {
    const { result, woUpdates, transferCreates } = await run([WILLISTON, DICKINSON]);

    expect(transferCreates).toHaveLength(0);
    expect(result.transitWarning).toBeUndefined();
    expect(failureStamp(woUpdates)).toBeUndefined();
  });
});
