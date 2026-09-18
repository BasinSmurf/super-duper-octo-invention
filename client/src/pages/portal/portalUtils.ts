// Shared display helpers for the customer portal.

// Customers don't need the internal billing lifecycle — collapse the back-end
// statuses into the four states a customer actually cares about.
const STATUS_LABEL: Record<string, string> = {
  dispatched: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  supervisor_review: 'Completed',
  awaiting_signature: 'Completed',
  billing_queue: 'Completed',
  invoiced: 'Completed',
  closed: 'Closed',
}

const STATUS_CLASS: Record<string, string> = {
  Scheduled: 'bg-blue-50 text-blue-700 border-blue-200',
  'In Progress': 'bg-amber-50 text-amber-700 border-amber-200',
  Completed: 'bg-green-50 text-green-700 border-green-200',
  Closed: 'bg-slate-100 text-slate-600 border-slate-200',
}

export function customerStatus(status: string): string {
  return STATUS_LABEL[status] ?? 'Completed'
}

export function statusBadgeClass(status: string): string {
  return STATUS_CLASS[customerStatus(status)] ?? STATUS_CLASS.Completed
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) return '—'
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}
