import { describe, it, expect, vi } from 'vitest';
import { routeShopItemFromInspection } from './inspectionRouting.js';
import { getRequiredShopKeys } from './inspectionChecklist.js';

/**
 * The QA backstop in the routing path is the one that actually fires in the
 * field: an offline "Lock" replays through sync.ts as a plain field write and
 * then calls routeShopItemFromInspection DIRECTLY, never touching
 * lockInspectionRecord where the checklist used to be enforced. These tests
 * pin the behaviour that closes that door.
 *
 * The fake carries only the four model calls routing touches, and records the
 * write so the assertions can be about WHAT was written rather than about the
 * return value alone.
 */
function fakePrisma(opts: {
  itemStatus: string;
  equipmentCategory?: string;
  qaChecklist?: Record<string, boolean>;
  inspectionCount?: number;
  hardClosesAt?: Date;
  serialNumber?: string;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const tx = {
    shopWorkOrderItem: {
      update: vi.fn(async ({ data }: never) => {
        updates.push(data as Record<string, unknown>);
      }),
    },
    shopItemStatusLog: {
      create: vi.fn(async ({ data }: never) => {
        logs.push(data as Record<string, unknown>);
      }),
    },
  };
  const prisma = {
    shopWorkOrderItem: {
      findMany: vi.fn().mockResolvedValue([{ id: 'unit-1', itemNumber: 1, serialNumber: opts.serialNumber ?? 'SN-1' }]),
      findUnique: vi.fn().mockResolvedValue({
        id: 'unit-1',
        status: opts.itemStatus,
        workOrderId: 'wo-1',
        equipmentCategory: opts.equipmentCategory ?? 'fire_extinguisher',
        parentItemId: null,
        equipmentDescription: '',
        fexBrand: '',
        partsUsed: [],
        hardClosesAt: opts.hardClosesAt ?? new Date(Date.now() + 3600000),
        billedAt: null,
      }),
    },
    equipmentInspection: {
      findMany: vi.fn().mockResolvedValue(
        opts.qaChecklist === undefined
          ? []
          : [{ data: { qaChecklist: opts.qaChecklist }, outcome: 'pass', serviceActions: [] }],
      ),
    },
    // WI-06 batch results — none in these fixtures; the routing backstop reads
    // the same shared predicate, which consults both sources.
    shopQaUnitResult: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<void>) => fn(tx)),
  } as never;
  return { prisma, updates, logs };
}

function completeFexChecklist(): Record<string, boolean> {
  const checks: Record<string, boolean> = {};
  for (const k of getRequiredShopKeys('fire_extinguisher')) checks[k] = true;
  return checks;
}

const PASS_INSPECTION = {
  id: 'insp-1',
  shopItemId: 'unit-1',
  category: 'fire_extinguisher',
  outcome: 'pass',
  data: {},
};

describe('routeShopItemFromInspection — QA backstop', () => {
  it.each(['pass', 'condemn'])('withholds %s routing when a piece has no serial', async outcome => {
    const { prisma, updates } = fakePrisma({ itemStatus: 'diagnosing', serialNumber: '', qaChecklist: completeFexChecklist() });
    const result = await routeShopItemFromInspection(prisma, { ...PASS_INSPECTION, outcome }, 'user-1');
    expect(result.routed).toBe(false);
    expect(result.reason).toMatch(/serial/i);
    expect(updates).toHaveLength(0);
  });

  it.each(['fail', 'requires_parts'])('reopens a ready unit for a %s correction inside its correction window', async (outcome) => {
    const { prisma, updates } = fakePrisma({ itemStatus: 'shop_complete' });
    const result = await routeShopItemFromInspection(prisma, { ...PASS_INSPECTION, outcome }, 'user-1');
    expect(result.toStatus).toBe('in_work');
    expect(updates[0]?.status).toBe('in_work');
  });
  it('does not silently reopen a hard-closed unit from an inspection replay', async () => {
    const { prisma, updates } = fakePrisma({ itemStatus: 'shop_complete', hardClosesAt: new Date(0) });
    const result = await routeShopItemFromInspection(prisma, { ...PASS_INSPECTION, outcome: 'fail' }, 'user-1');
    expect(result.routed).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it('releases to shop_complete when the checklist is complete', async () => {
    const { prisma, updates } = fakePrisma({
      itemStatus: 'diagnosing',
      qaChecklist: completeFexChecklist(),
    });
    const result = await routeShopItemFromInspection(prisma, PASS_INSPECTION, 'user-1');
    expect(result.routed).toBe(true);
    expect(result.toStatus).toBe('shop_complete');
    expect(updates[0]?.status).toBe('shop_complete');
  });

  it('does NOT release a pass whose checklist is empty — diverts to qc_testing', async () => {
    // This is the whole bug: outcome 'pass' with nothing checked used to walk
    // straight through to shop_complete, which starts the 48h billing clock.
    const { prisma, updates } = fakePrisma({ itemStatus: 'diagnosing', qaChecklist: {} });
    const result = await routeShopItemFromInspection(prisma, PASS_INSPECTION, 'user-1');
    expect(result.routed).toBe(true);
    expect(result.toStatus).toBe('qc_testing');
    expect(updates[0]?.status).toBe('qc_testing');
    expect(updates[0]?.status).not.toBe('shop_complete');
  });

  it('says why in the unit status log, so the supervisor is not guessing', async () => {
    const { prisma, logs } = fakePrisma({ itemStatus: 'in_work', qaChecklist: {} });
    await routeShopItemFromInspection(prisma, PASS_INSPECTION, 'user-1');
    expect(String(logs[0]?.notes)).toMatch(/withheld/i);
    expect(String(logs[0]?.notes)).toMatch(/still required/i);
  });

  it('never throws — routing is called from inside a lock it must not break', async () => {
    const { prisma } = fakePrisma({ itemStatus: 'diagnosing', qaChecklist: {} });
    await expect(
      routeShopItemFromInspection(prisma, PASS_INSPECTION, 'user-1'),
    ).resolves.toBeDefined();
  });

  it('declines to route, rather than writing anything, when the divert is not available', async () => {
    // Already in the re-test lane: there is nowhere further back to send it, so
    // the unit stays put and the caller is told why.
    const { prisma, updates } = fakePrisma({ itemStatus: 'qc_testing', qaChecklist: {} });
    const result = await routeShopItemFromInspection(prisma, PASS_INSPECTION, 'user-1');
    expect(result.routed).toBe(false);
    expect(result.reason).toMatch(/QA gate/i);
    expect(updates).toHaveLength(0);
  });

  it('leaves non-pass outcomes alone — they are recording a problem, not certifying', async () => {
    // 'fail' routes to in_work regardless of the checklist; gating it would
    // strand a failed unit at its old status with nothing to show for it.
    const { prisma, updates } = fakePrisma({ itemStatus: 'diagnosing', qaChecklist: {} });
    const result = await routeShopItemFromInspection(
      prisma,
      { ...PASS_INSPECTION, outcome: 'fail' },
      'user-1',
    );
    expect(result.routed).toBe(true);
    expect(result.toStatus).toBe('in_work');
    expect(updates[0]?.status).toBe('in_work');
  });

  it('does not gate a category that has no shop checklist', async () => {
    const { prisma } = fakePrisma({
      itemStatus: 'diagnosing',
      equipmentCategory: 'other',
      qaChecklist: undefined,
    });
    const result = await routeShopItemFromInspection(
      prisma,
      { ...PASS_INSPECTION, category: 'other' },
      'user-1',
    );
    expect(result.routed).toBe(true);
    expect(result.toStatus).toBe('shop_complete');
  });
});
