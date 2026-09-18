import { describe, it, expect, vi } from 'vitest';
import { evaluateItemQa, resolveQaDivert, QA_DIVERT_STATUS } from './shopQaGate.js';
import { getRequiredShopKeys } from './inspectionChecklist.js';

/**
 * A stand-in for the one Prisma model the gate reads. Hand-rolled on purpose:
 * what is under test is a decision about a set of inspection rows, so the rows
 * are the interesting input and everything else is noise.
 */
function fakePrisma(
  inspections: Array<{ data?: unknown; outcome?: string; serviceActions?: string[] }>,
  batches: Array<{
    checklistResults?: Record<string, boolean>;
    checklistOverrides?: Record<string, boolean> | null;
    serviceActions?: string[];
  }> = [],
) {
  return {
    equipmentInspection: {
      findMany: vi.fn().mockResolvedValue(
        inspections.map((i) => ({
          data: i.data ?? null,
          outcome: i.outcome ?? 'pass',
          serviceActions: i.serviceActions ?? [],
        })),
      ),
    },
    shopQaUnitResult: {
      findMany: vi.fn().mockResolvedValue(
        batches.map((b) => ({
          checklistOverrides: b.checklistOverrides ?? null,
          qaEvent: {
            checklistResults: b.checklistResults ?? {},
            serviceActions: b.serviceActions ?? [],
          },
        })),
      ),
    },
  } as never;
}

/** Every required shop key for fire_extinguisher, flat, all true. */
function completeFexKeys(): Record<string, boolean> {
  const checks: Record<string, boolean> = {};
  for (const k of getRequiredShopKeys('fire_extinguisher')) checks[k] = true;
  return checks;
}

/** Every required shop key for a category, all checked true. */
function fullChecklist(category: 'fire_extinguisher' | 'scba' | 'gas_detection') {
  const checks: Record<string, boolean> = {};
  for (const k of getRequiredShopKeys(category)) checks[k] = true;
  return { qaChecklist: checks };
}

const FEX_UNIT = { id: 'unit-1', equipmentCategory: 'fire_extinguisher', parentItemId: null };

describe('evaluateItemQa', () => {
  it('refuses a unit with no inspection at all', async () => {
    const verdict = await evaluateItemQa(fakePrisma([]), FEX_UNIT);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toMatch(/no qa inspection/i);
  });

  it('refuses a unit whose checklist is only partly filled, and names what is left', async () => {
    const partial = { qaChecklist: { fex_gauge_green: true } };
    const verdict = await evaluateItemQa(fakePrisma([{ data: partial }]), FEX_UNIT);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toMatch(/still required/i);
    // The item that WAS checked must not be listed as outstanding.
    expect(verdict.reason).not.toMatch(/Pressure gauge needle/);
    // One that wasn't, must be.
    expect(verdict.reason).toMatch(/Is it clean/i);
  });

  it('accepts a unit whose required shop checklist is complete', async () => {
    const verdict = await evaluateItemQa(
      fakePrisma([{ data: fullChecklist('fire_extinguisher') }]),
      FEX_UNIT,
    );
    expect(verdict.satisfied).toBe(true);
  });

  it('requires pass/fail and cleanliness while leaving the other questions optional', async () => {
    const checks = { fex_shell_ok: true, all_components_clean: true };
    const verdict = await evaluateItemQa(
      fakePrisma([{ data: { qaChecklist: checks } }]), FEX_UNIT,
    );
    expect(verdict.satisfied).toBe(true);
    for (const key of Object.keys(checks)) {
      const incomplete = { ...checks, [key]: false };
      const blocked = await evaluateItemQa(
        fakePrisma([{ data: { qaChecklist: incomplete } }]), FEX_UNIT,
      );
      expect(blocked.satisfied, key).toBe(false);
    }
  });

  it('accepts when ANY one inspection passes, not only the latest', async () => {
    // A tech who filed a correcting record on top of a complete one has still
    // done the QA. Requiring the newest row to be the passing one would fail a
    // unit that is demonstrably fine.
    const verdict = await evaluateItemQa(
      fakePrisma([{ data: { qaChecklist: {} } }, { data: fullChecklist('fire_extinguisher') }]),
      FEX_UNIT,
    );
    expect(verdict.satisfied).toBe(true);
  });

  it('waives condemn and cannot_service — those are not certifying readiness', async () => {
    for (const outcome of ['condemn', 'cannot_service']) {
      const verdict = await evaluateItemQa(
        fakePrisma([{ outcome, data: { qaChecklist: {} } }]),
        FEX_UNIT,
      );
      expect(verdict.satisfied, outcome).toBe(true);
    }
  });

  it('waives sub-components — they cascade with the parent assembly', async () => {
    const verdict = await evaluateItemQa(fakePrisma([]), {
      ...FEX_UNIT,
      parentItemId: 'parent-1',
    });
    expect(verdict.satisfied).toBe(true);
  });

  it('waives a category with no shop gate at all', async () => {
    const verdict = await evaluateItemQa(fakePrisma([]), {
      id: 'unit-2',
      equipmentCategory: 'other',
      parentItemId: null,
    });
    expect(verdict.satisfied).toBe(true);
  });

  it('waives units already in a terminal disposition', async () => {
    for (const status of ['condemned', 'returned']) {
      const verdict = await evaluateItemQa(fakePrisma([]), { ...FEX_UNIT, status });
      expect(verdict.satisfied, status).toBe(true);
    }
  });

  it('accepts a passing WI-06 batch on the same terms as a per-unit inspection', async () => {
    // The batch is not a lighter-weight route through the gate. Same predicate,
    // same required keys — so a batch that ticked them all releases the unit and
    // one that did not, does not.
    const complete = { qaChecklist: {} }; // no per-unit inspection worth anything
    const verdict = await evaluateItemQa(
      fakePrisma([{ data: complete }], [{ checklistResults: completeFexKeys() }]),
      FEX_UNIT,
    );
    expect(verdict.satisfied).toBe(true);
  });

  it('refuses a batch whose checklist is incomplete', async () => {
    const verdict = await evaluateItemQa(
      fakePrisma([], [{ checklistResults: { fex_gauge_green: true } }]),
      FEX_UNIT,
    );
    expect(verdict.satisfied).toBe(false);
  });

  it('lets a per-unit override complete an otherwise-incomplete batch', async () => {
    // Correcting one unit out of a batch is an override on that unit, not a
    // rewrite of the shared row — the gate has to resolve the two together.
    const keys = completeFexKeys();
    const oneShort = { ...keys };
    delete oneShort.all_components_clean;
    const verdict = await evaluateItemQa(
      fakePrisma(
        [],
        [{ checklistResults: oneShort, checklistOverrides: { all_components_clean: true } }],
      ),
      FEX_UNIT,
    );
    expect(verdict.satisfied).toBe(true);
  });

  it('drops action-gated checks when the action was not performed', async () => {
    // A UE cylinder given a visual-only pass never had a UE test done, so the
    // "UE test performed" checks do not apply and must not block the release.
    const unit = { id: 'unit-3', equipmentCategory: 'ue_cylinder', parentItemId: null };
    const alwaysOn = { qaChecklist: { ue_visual: true, all_components_clean: true } };
    const verdict = await evaluateItemQa(
      fakePrisma([{ data: alwaysOn, serviceActions: [] }]),
      unit,
    );
    expect(verdict.satisfied).toBe(true);
  });

  it('keeps the remaining questions optional even when service actions were performed', async () => {
    const unit = { id: 'unit-3', equipmentCategory: 'ue_cylinder', parentItemId: null };
    const alwaysOn = { qaChecklist: { ue_visual: true, all_components_clean: true } };
    const verdict = await evaluateItemQa(
      fakePrisma([{ data: alwaysOn, serviceActions: ['ue_test'] }]),
      unit,
    );
    expect(verdict.satisfied).toBe(true);
  });
});

describe('resolveQaDivert', () => {
  it('diverts the states that can legally reach shop_complete into the re-test lane', async () => {
    // These are exactly the states from which a release is possible, so they are
    // exactly the states the gate has to be able to intercept.
    for (const from of ['diagnosing', 'in_work']) {
      expect(resolveQaDivert(from), from).toBe(QA_DIVERT_STATUS);
    }
  });

  it('leaves a unit already in the re-test lane where it is', () => {
    expect(resolveQaDivert('qc_testing')).toBeNull();
  });

  it('holds position rather than inventing a transition the state machine forbids', () => {
    // received → shop_complete was already an illegal request. Laundering it
    // into a legal-looking qc_testing would hide a malformed payload.
    for (const from of ['received', 'awaiting_parts', 'outside_service']) {
      expect(resolveQaDivert(from), from).toBeNull();
    }
  });

  it('never diverts into a closing state — that is the whole point', () => {
    const closing = ['shop_complete', 'returned', 'condemned'];
    expect(closing).not.toContain(QA_DIVERT_STATUS);
  });
});
