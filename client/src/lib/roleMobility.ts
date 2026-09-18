// ADR-0005: offline capability (Dexie + sync engine) is keyed on role
// MOBILITY, not on which surface/URL a user is viewing — a field-mobile
// role gets it wherever they go; an office-only role never should, even if
// they happen to open a field-flavored page.
const FIELD_MOBILE_ROLES = new Set(['field_tech', 'field_super', 'dispatch', 'boss'])

export function isFieldMobileRole(role: string | undefined): boolean {
  return !!role && FIELD_MOBILE_ROLES.has(role)
}
