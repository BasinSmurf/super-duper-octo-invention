// A lost acknowledgement may be retried after approval/invoicing. Acknowledge
// only an exact no-op; any changed value must still use the correction workflow.
export function isTrainingRosterReplay(existing: Record<string, any>, payload: Record<string, any>): boolean {
  const fields = new Set('ticketId employeeName employeeId employerName employerCompanyId contactEmail contactPhone courseName passed cardIssuedOnSite cardIssuedOfficial cardNumber cardExpiryDate notes trainedAt'.split(' '));
  return Object.entries(payload).every(([key, value]) => {
    if (key === '_offlineStatus' || value === undefined) return true;
    if (!fields.has(key)) return false;
    if (key === 'trainedAt' || key === 'cardExpiryDate') {
      if (value == null || existing[key] == null) return value === existing[key];
      return new Date(value).getTime() === new Date(existing[key]).getTime();
    }
    return value === existing[key];
  });
}
