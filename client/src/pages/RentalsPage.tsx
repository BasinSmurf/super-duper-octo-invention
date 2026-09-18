import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Truck, Plus, Search, Loader2, X, Ban } from 'lucide-react'
import type { OfflineRentalAgreement } from '@/lib/db-types'
import { formatCalendarDateNumeric, todayKey, daysAgoKey } from '@/lib/dates'
import { DispatchRentalDialog } from '@/components/DispatchRentalDialog'
import { DateRangePicker, type DateRange } from '@/components/DateRangePicker'
import { ConfirmDestructiveDialog } from '@/components/ConfirmDestructiveDialog'
import { usePermissions } from '@/contexts/PermissionsContext'
import { JobTypePillRow } from '@/components/JobTypePills'

type TabFilter = 'scheduled' | 'active' | 'completed' | 'all'

export function RentalsPage() {
  const navigate = useNavigate()
  const [agreements, setAgreements] = useState<OfflineRentalAgreement[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TabFilter>('active')
  const [search, setSearch] = useState('')
  const [companyFilter, setCompanyFilter] = useState<string>('')
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({})
  const [locationByAgreement, setLocationByAgreement] = useState<Record<string, string>>({})
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const { can } = usePermissions()
  const [cancelTarget, setCancelTarget] = useState<OfflineRentalAgreement | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)

  useEffect(() => {
    loadAgreements()
  }, [])

  async function cancelRental(reason: string) {
    if (!cancelTarget) return
    setCancelBusy(true)
    try {
      await api.patch(`/rentals/${cancelTarget.id}/cancel`, { reason })
      setCancelTarget(null)
      await loadAgreements()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to cancel rental')
    } finally {
      setCancelBusy(false)
    }
  }

  async function loadAgreements() {
    try {
      // Try Dexie first
      const local = await db.rentalAgreements.toArray()
      if (local.length > 0) {
        setAgreements(local)
        setLoading(false)
        // Load item counts
        await loadItemCounts(local.map(a => a.id))
      }

      // Also try API for fresh data
      try {
        const result = await api.get<{ data: OfflineRentalAgreement[] }>('/rentals?limit=200')
        if (result?.data) {
          // Merge API data into Dexie
          for (const ra of result.data) {
            await db.rentalAgreements.put({
              id: ra.id,
              agreementNumber: (ra as any).agreementNumber || null,
              companyId: ra.companyId,
              companyName: (ra as any).company?.name || ra.companyName,
              fieldId: ra.fieldId,
              padId: ra.padId,
              wellId: ra.wellId,
              wellIds: (ra as any).wellIds || [],
              status: ra.status,
              pickupType: (ra as any).pickupType || 'dispatch',
              startDate: ra.startDate,
              endDate: ra.endDate,
              billingRateType: ra.billingRateType,
              poNumber: ra.poNumber || '',
              afeNumber: ra.afeNumber || '',
              notes: ra.notes || '',
              isManned: (ra as any).isManned ?? true,
              isRigJob: (ra as any).isRigJob ?? false,
              monitorsIncluded: (ra as any).monitorsIncluded ?? false,
              composition: (ra as any).composition ?? null,
              liabilityAcknowledged: (ra as any).liabilityAcknowledged ?? false,
              liabilitySignedByName: (ra as any).liabilitySignedByName || '',
              liabilitySignature: (ra as any).liabilitySignature || null,
              liabilitySignedAt: (ra as any).liabilitySignedAt || null,
              siteContactName: (ra as any).siteContactName || '',
              siteContactPhone: (ra as any).siteContactPhone || '',
              siteContactEmail: (ra as any).siteContactEmail || '',
              createdAt: ra.createdAt,
              updatedAt: ra.updatedAt,
              _offlineStatus: 'synced',
            })
          }
          const refreshed = await db.rentalAgreements.toArray()
          setAgreements(refreshed)
          await loadItemCounts(refreshed.map(a => a.id))
        }
      } catch {
        // Offline — use local data
      }
    } catch {
      // Error loading from Dexie
    }
    setLoading(false)
  }

  async function loadItemCounts(agreementIds: string[]) {
    const counts: Record<string, number> = {}
    for (const id of agreementIds) {
      const items = await db.rentalAgreementItems
        .where('rentalAgreementId')
        .equals(id)
        .count()
      counts[id] = items
    }
    setItemCounts(counts)
  }

  // Look up field/pad names for all visible rentals and build a display label.
  useEffect(() => {
    if (agreements.length === 0) {
      setLocationByAgreement({})
      return
    }
    let cancelled = false
    ;(async () => {
      // Surface the LOCATION (pad) and the individual WELLS selected — not the
      // field. wellIds is the full multi-select; fall back to the legacy wellId.
      const wellIdsFor = (a: typeof agreements[number]) =>
        (a.wellIds && a.wellIds.length) ? a.wellIds : (a.wellId ? [a.wellId] : [])
      const padIds = Array.from(new Set(agreements.map(a => a.padId).filter((v): v is string => !!v)))
      const allWellIds = Array.from(new Set(agreements.flatMap(wellIdsFor)))
      const [pads, wells] = await Promise.all([
        padIds.length ? db.pads.where('id').anyOf(padIds).toArray() : Promise.resolve([]),
        allWellIds.length ? db.wells.where('id').anyOf(allWellIds).toArray() : Promise.resolve([]),
      ])
      const padName = new Map(pads.map(p => [p.id, p.name]))
      const wellName = new Map(wells.map(w => [w.id, w.wellName || 'Unnamed']))
      const out: Record<string, string> = {}
      for (const a of agreements) {
        const pad = a.padId ? padName.get(a.padId) : undefined
        const names = wellIdsFor(a).map(id => wellName.get(id)).filter(Boolean) as string[]
        // Keep the chip readable: list up to 3 well names, then "+N".
        const wellsLabel = names.length
          ? (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`)
          : ''
        const parts = [pad, wellsLabel].filter(Boolean)
        if (parts.length) out[a.id] = parts.join(' · ')
      }
      if (!cancelled) setLocationByAgreement(out)
    })()
    return () => { cancelled = true }
  }, [agreements])

  // Company options — distinct (id, name) pairs across all loaded agreements,
  // not just the currently-filtered list, so the dropdown stays stable as
  // other filters change.
  const companyOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const a of agreements) {
      if (a.companyId && !seen.has(a.companyId)) {
        seen.set(a.companyId, a.companyName || 'Unknown Company')
      }
    }
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [agreements])

  const filtered = useMemo(() => {
    let list = agreements

    // Tab filter
    if (tab !== 'all') {
      list = list.filter(a => a.status === tab)
    }

    // Company filter
    if (companyFilter) {
      list = list.filter(a => a.companyId === companyFilter)
    }

    // Date range filter — overlap test on [startDate, endDate || open-ended]
    if (dateRange) {
      const fromMs = new Date(dateRange.from).getTime()
      const toMs = new Date(dateRange.to).getTime() + 24 * 60 * 60 * 1000 - 1  // inclusive end-of-day
      list = list.filter(a => {
        const startMs = new Date(a.startDate).getTime()
        const endMs = a.endDate ? new Date(a.endDate).getTime() : Number.POSITIVE_INFINITY
        return startMs <= toMs && endMs >= fromMs
      })
    }

    // Search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(a =>
        (a.agreementNumber?.toLowerCase().includes(q)) ||
        (a.companyName?.toLowerCase().includes(q)) ||
        (a.poNumber?.toLowerCase().includes(q))
      )
    }

    // Sort by most recent first
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [agreements, tab, search, companyFilter, dateRange])

  const activeCount = agreements.filter(a => a.status === 'active').length
  const scheduledCount = agreements.filter(a => a.status === 'scheduled').length
  const completedCount = agreements.filter(a => a.status === 'completed').length

  const TABS: Array<{ key: TabFilter; label: string; count: number }> = [
    { key: 'scheduled', label: 'Scheduled', count: scheduledCount },
    { key: 'active', label: 'Active', count: activeCount },
    { key: 'completed', label: 'Completed', count: completedCount },
    { key: 'all', label: 'All', count: agreements.length },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Rentals</h1>
          <p className="text-sm text-slate-500 mt-0.5">Equipment out on rent</p>
        </div>
        <button
          onClick={() => setDispatchOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-800 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          New Rental
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by agreement #, company, or PO..."
          className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
      </div>

      {/* Filters: company + date range */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select
          value={companyFilter}
          onChange={e => setCompanyFilter(e.target.value)}
          className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white max-w-[14rem]"
        >
          <option value="">All companies</option>
          {companyOptions.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        {dateRange ? (
          <>
            <DateRangePicker value={dateRange} onChange={setDateRange} />
            <button
              type="button"
              onClick={() => setDateRange(null)}
              className="flex items-center gap-1 px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700"
              title="Clear date filter"
            >
              <X className="w-3.5 h-3.5" /> Clear dates
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDateRange({ from: daysAgoKey(90), to: todayKey() })
            }}
            className="px-3 py-1.5 text-xs text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Filter by date
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-lg mb-4">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex-1 py-2 text-sm font-medium rounded-md transition-colors',
              tab === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            {t.label}
            <span className="ml-1 text-xs opacity-60">
              ({t.count})
            </span>
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <Truck className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p className="font-medium">
            {tab === 'scheduled' ? 'No scheduled rentals'
             : tab === 'active' ? 'No active rentals'
             : tab === 'completed' ? 'No completed rentals'
             : 'No rental agreements yet'}
          </p>
          <p className="text-sm mt-1">
            {tab === 'scheduled'
              ? 'Dispatched rentals waiting on a Start Job ticket land here.'
              : tab === 'active'
              ? 'No equipment is currently out on rent.'
              : 'Tap "New Rental" to dispatch a rental contract.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(a => {
            const count = itemCounts[a.id] || 0
            return (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/rentals/${a.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/rentals/${a.id}`) }}
                className="w-full bg-white rounded-lg border border-slate-200 p-4 text-left hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-slate-900 flex items-center gap-2">
                    {a.companyName || 'Unknown Company'}
                    {a.pickupType === 'walk_in' && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                        Walk-in
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'text-xs font-medium px-2 py-0.5 rounded-full',
                      a.status === 'active' ? 'bg-green-100 text-green-700' :
                      a.status === 'completed' ? 'bg-slate-100 text-slate-600' :
                      'bg-red-100 text-red-700',
                    )}>
                      {a.status}
                    </span>
                    {can('rentals:cancel') && (a.status === 'active' || a.status === 'scheduled') && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setCancelTarget(a) }}
                        title="Cancel (not-done)"
                        className="text-slate-400 hover:text-red-600 p-1 rounded"
                      >
                        <Ban className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                {locationByAgreement[a.id] && (
                  <p className="text-sm text-slate-600">{locationByAgreement[a.id]}</p>
                )}
                <JobTypePillRow agreement={a} className="mt-1.5" />
                <div className="flex items-center gap-3 text-xs text-slate-400 mt-1.5">
                  <span className="font-mono">{a.agreementNumber || 'Pending...'}</span>
                  <span>{formatCalendarDateNumeric(a.startDate)}</span>
                  <span className="capitalize">{a.billingRateType}</span>
                  {count > 0 && <span>{count} item{count !== 1 ? 's' : ''}</span>}
                  {a.poNumber && <span>PO: {a.poNumber}</span>}
                </div>
                {a._offlineStatus === 'pending' && (
                  <span className="inline-block mt-2 text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                    Pending sync
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDestructiveDialog
        open={!!cancelTarget}
        mode="void"
        title={`Cancel rental ${cancelTarget?.agreementNumber || ''}`}
        message="Closes this rental as not-done. Deployed items are returned to inventory and the agreement is kept as a cancelled record (non-billable)."
        confirmLabel="Cancel rental"
        busy={cancelBusy}
        onConfirm={({ reason }) => cancelRental(reason)}
        onClose={() => setCancelTarget(null)}
      />

      <DispatchRentalDialog
        open={dispatchOpen}
        onClose={() => setDispatchOpen(false)}
        onCreated={(id) => {
          setDispatchOpen(false)
          // Reload + jump straight to the new rental's detail page
          loadAgreements()
          navigate(`/rentals/${id}`)
        }}
      />
    </div>
  )
}
