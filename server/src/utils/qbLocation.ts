/**
 * QB invoice LOCATION field.
 *
 * The Basin invoice template renames qbXML's header <Other> field to LOCATION,
 * so that's where the service site has to land. <Other> is a STRTYPE capped at
 * 29 characters by QB — anything longer makes QB reject the doc, so every label
 * this module returns is truncated.
 *
 * Note this is NOT ServiceTicket.locationDisplay: that's the full breadcrumb
 * ("Chord Energy LLC > Pronghorn Federal > Pronghorn 44-11PH"), which blows the
 * 29-char cap and repeats the customer already in BILL TO. AR wants the most
 * specific site name on its own — the well if we have one, else the pad.
 */

/** QB's <Other> field length cap. */
export const QB_OTHER_MAX_LEN = 29;

export function truncateQbOther(val: string | null | undefined): string | null {
  const trimmed = (val || '').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, QB_OTHER_MAX_LEN);
}

export interface QbLocationSource {
  well?: { wellName?: string | null } | null;
  pad?: { name?: string | null } | null;
  facility?: { name?: string | null } | null;
  field?: { name?: string | null } | null;
  locationDisplay?: string | null;
}

/**
 * Most specific site name for the QB LOCATION field: well → pad → facility →
 * field, falling back to the last segment of the locationDisplay breadcrumb
 * (which is all that survives for shop/air-fill tickets with no location FKs).
 */
export function qbLocationLabel(src: QbLocationSource | null | undefined): string | null {
  if (!src) return null;
  const breadcrumbTail = src.locationDisplay
    ? src.locationDisplay.split('>').map(s => s.trim()).filter(Boolean).pop() || null
    : null;

  return truncateQbOther(
    src.well?.wellName
      || src.pad?.name
      || src.facility?.name
      || src.field?.name
      || breadcrumbTail,
  );
}
