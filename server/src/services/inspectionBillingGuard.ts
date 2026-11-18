/** Inspection tickets must not be approved with a silently missing charge. */
export function inspectionBillingError(ticket: { serviceSubtype?: string | null; customData?: unknown }, lineCount: number): string | null {
  const data = ticket.customData as { cascadeAirSubtype?: string; cascadeAirSubtypes?: string[] } | null;
  const inspection = ticket.serviceSubtype === 'cascade_air' &&
    (data?.cascadeAirSubtype === 'inspection' || data?.cascadeAirSubtypes?.includes('inspection'));
  return inspection && lineCount === 0
    ? 'Inspection line has not synced. Retry the ticket sync before approval or invoicing.' : null;
}
