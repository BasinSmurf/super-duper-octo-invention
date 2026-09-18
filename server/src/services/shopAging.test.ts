import { describe, it, expect } from 'vitest';
import { buildAgingRows, applyAgeThreshold, normalizeThreshold, type AgingSource } from './shopAging.js';
import type { ShopItemStatus } from '../db.js';

// Fixed "now" so nothing here depends on the day it runs.
const NOW = new Date('2026-08-28T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function source(overrides: Partial<AgingSource> & { id: string }): AgingSource {
  const status = (overrides.status ?? 'in_work') as ShopItemStatus;
  return {
    id: overrides.id,
    status,
    serialNumber: overrides.serialNumber ?? `SN-${overrides.id}`,
    equipmentCategory: overrides.equipmentCategory ?? 'fire_extinguisher',
    equipmentDescription: overrides.equipmentDescription ?? null,
    createdAt: overrides.createdAt ?? daysAgo(1),
    holdReason: overrides.holdReason ?? null,
    holdNote: overrides.holdNote ?? null,
    workOrderId: overrides.workOrderId ?? `wo-${overrides.id}`,
    site: overrides.site ?? { name: 'Williston' },
    assignedTo: overrides.assignedTo ?? null,
    workOrder: overrides.workOrder ?? {
      workOrderNumber: `WO-${overrides.id}`,
      intakeDate: daysAgo(1),
      company: { name: 'Continental' },
    },
    statusHistory: overrides.statusHistory ?? [],
  };
}

describe('buildAgingRows — where the clock starts', () => {
  it('ages the open bucket from WO intake, not from status entry', () => {
    // Sat in intake 40 days, only started being worked yesterday. The customer
    // has been waiting 40 days, and that is the number the list must show.
    const rows = buildAgingRows(
      [
        source({
          id: 'a',
          status: 'in_work',
          workOrder: {
            workOrderNumber: 'WO-a',
            intakeDate: daysAgo(40),
            company: { name: 'Continental' },
          },
          statusHistory: [{ toStatus: 'in_work', createdAt: daysAgo(1) }],
        }),
      ],
      'open',
      NOW,
    );
    expect(rows[0].ageDays).toBe(40);
  });

  it('ages the on_hold bucket from entry into the current status', () => {
    // Same WO age, but stuck on parts for 3 days. Chasing the vendor is a
    // 3-day-old question, not a 40-day-old one.
    const rows = buildAgingRows(
      [
        source({
          id: 'b',
          status: 'awaiting_parts',
          workOrder: {
            workOrderNumber: 'WO-b',
            intakeDate: daysAgo(40),
            company: { name: 'Continental' },
          },
          statusHistory: [{ toStatus: 'awaiting_parts', createdAt: daysAgo(3) }],
        }),
      ],
      'on_hold',
      NOW,
    );
    expect(rows[0].ageDays).toBe(3);
  });

  it('uses the most recent entry when a unit re-entered the same status', () => {
    // statusHistory arrives newest-first from Prisma; the current stint is the
    // first match, not the original one.
    const rows = buildAgingRows(
      [
        source({
          id: 'c',
          status: 'awaiting_parts',
          statusHistory: [
            { toStatus: 'awaiting_parts', createdAt: daysAgo(2) },
            { toStatus: 'in_work', createdAt: daysAgo(10) },
            { toStatus: 'awaiting_parts', createdAt: daysAgo(30) },
          ],
        }),
      ],
      'on_hold',
      NOW,
    );
    expect(rows[0].ageDays).toBe(2);
  });

  it('falls back to item creation when no status-entry log exists', () => {
    const rows = buildAgingRows(
      [source({ id: 'd', status: 'shop_complete', createdAt: daysAgo(9), statusHistory: [] })],
      'waiting',
      NOW,
    );
    expect(rows[0].ageDays).toBe(9);
  });

  it('resolves the hold reason only for the on_hold bucket', () => {
    const parked = source({
      id: 'e',
      status: 'awaiting_parts',
      statusHistory: [{ toStatus: 'awaiting_parts', createdAt: daysAgo(1) }],
    });
    expect(buildAgingRows([parked], 'on_hold', NOW)[0].holdReason).toMatchObject({
      code: 'waiting_parts',
    });
    expect(buildAgingRows([parked], 'open', NOW)[0].holdReason).toBeNull();
  });
});

describe('applyAgeThreshold — boundaries', () => {
  // "30+ days" must include the unit that is exactly 30 days old. These are the
  // boundaries WI-03's acceptance criteria call out by name.
  const rows = buildAgingRows(
    [6, 7, 8, 89, 90, 91].map((age) =>
      source({
        id: `d${age}`,
        status: 'in_work',
        workOrder: {
          workOrderNumber: `WO-${age}`,
          intakeDate: daysAgo(age),
          company: { name: 'Continental' },
        },
      }),
    ),
    'open',
    NOW,
  );

  it('includes exactly 7 at the 7+ threshold and excludes 6', () => {
    expect(applyAgeThreshold(rows, 7).map((r) => r.ageDays)).toEqual([91, 90, 89, 8, 7]);
  });

  it('includes exactly 90 at the 90+ threshold and excludes 89', () => {
    expect(applyAgeThreshold(rows, 90).map((r) => r.ageDays)).toEqual([91, 90]);
  });

  it('treats threshold 0 as unfiltered', () => {
    expect(applyAgeThreshold(rows, 0)).toHaveLength(6);
  });

  it('returns oldest first', () => {
    const ages = applyAgeThreshold(rows, 0).map((r) => r.ageDays);
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
  });
});

describe('normalizeThreshold', () => {
  it('accepts the offered thresholds as strings from the query string', () => {
    expect(normalizeThreshold('30')).toBe(30);
    expect(normalizeThreshold('90')).toBe(90);
  });

  it('falls back to unfiltered rather than trusting an arbitrary number', () => {
    // A hand-crafted ?olderThanDays=45 shouldn't silently produce a list nobody
    // can reproduce from the UI.
    expect(normalizeThreshold('45')).toBe(0);
    expect(normalizeThreshold('nonsense')).toBe(0);
    expect(normalizeThreshold(undefined)).toBe(0);
  });
});
