const statuses: Record<string, string> = {
  drafts: 'draft',
  approved: 'approved,awaiting_signature',
  in_qb: 'queued,so_created',
  invoiced: 'invoiced,sent,paid',
}

export function invoiceListQuery(tab: string, search: string, offset = 0) {
  const params = new URLSearchParams({ limit: '200', offset: String(offset) })
  if (statuses[tab]) params.set('status', statuses[tab])
  if (search.trim()) params.set('search', search.trim())
  return `/invoices?${params}`
}
