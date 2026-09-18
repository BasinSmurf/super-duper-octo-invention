/**
 * labelFields.ts — derive the human-readable text that goes on a shop label.
 *
 * The 2x2 ZD411 tag shows, per the Canva layout:
 *   customer · job # · intake date · work-type shorthand · "Unit N of M".
 * The work-type shorthand ("FEX RECHARGE") is built from the item's equipment
 * category + service type. Item-level labels carry the per-unit numbering;
 * the order-level packet/bin labels (no item) fall back to a piece count.
 *
 * The abbreviation maps below are the bit most likely to need tweaking — they
 * are the shorthand techs read off the tag all day. Edit freely.
 */

const CATEGORY_ABBR: Record<string, string> = {
  fire_extinguisher: 'FEX',
  area_monitor: 'AREA MON',
  personal_monitor: 'PERS MON',
  fall_arrest: 'FALL ARR',
  scba: 'SCBA',
  ue_cylinder: 'UE CYL',
  other: 'EQUIP',
};

const SERVICE_ABBR: Record<string, string> = {
  repair: 'REPAIR',
  recharge: 'RECHARGE',
  inspection: 'INSPECT',
  test: 'TEST',
  calibrate: 'CAL',
  bump_test: 'BUMP TEST',
  warranty_repair: 'WARR RPR',
  ue_testing: 'UE TEST',
  sensor_replace: 'SENSOR',
  general: 'SERVICE',
};

/**
 * "FEX RECHARGE" — category abbreviation + service-type abbreviation. Either
 * part may be missing (order-level labels carry only the category); unknown
 * enum values fall back to their raw upper-cased name rather than vanishing.
 */
export function workTypeShort(
  category?: string | null,
  serviceType?: string | null,
): string {
  const cat = category ? CATEGORY_ABBR[category] ?? category.toUpperCase() : '';
  const svc = serviceType ? SERVICE_ABBR[serviceType] ?? serviceType.toUpperCase() : '';
  return [cat, svc].filter(Boolean).join(' ');
}

/**
 * MM/DD/YY for the top-right corner. intakeDate is a `@db.Date`, so Prisma
 * hands back a Date pinned to UTC midnight — read it in UTC to avoid the
 * label showing yesterday in a behind-UTC timezone.
 */
export function formatLabelDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

/** "Unit 3 of 7" for a single item; the denominator never reads below N. */
export function unitLine(itemNumber: number, totalItems: number): string {
  return `Unit ${itemNumber} of ${Math.max(totalItems, itemNumber)}`;
}
