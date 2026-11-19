/** Use the billed service window, including for invoices created before this rule. */
export function invoiceServiceEndDate(
  invoice: { periodEnd: Date | null; invoiceDate: Date },
  tickets: Array<{ serviceDate: Date }> = [],
): Date {
  if (invoice.periodEnd) return invoice.periodEnd;
  const dates = tickets.map(ticket => ticket.serviceDate).filter(date => Number.isFinite(+date));
  return dates.length ? new Date(Math.max(...dates.map(Number))) : invoice.invoiceDate;
}
