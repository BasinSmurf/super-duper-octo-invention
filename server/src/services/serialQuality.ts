/**
 * serialQuality.ts — is this string actually a serial number, and if not, what
 * do we call the unit instead?
 *
 * BlueLion's unit ledger dedupes on kind + serial, so whatever we send becomes
 * that unit's permanent identity over there. Field-entered values like
 * "SCBA 19" or "Pelican 1550 Case" are descriptions, not serials: they identify
 * nothing physical, and a second unit described the same way collides with the
 * first (or, thanks to SerializedEquipment.serialNumber being @unique, forces
 * someone to invent "SCBA 19b" — junk with no relationship to the equipment).
 *
 * The answer is the same one already proven for fit-test student numbers: when
 * the entered value isn't usable, MINT a Sundog-owned tag from a sequence and
 * persist it, so it's stable across every later push and label reprint. The
 * human's text isn't discarded — it rides to BlueLion as the asset `label`,
 * which is what a tech reads on the shelf, while identity stays unique.
 *
 * A minted tag is only worth anything once it's physically on the unit, so
 * anything minted here needs a ZD411 label printed and applied.
 */
import { mapCategoryToAssetKind } from './blueLionClassMap.js';

export type SerialDefect =
  | 'empty'
  | 'placeholder'   // "N/A", "NONE", "UNKNOWN" — someone had to type something
  | 'has_spaces'    // "SCBA 19", "Pelican 1550 Case" — a description
  | 'too_short'     // under 4 chars can't survive a shop floor unambiguously
  | 'no_digits';    // all-alpha is a model or a category, not a serial

export type SerialVerdict =
  | { usable: true; normalized: string }
  | { usable: false; normalized: string; defect: SerialDefect };

// Everything here is something a person types when the plate is worn off or
// they're in a hurry. None of it identifies a unit.
const PLACEHOLDERS = new Set([
  'N/A', 'NA', 'NONE', 'NO SERIAL', 'NOSERIAL', 'NOSN', 'NO SN', 'UNKNOWN',
  'UNK', 'TBD', 'PENDING', 'MISSING', 'X', 'XX', 'XXX', 'XXXX', '0', '00',
  '000', '0000', '-', '--', '.', '?',
]);

/**
 * Trim, collapse internal runs of whitespace, uppercase. Normalizing at the
 * boundary is what stops "i-07639346" and "I-07639346" registering as two
 * separate units in a ledger that will never merge them again.
 */
export function normalizeSerial(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function classifySerial(raw: string | null | undefined): SerialVerdict {
  const normalized = normalizeSerial(raw ?? '');

  if (!normalized) return { usable: false, normalized, defect: 'empty' };
  if (PLACEHOLDERS.has(normalized)) return { usable: false, normalized, defect: 'placeholder' };
  if (normalized.includes(' ')) return { usable: false, normalized, defect: 'has_spaces' };
  if (normalized.length < 4) return { usable: false, normalized, defect: 'too_short' };
  if (!/[0-9]/.test(normalized)) return { usable: false, normalized, defect: 'no_digits' };

  return { usable: true, normalized };
}

// Short, unambiguous, and printable on a ZD411 label at a readable size.
const KIND_TAG: Record<string, string> = {
  fire_extinguisher: 'FEX',
  scba: 'SCBA',
  harness: 'HRN',
  gas_monitor: 'GAS',
  other: 'EQP',
};

export function kindTagForCategory(category: string): string {
  return KIND_TAG[mapCategoryToAssetKind(category)] ?? 'EQP';
}

/** Format only — the sequence read lives with the caller that owns the tx. */
export function formatAssignedSerial(category: string, seq: bigint | number): string {
  return `BSU-${kindTagForCategory(category)}-${String(seq).padStart(6, '0')}`;
}

export const ASSIGNED_SERIAL_SEQUENCE = 'equipment_assigned_serial_seq';

/** A tag we minted, as opposed to one stamped on the unit by its manufacturer. */
export function isAssignedSerial(serial: string): boolean {
  return /^BSU-[A-Z]{3,4}-\d{6}$/.test(normalizeSerial(serial));
}

export const DEFECT_EXPLANATIONS: Record<SerialDefect, string> = {
  empty: 'no serial recorded',
  placeholder: 'placeholder text, not a serial',
  has_spaces: 'contains spaces — reads as a description, not a serial',
  too_short: 'too short to identify a unit',
  no_digits: 'no digits — looks like a model or category name',
};
