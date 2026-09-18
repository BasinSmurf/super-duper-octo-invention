/**
 * WI-06 batch QA — the pure half.
 *
 * The interesting claims are all about DERIVATION: that a unit's checklist is
 * resolved by reading through to the batch rather than from a copy, and that
 * "did this pass" is arithmetic on the boxes rather than something the client
 * asserts. Both are what make a one-row correction propagate, so both are
 * tested directly rather than through the route.
 */

import { describe, it, expect } from 'vitest';
import {
  asChecklistResults,
  buildQaSnapshot,
  categoryConflict,
  deriveOutcome,
  effectiveChecklist,
  explainIncomplete,
  snapshotNoteLine,
  unitQaComplete,
} from './shopBatchQa.js';
import {
  checklistVersion,
  getRequiredShopKeys,
  getShopChecklist,
} from './inspectionChecklist.js';

const FEX = 'fire_extinguisher' as const;
const REQUIRED = getRequiredShopKeys(FEX);

/** A checklist with every required box ticked true. */
function allPass(): Record<string, boolean> {
  return Object.fromEntries(REQUIRED.map((k) => [k, true]));
}

describe('asChecklistResults', () => {
  it('keeps only booleans — a checklist is not a place for free text', () => {
    expect(asChecklistResults({ a: true, b: false, c: 'yes', d: 1, e: null }))
      .toEqual({ a: true, b: false });
  });

  it('treats arrays and non-objects as empty rather than throwing', () => {
    expect(asChecklistResults([1, 2])).toEqual({});
    expect(asChecklistResults(null)).toEqual({});
    expect(asChecklistResults('nope')).toEqual({});
  });
});

describe('effectiveChecklist', () => {
  it('lays the unit overrides on top of the batch', () => {
    expect(effectiveChecklist({ a: true, b: true }, { b: false }))
      .toEqual({ a: true, b: false });
  });

  it('is a read-through, so correcting the batch changes every unit', () => {
    const overrides = { b: false };
    const before = effectiveChecklist({ a: false, b: true }, overrides);
    const after = effectiveChecklist({ a: true, b: true }, overrides);
    // The unit row never changed; the batch did, and the unit's answer moved.
    expect(before.a).toBe(false);
    expect(after.a).toBe(true);
    expect(after.b).toBe(false);
  });
});

describe('deriveOutcome', () => {
  it('passes when every required check is affirmatively true', () => {
    const { outcome, failedKeys } = deriveOutcome(FEX, allPass(), {}, []);
    expect(outcome).toBe('pass');
    expect(failedKeys).toEqual([]);
  });

  it('fails, and names the checkpoint, when a required check is false', () => {
    const batch = { ...allPass(), [REQUIRED[0]!]: false };
    const { outcome, failedKeys } = deriveOutcome(FEX, batch, {}, []);
    expect(outcome).toBe('fail');
    expect(failedKeys).toEqual([REQUIRED[0]]);
  });

  it('distinguishes UNANSWERED from FAILED', () => {
    // Leaving a box blank is not evidence the unit is bad. It is not a pass
    // either — but it must not be reported as a failed checkpoint, or the tech
    // gets told a check failed that nobody ever performed.
    const batch = { ...allPass() };
    delete batch[REQUIRED[0]!];
    const { outcome, failedKeys } = deriveOutcome(FEX, batch, {}, []);
    expect(outcome).toBe('fail');
    expect(failedKeys).toEqual([]);
  });

  it('lets one unit fail out of an otherwise passing batch', () => {
    const batch = allPass();
    const good = deriveOutcome(FEX, batch, {}, []);
    const bad = deriveOutcome(FEX, batch, { [REQUIRED[1]!]: false }, []);
    expect(good.outcome).toBe('pass');
    expect(bad.outcome).toBe('fail');
    expect(bad.failedKeys).toEqual([REQUIRED[1]]);
  });

  it('honours an explicit fail even when the boxes all say pass', () => {
    // The category may have no gate at all (`other`), or the tech may have seen
    // something the checklist has no box for. The human wins.
    const { outcome } = deriveOutcome(FEX, allPass(), {}, [], true);
    expect(outcome).toBe('fail');
  });

  it('cannot be talked into a pass by the client — the boxes decide', () => {
    // There is deliberately no `outcome` input to this function. This test
    // exists to fail loudly if someone adds one.
    const batch = { ...allPass(), [REQUIRED[0]!]: false };
    expect(deriveOutcome(FEX, batch, {}, []).outcome).toBe('fail');
  });
});

describe('unitQaComplete', () => {
  it('agrees with the gate the per-unit inspection path uses', () => {
    expect(unitQaComplete(FEX, allPass(), {}, [])).toBe(true);
    expect(unitQaComplete(FEX, allPass(), { [REQUIRED[0]!]: false }, [])).toBe(false);
  });

  it('passes trivially for a category with no shop gate', () => {
    // `other` has no required shop checkpoints. A batch QA of `other` units is
    // a bare attestation — honest, and NOT a claim that a checklist was run.
    expect(unitQaComplete('other', {}, {}, [])).toBe(true);
  });
});

describe('explainIncomplete', () => {
  it('names the missing checks in words a tech can act on', () => {
    const batch = allPass();
    delete batch[REQUIRED[0]!];
    const msg = explainIncomplete(FEX, batch, {}, []);
    expect(msg).not.toBe('');
    expect(msg).not.toContain(REQUIRED[0]!); // label, not key
  });

  it('is empty when nothing is missing', () => {
    expect(explainIncomplete(FEX, allPass(), {}, [])).toBe('');
  });
});

describe('categoryConflict', () => {
  it('accepts a coherent selection and reports its category', () => {
    const { category, error } = categoryConflict([
      { serialNumber: 'A1', equipmentCategory: 'fire_extinguisher' },
      { serialNumber: 'A2', equipmentCategory: 'fire_extinguisher' },
    ]);
    expect(category).toBe(FEX);
    expect(error).toBeNull();
  });

  it('refuses a mixed selection and names the odd units out', () => {
    const { category, error } = categoryConflict([
      { serialNumber: 'A1', equipmentCategory: 'fire_extinguisher' },
      { serialNumber: 'B9', equipmentCategory: 'scba' },
    ]);
    expect(category).toBeNull();
    expect(error).toContain('B9');
  });

  it('folds distinct shop categories that share an inspection checklist', () => {
    // area_monitor and personal_monitor both map to gas_detection: same
    // checklist, so batching them is coherent even though the shop categories
    // differ. Refusing that would be pedantry, not safety.
    const { category, error } = categoryConflict([
      { serialNumber: 'M1', equipmentCategory: 'area_monitor' },
      { serialNumber: 'M2', equipmentCategory: 'personal_monitor' },
    ]);
    expect(error).toBeNull();
    expect(category).toBe('gas_detection');
  });

  it('reports an empty selection rather than inventing a category', () => {
    expect(categoryConflict([]).error).toBeTruthy();
  });
});

describe('checklistVersion', () => {
  it('is stable across calls', () => {
    expect(checklistVersion(FEX)).toBe(checklistVersion(FEX));
  });

  it('differs between categories', () => {
    expect(checklistVersion(FEX)).not.toBe(checklistVersion('scba'));
  });

  it('is namespaced by category so a bare hash collision cannot alias', () => {
    expect(checklistVersion(FEX).startsWith(`${FEX}-`)).toBe(true);
  });
});

describe('buildQaSnapshot', () => {
  const event = {
    id: 'evt-1',
    category: FEX,
    checklistVersion: checklistVersion(FEX),
    checklistResults: allPass(),
    serviceActions: ['annual'],
    notes: 'batch note',
    performedAt: new Date('2026-08-31T14:00:00Z'),
    correctedAt: null,
    performedBy: { name: 'Dana' },
    correctedBy: null,
  };
  const result = {
    id: 'res-1',
    outcome: 'pass',
    checklistOverrides: {},
    failedKeys: [],
    notes: null,
  };

  it('inlines LABELS, not just keys — the record has to outlive the catalog', () => {
    const snap = buildQaSnapshot({
      event, result, batchSize: 4, serialNumber: 'FE-1001',
      customer: 'Acme', workOrderNumber: 'SWO-1', capturedAt: new Date('2026-09-02T14:00:00Z'),
    });
    expect(snap.checkpoints.length).toBe(getShopChecklist(FEX).length);
    for (const cp of snap.checkpoints) {
      expect(typeof cp.label).toBe('string');
      expect(cp.label.length).toBeGreaterThan(0);
    }
  });

  it('stands alone: batch context, actor and customer are all in the snapshot', () => {
    const snap = buildQaSnapshot({
      event, result, batchSize: 4, serialNumber: 'FE-1001',
      customer: 'Acme', workOrderNumber: 'SWO-1', capturedAt: new Date('2026-09-02T14:00:00Z'),
    });
    expect(snap.batchSize).toBe(4);
    expect(snap.performedBy).toBe('Dana');
    expect(snap.customer).toBe('Acme');
    expect(snap.workOrderNumber).toBe('SWO-1');
    expect(snap.serialNumber).toBe('FE-1001');
    expect(snap.checklistVersion).toBe(checklistVersion(FEX));
  });

  it('records an unanswered checkpoint as null, not as a silent false', () => {
    const partial = { ...event, checklistResults: {} };
    const snap = buildQaSnapshot({
      event: partial, result, batchSize: 1, serialNumber: 'FE-2',
      customer: null, workOrderNumber: null, capturedAt: new Date(),
    });
    expect(snap.checkpoints.every((c) => c.result === null)).toBe(true);
  });

  it('resolves the unit override into the snapshot, not the batch value', () => {
    const snap = buildQaSnapshot({
      event,
      result: { ...result, outcome: 'fail', checklistOverrides: { [REQUIRED[0]!]: false }, failedKeys: [REQUIRED[0]!] },
      batchSize: 4, serialNumber: 'FE-3',
      customer: null, workOrderNumber: null, capturedAt: new Date(),
    });
    const cp = snap.checkpoints.find((c) => c.key === REQUIRED[0]);
    expect(cp?.result).toBe(false);
    expect(snap.failedLabels.length).toBe(1);
    expect(snap.failedLabels[0]).not.toBe(REQUIRED[0]); // humanised
  });
});

describe('snapshotNoteLine', () => {
  const base = {
    id: 'evt-1', category: FEX, checklistVersion: checklistVersion(FEX),
    checklistResults: allPass(), serviceActions: ['annual'], notes: null,
    performedAt: new Date('2026-08-31T14:00:00Z'), correctedAt: null,
    performedBy: { name: 'Dana' }, correctedBy: null,
  };

  // The 500 cap is ServicePRO's own house limit for this display string.
  // BlueLion confirmed 2026-08-31 that it has never capped `notes`.
  it('stays inside the 500-character display budget however long the inputs are', () => {
    const snap = buildQaSnapshot({
      event: { ...base, notes: 'x'.repeat(2000) },
      result: {
        id: 'r', outcome: 'fail', checklistOverrides: {},
        failedKeys: REQUIRED, notes: 'y'.repeat(2000),
      },
      batchSize: 12, serialNumber: 'FE-9',
      customer: null, workOrderNumber: null, capturedAt: new Date(),
    });
    expect(snapshotNoteLine(snap).length).toBeLessThanOrEqual(500);
  });

  it('leads with the outcome and the required-check tally', () => {
    const snap = buildQaSnapshot({
      event: base,
      result: { id: 'r', outcome: 'pass', checklistOverrides: {}, failedKeys: [], notes: null },
      batchSize: 1, serialNumber: 'FE-9',
      customer: null, workOrderNumber: null, capturedAt: new Date(),
    });
    const line = snapshotNoteLine(snap);
    expect(line.startsWith('Batch QA PASS')).toBe(true);
    expect(line).toContain(`${REQUIRED.length}/${REQUIRED.length}`);
  });
});
