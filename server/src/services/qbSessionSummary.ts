/** Human-readable QBWC last result. Counts queue jobs, not catalog pages. */
export interface QbSessionDetails {
  byType: Record<string, number>;
  invoicesCreated: string[];
  invoiceChecks: string[];
  invoiceCheckCount: number;
  failures: string[];
  failureCount: number;
  catalogPages: number;
  catalogItems: number;
  customerPages: number;
  customersRead: number;
  customersLinked: number;
  customersCreated: number;
}
export function newQbSessionDetails(): QbSessionDetails {
  return { byType: {}, invoicesCreated: [], invoiceChecks: [], invoiceCheckCount: 0,
    failures: [], failureCount: 0, catalogPages: 0, catalogItems: 0,
    customerPages: 0, customersRead: 0, customersLinked: 0, customersCreated: 0 };
}
const clean = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 350);
const DETAIL_LIMIT = 20;
const labels: Record<string, string> = {
  'invoice/add': 'Invoices created', 'invoice/query': 'Invoice checks',
  'customer/add': 'Customers created', 'customer/query': 'Customer lookups',
  'sales_order/add': 'Sales orders created', 'sales_receipt/add': 'Sales receipts created',
  'item/query': 'Item catalog syncs', 'sales_tax/query': 'Sales tax syncs',
  'price_level/query': 'Price level syncs', 'customer_list/query': 'Customer list syncs',
};
export function recordQbSessionOutcome(
  details: QbSessionDetails,
  entry: { entityType: string; action: string; entityId: string },
  status: string,
  reference?: string | null,
  error?: string | null,
  invoiceCheck?: string,
): void {
  const key = `${entry.entityType}/${entry.action}`;
  const label = labels[key] || key;
  if (status === 'success') {
    details.byType[label] = (details.byType[label] || 0) + 1;
    if (key === 'invoice/add' && details.invoicesCreated.length < DETAIL_LIMIT) {
      details.invoicesCreated.push(clean(reference || entry.entityId));
    }
    if (key === 'invoice/query') {
      details.invoiceCheckCount++;
      if (details.invoiceChecks.length < DETAIL_LIMIT) {
        details.invoiceChecks.push(clean(invoiceCheck || `${reference || entry.entityId}: query completed`));
      }
    }
  } else if (status === 'error' || status === 'pending') {
    details.failureCount++;
    if (details.failures.length < DETAIL_LIMIT) {
      details.failures.push(clean(`${label} (${reference || entry.entityId}): ${error || 'Request failed'}${status === 'pending' ? ' [queued for retry]' : ''}`));
    }
  }
}
export function formatQbSessionSummary(session?: {
  processedItems: number; successfulItems: number; failedItems: number; invoiceAdds: number;
  createdAt: Date; companyFile?: string; details: QbSessionDetails;
}, now = new Date()): string {
  if (!session) return 'Session expired or unknown; no session results are available.';
  const { details } = session;
  const lines = [
    `Completed ${session.processedItems} requests: ${session.invoiceAdds} invoices created, ${session.successfulItems - session.invoiceAdds} other requests succeeded, ${session.failedItems} failed/retry`,
    `Duration: ${Math.max(0, Math.round((now.getTime() - session.createdAt.getTime()) / 1000))} seconds`,
    `QB company file: ${session.companyFile ? clean(session.companyFile) : 'not reported by Web Connector'}`,
  ];
  if (Object.keys(details.byType).length) {
    lines.push('Successful requests:');
    for (const [label, count] of Object.entries(details.byType)) {
      const catalog = label === 'Item catalog syncs' ? ` (${details.catalogPages} page${details.catalogPages === 1 ? '' : 's'}, ${details.catalogItems} item${details.catalogItems === 1 ? '' : 's'} read)` : '';
      const customers = label === 'Customer list syncs' ? ` (${details.customerPages} page${details.customerPages === 1 ? '' : 's'}, ${details.customersRead} customer${details.customersRead === 1 ? '' : 's'} read, ${details.customersLinked} newly linked, ${details.customersCreated} created)` : '';
      lines.push(`  ${label}: ${count}${catalog}${customers}`);
    }
  }
  if (details.invoicesCreated.length) {
    lines.push(`QB invoice numbers created: ${details.invoicesCreated.join(', ')}${session.invoiceAdds > details.invoicesCreated.length ? `; showing ${details.invoicesCreated.length} of ${session.invoiceAdds}` : ''}`);
  }
  if (details.invoiceChecks.length) {
    lines.push(`Invoice check results${details.invoiceCheckCount > details.invoiceChecks.length ? ` (showing ${details.invoiceChecks.length} of ${details.invoiceCheckCount})` : ''}:`, ...details.invoiceChecks.map(s => `  ${s}`));
  }
  if (details.failures.length) {
    lines.push(`Failures/retries${details.failureCount > details.failures.length ? ` (showing ${details.failures.length} of ${details.failureCount})` : ''}:`, ...details.failures.map(s => `  ${s}`));
  }
  if (!session.processedItems) lines.push('No queued work was processed.');
  return lines.join('\n');
}
