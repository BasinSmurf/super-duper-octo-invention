import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { DispatchRentalDialog } from '@/components/DispatchRentalDialog'
import {
  Loader2,
  Truck,
  Clock,
  Filter,
  Search,
  Link2,
  Plus,
  X,
} from 'lucide-react'

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface DeploymentTicket {
  id: string
  ticketNumber: string
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  locationDisplay: string | null
  total: string | number | null
  updatedAt: string
  company: { id: string; name: string }
  assignedTech: { id: string; name: string } | null
  createdBy: { id: string; name: string } | null
  _count: { lineItems: number; attachments: number }
}

interface DeploymentSummary {
  total: number
  totalAmount: number
}

interface RentalOption {
  id: string
  agreementNumber: string
  status: string
  isManned: boolean
  _count?: { items: number }
}

const TYPE_LABELS: Record<string, string> = {
  field_service: 'Field Service',
  training: 'Training / Occ Health',
  shop_service: 'Shop Service',
  rental: 'Rental',
  direct_sale: 'Direct Sale',
}

const STATUS_LABELS: Record<string, string> = {
  dispatched: 'Dispatched',
  in_progress: 'In Progress',
  completed: 'Completed',
  supervisor_review: 'In Review',
}

// ──────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────

export function DeploymentsTab() {
  const navigate = useNavigate()

  const [tickets, setTickets] = useState<DeploymentTicket[]>([])
  const [summary, setSummary] = useState<DeploymentSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const [techFilter, setTechFilter] = useState('')
  const [customerFilter, setCustomerFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // Attach-rental modal target (the ticket needing a rental)
  const [attachTarget, setAttachTarget] = useState<DeploymentTicket | null>(null)

  // ─── Data loading ──────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (techFilter) params.set('tech', techFilter)
      if (customerFilter) params.set('companyId', customerFilter)
      const data = await api.get<{
        tickets: DeploymentTicket[]
        total: number
        summary: DeploymentSummary
      }>(`/tickets/deployments-queue?${params.toString()}`)
      if (data) {
        setTickets(data.tickets)
        setSummary(data.summary)
      }
    } catch (err) {
      console.error('Failed to load deployments queue:', err)
    }
    setLoading(false)
  }, [techFilter, customerFilter])

  useEffect(() => {
    load()
  }, [load])

  // ─── Client-side search ────────────────────────────────────

  const displayed = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return tickets
    return tickets.filter(t =>
      (t.ticketNumber || '').toLowerCase().includes(q) ||
      (t.locationDisplay || '').toLowerCase().includes(q) ||
      t.company.name.toLowerCase().includes(q) ||
      (t.assignedTech?.name || '').toLowerCase().includes(q) ||
      (t.createdBy?.name || '').toLowerCase().includes(q),
    )
  }, [tickets, searchQuery])

  const uniqueTechs = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of tickets) if (t.assignedTech) map.set(t.assignedTech.id, t.assignedTech.name)
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [tickets])

  const uniqueCustomers = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of tickets) map.set(t.company.id, t.company.name)
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [tickets])

  // ─── Render ────────────────────────────────────────────────

  return (
    <div>
      {/* Explainer */}
      <div className="mb-4 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3 flex items-start gap-3">
        <Truck className="w-5 h-5 text-sky-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-sm">
          <div className="font-medium text-sky-900">Deployments awaiting a rental</div>
          <div className="text-sky-800 mt-0.5">
            These jobs require a rental agreement before they can move to billing.
            D4 On Site Supervision and Other / General Service tickets can bill
            separately without a rental agreement.
          </div>
        </div>
      </div>

      {/* Summary */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 mb-5 max-w-md">
          <div className="bg-white rounded-lg border border-amber-200 p-3">
            <div className="flex items-center gap-2 mb-1">
              <Truck className="w-5 h-5 text-amber-600" />
              <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                Awaiting rental
              </span>
            </div>
            <div className="text-2xl font-bold text-slate-900">{summary.total}</div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                Value at risk
              </span>
            </div>
            <div className="text-2xl font-bold text-slate-900">
              ${summary.totalAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Filter className="w-4 h-4" />
          <span className="font-medium">Filters:</span>
        </div>

        <select
          value={techFilter}
          onChange={e => setTechFilter(e.target.value)}
          className="text-sm border border-slate-300 rounded-md px-2 py-1.5"
        >
          <option value="">All techs</option>
          {uniqueTechs.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        <select
          value={customerFilter}
          onChange={e => setCustomerFilter(e.target.value)}
          className="text-sm border border-slate-300 rounded-md px-2 py-1.5"
        >
          <option value="">All customers</option>
          {uniqueCustomers.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search ticket#, customer, location, tech…"
            className="text-sm border border-slate-300 rounded-md pl-8 pr-2 py-1.5 w-72"
          />
        </div>

        {(techFilter || customerFilter || searchQuery.trim()) && (
          <button
            onClick={() => { setTechFilter(''); setCustomerFilter(''); setSearchQuery('') }}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            Clear filters
          </button>
        )}

        <div className="flex-1" />
        <div className="text-xs text-slate-500">
          {displayed.length} deployment{displayed.length !== 1 ? 's' : ''} awaiting a rental
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : displayed.length === 0 ? (
        <div className="bg-white rounded-lg border border-slate-200 text-center py-16 text-slate-400">
          <Truck className="w-10 h-10 mx-auto mb-2 opacity-50" />
          {searchQuery.trim() ? (
            <>
              <p className="font-medium text-slate-600">No matches</p>
              <p className="text-sm mt-1">No deployments match “{searchQuery.trim()}”.</p>
            </>
          ) : (
            <>
              <p className="font-medium text-slate-600">All caught up!</p>
              <p className="text-sm mt-1">Every deployment has a rental attached.</p>
            </>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">Ticket</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">Tech</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">Customer</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">Location</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">Type</th>
                  <th className="px-3 py-2.5 text-left font-medium text-slate-500 text-xs uppercase tracking-wide">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium text-slate-500 text-xs uppercase tracking-wide">Waiting</th>
                  <th className="px-3 py-2.5 text-right font-medium text-slate-500 text-xs uppercase tracking-wide">Rental</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(t => (
                  <tr key={t.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => navigate(`/tickets/${t.id}`)}
                        className="font-medium text-blue-600 hover:text-blue-700 hover:underline"
                      >
                        {t.ticketNumber}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">{t.assignedTech?.name || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-700">{t.company.name}</td>
                    <td className="px-3 py-2.5 text-slate-600 text-xs max-w-[200px] truncate">
                      {t.locationDisplay || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 text-xs">
                      {TYPE_LABELS[t.ticketType] || t.ticketType}
                      {t.serviceSubtype && <span className="text-slate-400"> · {t.serviceSubtype}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 text-xs">
                      {STATUS_LABELS[t.status] || t.status}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs text-slate-500">
                      <div className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatWaitTime(t.updatedAt)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        onClick={() => setAttachTarget(t)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                        Attach rental
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Attach-rental modal */}
      {attachTarget && (
        <AttachRentalModal
          ticket={attachTarget}
          onClose={() => setAttachTarget(null)}
          onAttached={() => { setAttachTarget(null); load() }}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Attach-rental modal
// ──────────────────────────────────────────────────────────────

interface AttachRentalModalProps {
  ticket: DeploymentTicket
  onClose: () => void
  onAttached: () => void
}

function AttachRentalModal({ ticket, onClose, onAttached }: AttachRentalModalProps) {
  const [rentals, setRentals] = useState<RentalOption[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState('')
  const [attaching, setAttaching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const loadRentals = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<{ data: RentalOption[]; total: number }>(
        `/rentals?companyId=${ticket.company.id}`,
      )
      setRentals(data?.data ?? [])
    } catch {
      setRentals([])
    }
    setLoading(false)
  }, [ticket.company.id])

  useEffect(() => { loadRentals() }, [loadRentals])

  async function attach(rentalAgreementId: string) {
    setAttaching(true)
    setError(null)
    try {
      await api.post(`/tickets/${ticket.id}/attach-rental`, { rentalAgreementId })
      onAttached()
    } catch (err: any) {
      setError(err?.message || 'Failed to attach rental')
      setAttaching(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="p-5 border-b border-slate-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Attach a rental</h3>
            <p className="text-sm text-slate-500 mt-1">
              Ticket {ticket.ticketNumber} · {ticket.company.name}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md px-3 py-2">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : rentals.length === 0 ? (
            <p className="text-sm text-slate-500">
              No existing rentals for {ticket.company.name}. Create one below.
            </p>
          ) : (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Existing rental for this customer
              </label>
              <select
                value={selectedId}
                onChange={e => setSelectedId(e.target.value)}
                className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
              >
                <option value="">Select a rental…</option>
                {rentals.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.agreementNumber} · {r.status}
                    {r.isManned ? ' · manned' : ''}
                    {r._count ? ` · ${r._count.items} item${r._count.items !== 1 ? 's' : ''}` : ''}
                  </option>
                ))}
              </select>
              <button
                onClick={() => selectedId && attach(selectedId)}
                disabled={!selectedId || attaching}
                className="mt-3 w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {attaching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                Attach selected rental
              </button>
            </div>
          )}

          <div className="relative">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-200" /></div>
            <div className="relative flex justify-center text-xs"><span className="bg-white px-2 text-slate-400">or</span></div>
          </div>

          <button
            onClick={() => setShowCreate(true)}
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            <Plus className="w-4 h-4" />
            Create a new rental for this customer
          </button>
        </div>
      </div>

      {showCreate && (
        <DispatchRentalDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onCreated={rentalId => { setShowCreate(false); attach(rentalId) }}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function formatWaitTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}
