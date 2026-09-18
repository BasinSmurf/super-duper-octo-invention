/**
 * blueLionChecklist.ts — the batch-QA snapshot, rendered into BlueLion's
 * structured checklist field.
 *
 * BlueLion accepted the Division 6 request on 2026-08-31 and built Option A: a
 * real `checklist` array on `/services`, not an opaque `metadata` blob. So the
 * QA result stops being a 500-character prose summary and becomes queryable,
 * displayable rows on the Vault record. This module is the whole of the
 * ServicePRO side of that.
 *
 * WHY THE VALIDATION LIVES HERE, AHEAD OF THE PUSH
 *
 * A Vault record is immutable. BlueLion will now reject one malformed record
 * per-batch instead of 500-ing the whole call — good — but "rejected" is not a
 * state we can recover from later: a service record that went WITHOUT its
 * checklist cannot be enriched afterwards, and a record whose checklist was
 * refused is simply a thin record forever. So the limits BlueLion published are
 * checked on this side, before anything is sent, and a snapshot that cannot be
 * represented legally FAILS ITS QUEUE ROW rather than quietly pushing a
 * degraded record. A visible stuck row is recoverable. A permanently thin
 * immutable record is not.
 *
 * The one exception is an over-long label, which is truncated rather than
 * refused — see below.
 */

import {
  SERVICE_CHECKLIST_LIMITS as LIMITS,
  type BlueLionServiceChecklistItem,
} from './blueLionClient.js';
import type { QaVaultSnapshot } from './shopBatchQa.js';

export type ChecklistMapping =
  /** Send these alongside the record. */
  | { status: 'ok'; checklist: BlueLionServiceChecklistItem[]; checklistVersion: string; truncatedLabels: number }
  /**
   * There is nothing to send, legitimately: the inspection had no batch QA, or
   * its category carries no shop checklist at all (`other` still does not —
   * see the generic-QA-gate gap). The record goes without the field, because
   * BlueLion rejects `checklist: []` rather than storing it: an empty array is
   * not a legal way to say "nothing was checked".
   */
  | { status: 'absent' }
  /** Cannot be represented legally. Do NOT push — surface it instead. */
  | { status: 'invalid'; reason: string };

/** `true` → pass, `false` → fail, `null`/absent → unanswered. */
function toResult(value: boolean | null | undefined): BlueLionServiceChecklistItem['result'] {
  if (value === true) return 'pass';
  if (value === false) return 'fail';
  return 'unanswered';
}

/**
 * Map one write-once QA snapshot onto BlueLion's checklist contract.
 *
 * Reads the snapshot ONLY. The snapshot is the denormalized, self-contained
 * record written at hard close precisely so a reader needs nothing else in
 * front of them — re-deriving any of this from the live catalog would reopen
 * the drift the snapshot exists to close.
 */
export function toBlueLionChecklist(snapshot: QaVaultSnapshot | null | undefined): ChecklistMapping {
  if (!snapshot) return { status: 'absent' };

  const checkpoints = Array.isArray(snapshot.checkpoints) ? snapshot.checkpoints : [];
  if (checkpoints.length === 0) return { status: 'absent' };

  if (checkpoints.length > LIMITS.maxCheckpoints) {
    return {
      status: 'invalid',
      reason: `${checkpoints.length} checkpoints exceeds BlueLion's limit of ${LIMITS.maxCheckpoints}`,
    };
  }

  const version = snapshot.checklistVersion;
  if (!version) {
    // checklistVersion may only be sent WITH a checklist, and a checklist with
    // no version is a record nobody can tie back to a criteria revision.
    return { status: 'invalid', reason: 'snapshot has checkpoints but no checklistVersion' };
  }
  if (version.length > LIMITS.maxVersionLength) {
    return { status: 'invalid', reason: `checklistVersion is ${version.length} chars (max ${LIMITS.maxVersionLength})` };
  }

  const seen = new Set<string>();
  const checklist: BlueLionServiceChecklistItem[] = [];
  let truncatedLabels = 0;

  for (const cp of checkpoints) {
    const key = typeof cp?.key === 'string' ? cp.key : '';
    if (!key || key.length > LIMITS.maxKeyLength || !LIMITS.keyPattern.test(key)) {
      return { status: 'invalid', reason: `checkpoint key ${JSON.stringify(key)} is not a legal BlueLion key` };
    }
    if (seen.has(key)) {
      return { status: 'invalid', reason: `checkpoint key "${key}" appears twice in one record` };
    }
    seen.add(key);

    // A label is display text, and 240 characters is already generous. Losing
    // the tail of an unusually long one is a worse record; refusing to file the
    // service at all is a worse OUTCOME. Truncate, and report the count so it
    // shows up in the log rather than only in the Vault.
    let label = typeof cp?.label === 'string' && cp.label.trim() ? cp.label.trim() : key;
    if (label.length > LIMITS.maxLabelLength) {
      label = `${label.slice(0, LIMITS.maxLabelLength - 1)}…`;
      truncatedLabels++;
    }

    checklist.push({
      key,
      label,
      // A real boolean — BlueLion rejects the string "true".
      required: cp?.required === true,
      result: toResult(cp?.result),
    });
  }

  return { status: 'ok', checklist, checklistVersion: version, truncatedLabels };
}
