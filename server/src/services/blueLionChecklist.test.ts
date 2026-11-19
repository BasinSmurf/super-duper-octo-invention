/**
 * The QA snapshot → BlueLion checklist mapping.
 *
 * Two kinds of claim here, and the second is the one that earns its keep:
 *
 *   1. the mapping itself — three-state results, real booleans, empty means
 *      OMIT rather than `[]`, and an illegal record fails loudly instead of
 *      being sent thin;
 *   2. that OUR OWN CATALOG still fits BlueLion's published limits. That is a
 *      regression test against a future checklist edit, not against this file:
 *      a Vault record is immutable, so the moment a 65th checkpoint or a
 *      241-character label lands in the catalog, service records start being
 *      refused — and the cheapest place to find that out is here.
 */

import { describe, it, expect } from 'vitest';
import { toBlueLionChecklist } from './blueLionChecklist.js';
import { SERVICE_CHECKLIST_LIMITS as LIMITS } from './blueLionClient.js';
import { buildQaSnapshot, type QaVaultSnapshot } from './shopBatchQa.js';
import {
  CHECKLIST_CATALOG,
  checklistVersion,
  getRequiredShopKeys,
} from './inspectionChecklist.js';

const FEX = 'fire_extinguisher' as const;

function snapshotFor(
  category: 'fire_extinguisher' | 'scba' | 'fall_arrest' | 'gas_detection' | 'ue_cylinder' | 'breathing_air_system' | 'first_aid_kit' | 'other',
  results: Record<string, boolean> = {},
  failedKeys: string[] = [],
): QaVaultSnapshot {
  return buildQaSnapshot({
    event: {
      id: 'evt-1',
      category,
      checklistVersion: checklistVersion(category),
      checklistResults: results,
      serviceActions: ['annual'],
      notes: null,
      performedAt: new Date('2026-08-31T14:00:00Z'),
      correctedAt: null,
      performedBy: { name: 'Dana' },
      correctedBy: null,
    },
    result: { id: 'r1', outcome: failedKeys.length ? 'fail' : 'pass', checklistOverrides: {}, failedKeys, notes: null },
    batchSize: 4,
    serialNumber: 'FE-9',
    customer: null,
    workOrderNumber: null,
    capturedAt: new Date('2026-08-31T14:05:00Z'),
  });
}

describe('toBlueLionChecklist — the mapping', () => {
  it('maps true/false/null onto pass/fail/unanswered', () => {
    // Exercise all three states without assuming the catalog has three required checks.
    const snap = snapshotFor(FEX, { fex_shell_ok: true, all_components_clean: false });
    const mapped = toBlueLionChecklist(snap);

    expect(mapped.status).toBe('ok');
    if (mapped.status !== 'ok') return;

    const byKey = new Map(mapped.checklist.map((c) => [c.key, c.result]));
    expect(byKey.get('fex_shell_ok')).toBe('pass');
    expect(byKey.get('all_components_clean')).toBe('fail');
    // Never ticked at all — a real outcome, not a silent 'fail'.
    expect(byKey.get('fex_pin_seal')).toBe('unanswered');
    expect(mapped.checklist.find(c => c.key === 'fex_pin_seal')?.required).toBe(false);
  });

  it('never emits a boolean where BlueLion wants a string', () => {
    const mapped = toBlueLionChecklist(snapshotFor(FEX, { [getRequiredShopKeys(FEX)[0]]: true }));
    expect(mapped.status).toBe('ok');
    if (mapped.status !== 'ok') return;

    for (const item of mapped.checklist) {
      expect(typeof item.result).toBe('string');
      expect(['pass', 'fail', 'unanswered']).toContain(item.result);
      // `required` is the mirror case: a real boolean, never the string "true".
      expect(typeof item.required).toBe('boolean');
    }
  });

  it('carries the label, not just the key — the record has to read in 2031', () => {
    const mapped = toBlueLionChecklist(snapshotFor(FEX));
    expect(mapped.status).toBe('ok');
    if (mapped.status !== 'ok') return;

    for (const item of mapped.checklist) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.label).not.toBe(item.key);
    }
  });

  it('sends the checklistVersion alongside, never on its own', () => {
    const mapped = toBlueLionChecklist(snapshotFor(FEX));
    expect(mapped.status).toBe('ok');
    if (mapped.status !== 'ok') return;
    expect(mapped.checklistVersion).toBe(checklistVersion(FEX));
  });
});

describe('toBlueLionChecklist — when there is nothing to send', () => {
  it('reports absent for an inspection with no QA at all', () => {
    expect(toBlueLionChecklist(null).status).toBe('absent');
    expect(toBlueLionChecklist(undefined).status).toBe('absent');
  });

  it('reports absent — NOT an empty array — for a category with no checklist', () => {
    // `other` still has no shop checklist (the generic QA-gate gap). BlueLion
    // REJECTS `checklist: []`, so an empty array is not a legal way to say
    // "nothing was checked": the field has to be omitted entirely.
    const snap = snapshotFor('other');
    expect(snap.checkpoints).toHaveLength(0);
    expect(toBlueLionChecklist(snap).status).toBe('absent');
  });
});

describe('toBlueLionChecklist — refusing to file a bad record', () => {
  const base = snapshotFor(FEX);

  it('rejects a key BlueLion would not accept', () => {
    const bad: QaVaultSnapshot = {
      ...base,
      checkpoints: [{ key: '_leading_underscore', label: 'Nope', required: true, result: true }],
    };
    const mapped = toBlueLionChecklist(bad);
    expect(mapped.status).toBe('invalid');
    if (mapped.status !== 'invalid') return;
    expect(mapped.reason).toContain('_leading_underscore');
  });

  it('rejects a duplicate key rather than letting one silently win', () => {
    const bad: QaVaultSnapshot = {
      ...base,
      checkpoints: [
        { key: 'dup', label: 'First', required: true, result: true },
        { key: 'dup', label: 'Second', required: false, result: false },
      ],
    };
    const mapped = toBlueLionChecklist(bad);
    expect(mapped.status).toBe('invalid');
    if (mapped.status !== 'invalid') return;
    expect(mapped.reason).toContain('twice');
  });

  it('rejects more checkpoints than BlueLion stores', () => {
    const bad: QaVaultSnapshot = {
      ...base,
      checkpoints: Array.from({ length: LIMITS.maxCheckpoints + 1 }, (_, i) => ({
        key: `k${i}`, label: `Check ${i}`, required: false, result: true,
      })),
    };
    expect(toBlueLionChecklist(bad).status).toBe('invalid');
  });

  it('rejects checkpoints with no version to tie them to', () => {
    const bad: QaVaultSnapshot = { ...base, checklistVersion: '' };
    const mapped = toBlueLionChecklist(bad);
    expect(mapped.status).toBe('invalid');
    if (mapped.status !== 'invalid') return;
    expect(mapped.reason).toContain('checklistVersion');
  });

  it('truncates an over-long label instead of refusing the whole service', () => {
    // The asymmetry is deliberate: a clipped label still says what was checked,
    // but a refused record means the service never reaches the Vault at all.
    const long: QaVaultSnapshot = {
      ...base,
      checkpoints: [{ key: 'k1', label: 'x'.repeat(400), required: true, result: true }],
    };
    const mapped = toBlueLionChecklist(long);
    expect(mapped.status).toBe('ok');
    if (mapped.status !== 'ok') return;
    expect(mapped.checklist[0].label).toHaveLength(LIMITS.maxLabelLength);
    expect(mapped.truncatedLabels).toBe(1);
  });
});

describe('the shop catalog still fits BlueLion’s limits', () => {
  const categories = Object.keys(CHECKLIST_CATALOG) as Array<keyof typeof CHECKLIST_CATALOG>;

  it.each(categories)('%s maps cleanly', (category) => {
    const mapped = toBlueLionChecklist(snapshotFor(category as never));
    // `other` has no checklist; everything else must map without a violation.
    expect(['ok', 'absent']).toContain(mapped.status);
    if (mapped.status !== 'ok') return;

    expect(mapped.checklist.length).toBeLessThanOrEqual(LIMITS.maxCheckpoints);
    expect(mapped.truncatedLabels).toBe(0);
    for (const item of mapped.checklist) {
      expect(item.key).toMatch(LIMITS.keyPattern);
      expect(item.key.length).toBeLessThanOrEqual(LIMITS.maxKeyLength);
      expect(item.label.length).toBeLessThanOrEqual(LIMITS.maxLabelLength);
    }
    expect(mapped.checklistVersion.length).toBeLessThanOrEqual(LIMITS.maxVersionLength);
  });
});
