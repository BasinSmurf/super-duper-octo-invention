/**
 * shopBatchQa.ts — WI-06: QA a batch in one action, then handle the exceptions.
 *
 * THE SHAPE, AND WHY IT IS SPLIT
 *
 * The spec asked for two properties of a record that normally exclude each
 * other, and it was right to: they are wanted by different consumers at
 * different times.
 *
 *   ServicePRO, while the batch is live      normalized.   One checklist row.
 *   VaultPRO, once the batch is final        denormalized. N self-contained
 *                                                          snapshots.
 *
 * WI-05 already drew the line between "live" and "final" — the 48-hour soft
 * window — so this needs no second clock. The batch is one correctable row
 * until the unit hard-closes, and the act of hard-closing is what flattens it.
 *
 * WHY THE LIVE RECORD IS NOT AN EquipmentInspection
 *
 * That was the obvious move and it does not work. `equipment_inspections` is
 * append-only on purpose: once `lockedAt` is set the server rejects updates and
 * a correction is a NEW row with `correctsId`. WI-06's acceptance criterion is
 * that correcting a batch of four is one update reflected across four units —
 * which an append-only per-unit table cannot express without writing four
 * correction rows, i.e. exactly the partial-failure mode the split exists to
 * avoid. The inspection stays the ledger spine; it is simply written at hard
 * close from the snapshot rather than at QA time.
 *
 * WHY A BATCH IS SINGLE-CATEGORY
 *
 * A checklist is category-specific. "All checks passed" against the wrong
 * category's checklist is not a weaker claim, it is a false one. The route
 * refuses a mixed selection rather than silently applying the first unit's
 * checklist to the rest.
 */

import {
  type InspectionCategory,
  checklistSnapshotFor,
  getMissingRequiredShopKeys,
  getRequiredShopKeys,
  isQaChecklistComplete,
  labelsForKeys,
  mapShopCategoryToInspection,
} from './inspectionChecklist.js';

export type QaOutcome = 'pass' | 'fail';

/** A checklist result map: { checkpointKey: boolean }. */
export type ChecklistResults = Record<string, boolean>;

export function asChecklistResults(value: unknown): ChecklistResults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: ChecklistResults = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The checklist that actually applies to one unit: the batch result, with that
 * unit's own overrides laid on top.
 *
 * READ THROUGH, NEVER COPIED. This is the whole reason a correction to the
 * event is "reflected across all four units" without touching four rows — the
 * four rows never held a copy to begin with.
 */
export function effectiveChecklist(batch: unknown, overrides: unknown): ChecklistResults {
  return { ...asChecklistResults(batch), ...asChecklistResults(overrides) };
}

/**
 * Does this unit's effective checklist satisfy the category's shop gate?
 *
 * Same predicate the per-unit inspection path uses, deliberately — a batch pass
 * and a single pass have to mean the same thing, or the batch becomes the
 * loophole.
 */
export function unitQaComplete(
  category: InspectionCategory,
  batch: unknown,
  overrides: unknown,
  serviceActions: unknown,
): boolean {
  return isQaChecklistComplete(category, effectiveChecklist(batch, overrides), serviceActions);
}

/**
 * Derive a unit's outcome from its effective checklist.
 *
 * DERIVED, NOT ASSERTED. The tech ticks boxes; whether that adds up to a pass
 * is arithmetic, and letting the client send `outcome: 'pass'` alongside a
 * checklist with a failed required check would make the two disagree — with the
 * pass winning, because it is the one billing reads.
 *
 * A category with no shop gate (e.g. `other`) has nothing to fail, so an
 * explicit fail is still honoured: `failedKeys` may be empty and the tech may
 * still be telling us the unit is bad.
 */
export function deriveOutcome(
  category: InspectionCategory,
  batch: unknown,
  overrides: unknown,
  serviceActions: unknown,
  explicitFail = false,
): { outcome: QaOutcome; failedKeys: string[] } {
  const effective = effectiveChecklist(batch, overrides);
  const required = getRequiredShopKeys(category, serviceActions);
  // A required check answered `false` is a FAILURE. A required check left
  // unanswered is INCOMPLETE — also not a pass, but not evidence of a fault,
  // so it is not reported as a failed checkpoint.
  const failedKeys = required.filter((k) => effective[k] === false);
  const complete = required.every((k) => effective[k] === true);
  if (explicitFail || !complete) {
    return { outcome: 'fail', failedKeys };
  }
  return { outcome: 'pass', failedKeys: [] };
}

/** A human-readable account of why a unit did not pass, for the UI and logs. */
export function explainIncomplete(
  category: InspectionCategory,
  batch: unknown,
  overrides: unknown,
  serviceActions: unknown,
): string {
  const missing = getMissingRequiredShopKeys(
    category,
    effectiveChecklist(batch, overrides),
    serviceActions,
  );
  if (missing.length === 0) return '';
  return labelsForKeys(category, missing).join('; ');
}

/**
 * Every top-level unit in a batch must map to the same inspection category.
 * Returns the shared category when the selection is coherent, or a message
 * naming the odd ones out when it is not.
 */
export function categoryConflict(
  units: Array<{ serialNumber: string; equipmentCategory: string }>,
): { category: InspectionCategory | null; error: string | null } {
  if (units.length === 0) return { category: null, error: 'No eligible units in the selection.' };
  const first = mapShopCategoryToInspection(units[0]!.equipmentCategory);
  const odd = units.filter((u) => mapShopCategoryToInspection(u.equipmentCategory) !== first);
  if (odd.length > 0) {
    const names = odd.slice(0, 5).map((u) => `${u.serialNumber} (${u.equipmentCategory})`);
    const more = odd.length > names.length ? ` and ${odd.length - names.length} more` : '';
    return {
      category: null,
      error:
        'A batch QA runs one checklist, so every unit has to be the same kind of equipment. '
        + `This selection is mostly ${first.replace(/_/g, ' ')}, but also includes `
        + `${names.join(', ')}${more}. QA them as separate batches.`,
    };
  }
  return { category: first, error: null };
}

// ============================================================
// THE SNAPSHOT — denormalization, at the moment the record goes final
// ============================================================

export interface QaVaultSnapshot {
  /** Schema version of this snapshot shape, not of the checklist. */
  snapshotVersion: 1;
  qaEventId: string;
  resultId: string;
  batchSize: number;
  category: InspectionCategory;
  checklistVersion: string;
  outcome: QaOutcome;
  /** Every shop checkpoint for the category, with its label, inlined. */
  checkpoints: Array<{ key: string; label: string; required: boolean; result: boolean | null }>;
  failedKeys: string[];
  failedLabels: string[];
  serviceActions: string[];
  performedBy: string | null;
  performedAt: string;
  correctedAt: string | null;
  correctedBy: string | null;
  batchNotes: string | null;
  unitNotes: string | null;
  serialNumber: string;
  customer: string | null;
  workOrderNumber: string | null;
  capturedAt: string;
}

/**
 * Flatten an event + one unit's result into a record that can be read with
 * nothing else in front of you.
 *
 * LABELS ARE INLINED, not just keys. A Vault record still readable in 2031 has
 * to say "Pressure gauge needle in operable range: pass", not
 * "fex_gauge_green: true" — the key is only meaningful against a catalog
 * revision nobody will still have.
 */
export function buildQaSnapshot(input: {
  event: {
    id: string;
    category: string;
    checklistVersion: string;
    checklistResults: unknown;
    serviceActions: unknown;
    notes: string | null;
    performedAt: Date;
    correctedAt: Date | null;
    performedBy?: { name: string | null } | null;
    correctedBy?: { name: string | null } | null;
  };
  result: {
    id: string;
    outcome: string;
    checklistOverrides: unknown;
    failedKeys: unknown;
    notes: string | null;
  };
  batchSize: number;
  serialNumber: string;
  customer: string | null;
  workOrderNumber: string | null;
  capturedAt: Date;
}): QaVaultSnapshot {
  const category = input.event.category as InspectionCategory;
  const actions = asStringArray(input.event.serviceActions);
  const effective = effectiveChecklist(
    input.event.checklistResults,
    input.result.checklistOverrides,
  );
  const failedKeys = asStringArray(input.result.failedKeys);

  return {
    snapshotVersion: 1,
    qaEventId: input.event.id,
    resultId: input.result.id,
    batchSize: input.batchSize,
    category,
    checklistVersion: input.event.checklistVersion,
    outcome: input.result.outcome as QaOutcome,
    checkpoints: checklistSnapshotFor(category, actions).map((cp) => ({
      ...cp,
      result: typeof effective[cp.key] === 'boolean' ? effective[cp.key]! : null,
    })),
    failedKeys,
    failedLabels: labelsForKeys(category, failedKeys),
    serviceActions: actions,
    performedBy: input.event.performedBy?.name ?? null,
    performedAt: input.event.performedAt.toISOString(),
    correctedAt: input.event.correctedAt?.toISOString() ?? null,
    correctedBy: input.event.correctedBy?.name ?? null,
    batchNotes: input.event.notes,
    unitNotes: input.result.notes,
    serialNumber: input.serialNumber,
    customer: input.customer,
    workOrderNumber: input.workOrderNumber,
    capturedAt: input.capturedAt.toISOString(),
  };
}

/**
 * The one-line human summary of a QA snapshot.
 *
 * SUPERSEDED AS THE VAULT MECHANISM, KEPT AS PROSE. BlueLion built the
 * structured `checklist` field on 2026-08-31, so the full checkpoint list now
 * rides to the Vault as data (see `blueLionChecklist.ts`) instead of being
 * crammed into a sentence. This line survives because it is also what
 * ServicePRO writes onto the materialized inspection's `notes` — the thing a
 * human reads on the detail page and on the printed PDF, where a 30-row table
 * would be worse than "QA PASS (9/9 required checks)".
 *
 * The 500-character cap is ServicePRO's own house limit for that display
 * string. It was never BlueLion's — they confirmed they have never capped
 * `notes` — so nothing outbound is constrained by it.
 */
export function snapshotNoteLine(snap: QaVaultSnapshot): string {
  const required = snap.checkpoints.filter((c) => c.required);
  const passed = required.filter((c) => c.result === true).length;
  const bits = [
    `Batch QA ${snap.outcome.toUpperCase()} (${passed}/${required.length} required checks)`,
    `checklist ${snap.checklistVersion}`,
    snap.batchSize > 1 ? `batch of ${snap.batchSize}` : null,
    snap.failedLabels.length ? `failed: ${snap.failedLabels.join('; ')}` : null,
    snap.correctedAt ? `corrected ${snap.correctedAt.slice(0, 10)}` : null,
    snap.unitNotes,
  ].filter(Boolean);
  return bits.join(' — ').slice(0, 500);
}

/** The status a unit returns to when it fails QA — "simply in service" (WI-01). */
export const QA_FAIL_STATUS = 'in_work' as const;
