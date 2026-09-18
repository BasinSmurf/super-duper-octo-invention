import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Download, FileText, Search } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatCalendarDate } from '@/lib/dates'
import { customerStatus, statusBadgeClass, titleCase } from './portalUtils'

interface PortalTicket {
  id: string
  ticketNumber: string
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  serviceDateTo: string | null
  locationDisplay: string | null
  poNumber: string | null
  afeNumber: string | null
  field: { name: string } | null
  pad: { name: string } | null
  well: { wellName: string } | null
  assignedTech: { name: string } | null
  _count: {
    lineItems: number
    ihTestRecords: number
    gasDetectionRecords: number
    airSystemInspections: number
  }
}

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'field_service', label: 'Field Service' },
  { value: 'inspection', label: 'Inspection / Testing' },
  { value: 'rental', label: 'Rental' },
  { value: 'repair', label: 'Repair' },
  { value: 'training', label: 'Training' },
  { value: 'sale', label: 'Sale' },
]

const PAGE_SIZE = 100
const inputClass = 'px-3 py-2 border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm bg-white'

function ticketLocation(t: PortalTicket): string {
  if (t.locationDisplay) return t.locationDisplay
  const parts = [t.field?.name, t.pad?.name, t.well?.wellName].filter(Boolean)
  return parts.length ? parts.join(' > ') : 'Location not specified'
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function PortalTicketsPage() {
  const [params, setParams] = useSearchParams()
  const [tickets, setTickets] = useState<PortalTicket[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState(params.get('search') ?? '')
  const [type, setType] = useState(params.get('type') ?? '')
  const [dateFrom, setDateFrom] = useState(params.get('dateFrom') ?? '')
  const [dateTo, setDateTo] = useState(params.get('dateTo') ?? '')
  const [testingOnly, setTestingOnly] = useState(params.get('testing') === '1' || params.get('testing') === 'true')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  const hasFilters = !!(search.trim() || type || dateFrom || dateTo || testingOnly)

  const filterQs = useMemo(() => {
    const p = new URLSearchParams()
    if (search.trim()) p.set('search', search.trim())
    if (type) p.set('type', type)
    if (dateFrom) p.set('dateFrom', dateFrom)
    if (dateTo) p.set('dateTo', dateTo)
    if (testingOnly) p.set('testing', 'true')
    return p.toString()
  }, [search, type, dateFrom, dateTo, testingOnly])

  useEffect(() => {
    const p = new URLSearchParams(filterQs)
    setParams(p, { replace: true })
    setPage(0)
  }, [filterQs, setParams])

  useEffect(() => {
    let ignore = false
    const handle = setTimeout(() => {
      setLoading(true)
      setError('')
      const p = new URLSearchParams(filterQs)
      p.set('limit', String(PAGE_SIZE))
      p.set('offset', String(page * PAGE_SIZE))
      api
        .get<{ data: PortalTicket[]; total: number }>(`/portal/tickets?${p.toString()}`)
        .then((res) => {
          if (ignore) return
          setTickets(res.data)
          setTotal(res.total)
        })
        .catch((err) => {
          if (!ignore) setError(err.message || 'Could not load service tickets')
        })
        .finally(() => {
          if (!ignore) setLoading(false)
        })
    }, 250)
    return () => {
      ignore = true
      clearTimeout(handle)
    }
  }, [filterQs, page])

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1
  const rangeEnd = Math.min(total, page * PAGE_SIZE + tickets.length)

  function clearFilters() {
    setSearch('')
    setType('')
    setDateFrom('')
    setDateTo('')
    setTestingOnly(false)
  }

  async function exportTestingCsv() {
    setExporting(true)
    setError('')
    try {
      const token = localStorage.getItem('sundog_token')
      const qs = new URLSearchParams(filterQs)
      qs.set('testing', 'true')
      const previewCompanyId = sessionStorage.getItem('sundog_portal_preview_company_id')
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
      if (previewCompanyId) headers['X-Portal-Preview-Company-Id'] = previewCompanyId
      const res = await fetch(`/api/portal/testing-results.csv?${qs.toString()}`, {
        headers,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Export failed' }))
        throw new ApiError(res.status, body.error || 'Export failed')
      }
      downloadBlob(await res.blob(), `servicepro-testing-results-${new Date().toISOString().slice(0, 10)}.csv`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export testing results')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-black">Service Tickets</h1>
            <p className="text-sm text-slate-600 mt-1">Search, sort by type, and export testing results for this customer account.</p>
          </div>
          <button
            type="button"
            onClick={exportTestingCsv}
            disabled={exporting}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 bg-blue-700 text-white text-sm font-bold border border-blue-700 hover:bg-blue-800 disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            {exporting ? 'Exporting…' : 'Export testing CSV'}
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[210px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ticket #, location, field, pad, well"
            className={`${inputClass} w-full pl-9`}
          />
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          From
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          To
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} />
        </label>
        <label className="inline-flex items-center gap-2 px-3 py-2 border border-slate-300 text-sm font-semibold text-slate-700 bg-white">
          <input type="checkbox" checked={testingOnly} onChange={(e) => setTestingOnly(e.target.checked)} />
          Testing only
        </label>
        {hasFilters && (
          <button onClick={clearFilters} className="text-sm font-semibold text-slate-600 hover:text-black px-2 py-2">Clear</button>
        )}
      </div>

      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-slate-600">
          {loading ? 'Loading…' : total === 0 ? 'No tickets' : `${rangeStart}-${rangeEnd} of ${total} ticket${total === 1 ? '' : 's'}`}
        </span>
        {!loading && total > PAGE_SIZE && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="text-sm font-semibold px-3 py-1.5 border border-slate-300 text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-sm text-slate-500">Page {page + 1} of {pageCount}</span>
            <button
              onClick={() => setPage((p) => (p + 1 < pageCount ? p + 1 : p))}
              disabled={page + 1 >= pageCount}
              className="text-sm font-semibold px-3 py-1.5 border border-slate-300 text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}

      {loading ? (
        <p className="text-slate-500 text-center py-12">Loading…</p>
      ) : tickets.length === 0 ? (
        <p className="text-slate-500 text-center py-12">{hasFilters ? 'No tickets match these filters.' : 'No service history yet.'}</p>
      ) : (
        <div className="bg-white border border-slate-200 divide-y divide-slate-100">
          {tickets.map((t) => {
            const testCount = t._count.ihTestRecords + t._count.gasDetectionRecords + t._count.airSystemInspections
            return (
              <Link key={t.id} to={`/portal/tickets/${t.id}`} className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 hover:bg-slate-50">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-black">{t.ticketNumber}</span>
                    <span className={`text-xs px-2 py-0.5 border font-semibold ${statusBadgeClass(t.status)}`}>{customerStatus(t.status)}</span>
                    <span className="text-xs px-2 py-0.5 bg-slate-100 text-slate-700 font-semibold">{titleCase(t.serviceSubtype || t.ticketType)}</span>
                    {testCount > 0 && <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 font-semibold">{testCount} test record{testCount === 1 ? '' : 's'}</span>}
                  </div>
                  <p className="text-sm text-slate-700 truncate mt-1">{ticketLocation(t)}</p>
                  <p className="text-xs text-slate-500 mt-1">
                    {t.poNumber ? `PO ${t.poNumber}` : ''}
                    {t.poNumber && t.afeNumber ? ' · ' : ''}
                    {t.afeNumber ? `AFE ${t.afeNumber}` : ''}
                    {!t.poNumber && !t.afeNumber ? 'No PO/AFE shown' : ''}
                  </p>
                </div>
                <div className="text-left lg:text-right shrink-0 flex lg:block items-center gap-3">
                  <p className="text-sm font-semibold text-slate-800">{formatCalendarDate(t.serviceDate)}</p>
                  <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                    <FileText className="w-3.5 h-3.5" />
                    View detail
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
