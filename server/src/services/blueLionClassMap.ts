/**
 * blueLionClassMap.ts
 *
 * Translates our internal training course names to BlueLion cert-type
 * `classCode`s. Per the integration spec §5, a record whose classCode isn't in
 * BlueLion's catalog is rejected — so a course with no mapping here is NOT
 * pushed; the sync surfaces it (status `needs_attention`) for a human to map.
 *
 * IMPORTANT: TrainingRosterRecord.courseName stores the wizard *label* (e.g.
 * "H2S CLEAR", "PEC SafeLand"), not a slug — see TrainingClassEditor.COURSE_TYPES.
 * So we key on the normalized label. Free-text "Other" courses never map.
 *
 * Codes here mirror BlueLion's governed catalog (H2S, CPR-FA, SAFELAND, …).
 * Verify against `GET /api/cert-types` — extend this table as the catalog grows
 * or have an admin add a code on the BlueLion side.
 */

function normalize(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Keyed by normalized course label → BlueLion classCode.
const LABEL_TO_CLASS_CODE: Record<string, string> = {
  'h2s clear': 'H2S',
  'h2s awareness (1 hr)': 'H2S',
  'pec safeland': 'SAFELAND',
  'first aid/cpr': 'CPR-FA',
  // Intentionally unmapped (no confirmed BlueLion code yet → needs_attention):
  //   "Safety Meeting", "Man Down Rescue", "FEX Safety (1 hr)",
  //   "Confined Space (4 hr)", "Defensive Driving (4 hr)",
  //   "Bloodborne Pathogens (1 hr)", "H2S Awareness + PEC Basic (1hr + 8hr)" (combo),
  //   and any free-text "Other" course.
};

/** Returns the BlueLion classCode for a course label, or null if unmapped. */
export function mapCourseToClassCode(courseName: string | null | undefined): string | null {
  if (!courseName) return null;
  return LABEL_TO_CLASS_CODE[normalize(courseName)] ?? null;
}

/**
 * Split a stored full name into first/last for BlueLion person creation.
 * "Joe Smith" → { firstName: "Joe", lastName: "Smith" }
 * "Mary Jane Watson" → { firstName: "Mary Jane", lastName: "Watson" }
 * Single token → both fields get the token (BlueLion needs a last name).
 */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1]!,
  };
}

/** Format a Date (or null) as YYYY-MM-DD, or undefined. */
export function toYmd(d: Date | null | undefined): string | undefined {
  if (!d) return undefined;
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Equipment category → BlueLion asset `kind`
// ─────────────────────────────────────────────────────────────────────────────
// BlueLion's kind enum is governed: fire_extinguisher | scba | harness |
// gas_monitor | other (spec §3.2). Off-list values are rejected per-record,
// so everything without a first-class kind maps to 'other'. Adding a kind is
// a BlueLion code change — tell them if a new one is needed.

import type { BlueLionAssetKind } from './blueLionClient.js';

const CATEGORY_TO_ASSET_KIND: Record<string, BlueLionAssetKind> = {
  fire_extinguisher: 'fire_extinguisher',
  scba: 'scba',
  fall_arrest: 'harness',
  gas_detection: 'gas_monitor',
  ue_cylinder: 'other',
  breathing_air_system: 'other',
  first_aid_kit: 'other',
  other: 'other',
};

export function mapCategoryToAssetKind(category: string): BlueLionAssetKind {
  return CATEGORY_TO_ASSET_KIND[category] ?? 'other';
}

const ACRONYMS = new Set(['scba', 'ue']);

/** "fire_extinguisher" → "Fire Extinguisher", "scba" → "SCBA" — labels/notes. */
export function humanizeSnake(s: string): string {
  return s
    .split('_')
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
