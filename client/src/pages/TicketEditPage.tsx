import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/lib/api'
import { canEditTicket } from '@/lib/ticketStateMachine'

interface Customer { id: string; name: string }
interface EditableTicket {
  rejectionReason?: string | null
  id: string
  ticketNumber: string | null
  status: string
  companyId: string
  assignedTechId?: string | null
  linkedRentalAgreementId?: string | null
  customData?: { workType?: string; equipmentChanges?: { itemId: string; before?: { type?: string; serial?: string }; after?: { type?: string; serial?: string } }[]; manualEquipment?: { id: string; type: string; serial: string }[]; swaps?: { itemId: string; productName: string; outgoingSerial: string; replacementSerial: string }[] } | null
  company?: Customer | null
  serviceDate: string
  dispatchNotes: string | null
  workDescription: string | null
  internalNotes: string | null
}

// Office corrections use HTTP directly: no local drafts or offline outbox.
export function TicketEditPage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [ticket, setTicket] = useState<EditableTicket | null>(null)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Customer[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setTicket(null)
    setCustomer(null)
    setQuery('')
    setError('')
    api.get<EditableTicket>(`/tickets/${id}`).then(data => {
      if (cancelled) return
      setTicket(data)
      setCustomer(data.company ?? { id: data.companyId, name: data.companyId })
    }).catch(err => { if (!cancelled) setError(err.message || 'Could not load ticket') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])

  useEffect(() => {
    let cancelled = false
    setResults([])
    setSearchError('')
    setSearching(false)
    if (query.trim().length < 2) return
    setSearching(true)
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search: query.trim(), active: 'true', limit: '10' })
      api.get<{ data: Customer[] }>(`/companies?${params}`).then(data => {
        if (!cancelled) setResults(data.data)
      }).catch(err => { if (!cancelled) setSearchError(err.message || 'Customer search failed') })
        .finally(() => { if (!cancelled) setSearching(false) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query])

  async function save() {
    if (!ticket || !customer || saving) return
    setSaving(true)
    setError('')
    try {
      await api.put(`/tickets/${ticket.id}`, {
        companyId: customer.id,
        serviceDate: ticket.serviceDate.slice(0, 10),
        dispatchNotes: ticket.dispatchNotes,
        workDescription: ticket.workDescription,
        internalNotes: ticket.internalNotes,
      })
      navigate(`/tickets/${ticket.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save ticket')
    } finally { setSaving(false) }
  }

  const editable = !!ticket && !!user && canEditTicket(ticket.status, user.role, ticket.assignedTechId === user.id)
  const customerChanged = !!ticket && !!customer && ticket.companyId !== customer.id
  return (
    <div className="max-w-2xl mx-auto pb-12 space-y-5">
      <Link to={`/tickets/${id}`} className="text-sm text-blue-700">← Back to ticket</Link>
      {ticket?.rejectionReason && <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm"><p className="font-semibold">Returned for correction</p><p>{ticket.rejectionReason}</p></div>}
      <h1 className="text-xl font-bold text-slate-900">Edit {ticket?.ticketNumber || 'ticket'}</h1>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading ? <p>Loading ticket…</p> : ticket && !editable ? (
        <p>This ticket cannot be edited in its current status.</p>
      ) : ticket && (
        <form onSubmit={event => { event.preventDefault(); void save() }} className="space-y-5">
          <p className="text-sm text-slate-600">Update customer and job details. Saving keeps the ticket in its current status.</p>
          <fieldset disabled={saving} className="space-y-5 disabled:opacity-60">
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <p className="text-sm font-medium text-slate-700">Customer: {customer?.name}</p>
              {['draft', 'dispatched', 'in_progress'].includes(ticket.status) ? <>
                <label htmlFor="customer-search" className="block text-sm font-medium text-slate-700">Find a different customer</label>
                <input id="customer-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
                  placeholder="Search customer name" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
                {searching && <p role="status" className="text-sm text-slate-500">Searching…</p>}
                {searchError && <p role="alert" className="text-sm text-red-700">{searchError}</p>}
                {!searching && !searchError && query.trim().length >= 2 && results.length === 0 && <p className="text-sm text-slate-500">No matching customers.</p>}
                {results.length > 0 && <ul className="divide-y divide-slate-100">
                  {results.map(result => <li key={result.id}><button type="button" onClick={() => { setCustomer(result); setQuery('') }}
                    className="w-full rounded-lg p-3 text-left text-sm hover:bg-blue-50">{result.name}</button></li>)}
                </ul>}
                {customerChanged && <p className="text-sm text-amber-800">The billing profile will be selected for the new customer and the previous customer contact cleared. Existing work, locations and charges stay on the ticket.</p>}
              </> : <p className="text-sm text-slate-500">Reopen this ticket before changing its customer.</p>}
            </div>
            {ticket.linkedRentalAgreementId && <section className="rounded border bg-slate-50 p-3 text-sm space-y-2">
              <h2 className="font-semibold">Rental visit · {ticket.customData?.workType?.replace(/_/g, ' ')}</h2>
              {ticket.customData?.equipmentChanges?.map(row => <p key={row.itemId}>{row.before?.type}: {row.before?.serial}{row.after?.serial !== row.before?.serial ? ` → ${row.after?.serial}` : ''}</p>)}
              {ticket.customData?.manualEquipment?.map(row => <p key={row.id}>{row.type}: {row.serial}</p>)}
              {ticket.customData?.swaps?.map(row => <p key={row.itemId}>{row.productName}: {row.outgoingSerial} → {row.replacementSerial}</p>)}
              <Link to={`/rentals/${ticket.linkedRentalAgreementId}`} className="text-blue-700 underline">Open rental to swap or return equipment</Link>
            </section>}
            <label className="block text-sm font-medium text-slate-700">Service date
              <input type="date" required value={ticket.serviceDate.slice(0, 10)} onChange={event => setTicket({ ...ticket, serviceDate: event.target.value })}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            {(['dispatchNotes', 'workDescription', 'internalNotes'] as const).map(field => (
              <label key={field} className="block text-sm font-medium text-slate-700">
                {{ dispatchNotes: 'Dispatch notes', workDescription: 'Work description', internalNotes: 'Internal notes' }[field]}
                <textarea rows={4} maxLength={10000} value={ticket[field] ?? ''} onChange={event => setTicket({ ...ticket, [field]: event.target.value || null })}
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" />
              </label>
            ))}
            <button type="submit" disabled={!customer} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </fieldset>
        </form>
      )}
    </div>
  )
}
