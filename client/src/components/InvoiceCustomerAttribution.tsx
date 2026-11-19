export function InvoiceCustomerAttribution({ customer, billedTo }: { customer: string; billedTo?: string | null }) {
  if (!billedTo) return null
  return (
    <div className="mt-2 rounded border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">
      <span className="font-semibold">Tier 1 / rebilled</span>
      <span className="block text-xs mt-0.5">Work for {customer} · QB billed to {billedTo}</span>
    </div>
  )
}
