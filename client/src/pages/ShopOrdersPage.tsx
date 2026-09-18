import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getActiveSiteId, onActiveSiteChange } from '@/lib/site'
import { Wrench, Plus, Search, Loader2, Ban, Package } from 'lucide-react'
import type { OfflineShopWorkOrder } from '@/lib/db-types'
import { formatCalendarDateNumeric } from '@/lib/dates'
import { ConfirmDestructiveDialog } from '@/components/ConfirmDestructiveDialog'
import { usePermissions } from '@/contexts/PermissionsContext'

type TabFilter = 'new' | 'active' | 'hold' | 'pickup' | 'done' | 'all'

const CATEGORY_LABELS: Record<string, string> = {
  fire_extinguisher: 'Fire Ext',
  area_monitor: 'Area Mon',
  personal_monitor: 'Personal Mon',
  fall_arrest: 'Fall Arrest',
  scba: 'SCBA',
  ue_cylinder: 'UE',
  other: 'Other',
}

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: 'Urgent', color: 'bg-red-100 text-red-700' },
  2: { label: 'High', color: 'bg-orange-100 text-orange-700' },
  5: { label: 'Normal', color: 'bg-slate-100 text-slate-600' },
  10: { label: 'Low', color: 'bg-slate-50 text-slate-400' },
}

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  intake: { label: 'New', color: 'bg-blue-100 text-blue-700' },
  in_progress: { label: 'Active', color: 'bg-green-100 text-green-700' },
  hold: { label: 'On Hold', color: 'bg-amber-100 text-amber-700' },
  complete: { label: 'Ready for Pickup', color: 'bg-emerald-100 text-emerald-700' },
  closed: { label: 'Done', color: 'bg-slate-100 text-slate-500' },
}

const EMPTY_MESSAGES: Record<TabFilter, string> = {
  new: 'No new work orders',
  active: 'Nothing being worked on',
  hold: 'Nothing on hold',
  pickup: 'Nothing waiting for pickup',
  done: 'No completed work orders',
  all: 'No shop work orders yet',
}

export function ShopOrdersPage() {
  const navigate = useNavigate()
  const [orders, setOrders] = useState<OfflineShopWorkOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TabFilter>('active')
  const [search, setSearch] = useState('')
  const [activeSiteId, setActiveSiteId] = useState<string | null>(getActiveSiteId())
  const { can } = usePermissions()
  const [voidTarget, setVoidTarget] = useState<OfflineShopWorkOrder | null>(null)
  const [voidBusy, setVoidBusy] = useState(false)

  async function voidOrder(reason: string) {
    if (!voidTarget) return
    setVoidBusy(true)
    try {
      await api.post(`/shop-orders/${voidTarget.id}/void`, { reason })
      setVoidTarget(null)
      await loadOrders()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to void work order')
    } finally {
      setVoidBusy(false)
    }
  }

  useEffect(() => {
    loadOrders()
    // Refetch + rescope when the working site changes in the SiteSwitcher.
    return onActiveSiteChange(id => {
      setActiveSiteId(id)
      loadOrders()
    })
  }, [])

  async function loadOrders() {
    try {
      // Dexie first
      const local = await db.shopWorkOrders.toArray()
      if (local.length > 0) {
        setOrders(local)
        setLoading(false)
      }

      // API for fresh data — scope to the working site when one is selected.
      try {
        const siteId = getActiveSiteId()
        const qs = `limit=200${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}`
        const result = await api.get<{ data: any[] }>(`/shop-orders?${qs}`)
        if (result?.data) {
          for (const wo of result.data) {
            await db.shopWorkOrders.put({
              id: wo.id,
              workOrderNumber: wo.workOrderNumber,
              status: wo.status,
              companyId: wo.companyId,
              companyName: wo.company?.name || wo.companyName || '',
              isInternal: wo.isInternal ?? false,
              poNumber: wo.poNumber || null,
              afeNumber: wo.afeNumber || null,
              intakeDate: wo.intakeDate,
              intakeNotes: wo.intakeNotes || null,
              intakeById: wo.intakeById || null,
              intakeByName: wo.intakeBy?.name || wo.intakeByName || null,
              // Basin Site + optional Pad pointers — pass through from API.
              intakeSiteId: wo.intakeSiteId ?? '',
              itemSiteIds: wo.itemSiteIds ?? [],
              bins: wo.bins ?? [],
              sourceLocationId: wo.sourceLocationId ?? null,
              returnLocationId: wo.returnLocationId ?? null,
              promisedDate: wo.promisedDate || null,
              priority: wo.priority ?? 5,
              completedDate: wo.completedDate || null,
              returnedDate: wo.returnedDate || null,
              dropOffContactName: wo.dropOffContactName || null,
              dropOffContactPhone: wo.dropOffContactPhone || null,
              dropOffContactEmail: wo.dropOffContactEmail || null,
              dropOffContactPreferred: wo.dropOffContactPreferred || null,
              pickupContactName: wo.pickupContactName || null,
              pickupContactPhone: wo.pickupContactPhone || null,
              pickupContactEmail: wo.pickupContactEmail || null,
              pickupContactPreferred: wo.pickupContactPreferred || null,
              pickupSignedByName: wo.pickupSignedByName || null,
              pickupSignature: wo.pickupSignature || null,
              pickupSignedAt: wo.pickupSignedAt || null,
              pickupNotes: wo.pickupNotes || null,
              totalItems: wo.totalItems ?? wo._count?.items ?? 0,
              completedItems: wo.completedItems ?? 0,
              primaryCategory: wo.primaryCategory || null,
              notes: wo.notes || null,
              createdAt: wo.createdAt,
              updatedAt: wo.updatedAt,
              _offlineStatus: 'synced',
            })
          }
          const refreshed = await db.shopWorkOrders.toArray()
          setOrders(refreshed)
        }
      } catch {
        // Offline
      }
    } catch {
      // Dexie error
    }
    setLoading(false)
  }

  // Scope to the working site by per-item location truth (itemSiteIds). Works
  // offline from cached data. WOs with no item-site data fall back to intakeSiteId.
  const siteScoped = useMemo(() => {
    if (!activeSiteId) return orders
    return orders.filter(o =>
      o.itemSiteIds && o.itemSiteIds.length > 0
        ? o.itemSiteIds.includes(activeSiteId)
        : o.intakeSiteId === activeSiteId,
    )
  }, [orders, activeSiteId])

  const filtered = useMemo(() => {
    let list = siteScoped

    switch (tab) {
      case 'new':
        list = list.filter(o => o.status === 'intake')
        break
      case 'active':
        list = list.filter(o => o.status === 'in_progress')
        break
      case 'hold':
        list = list.filter(o => o.status === 'hold')
        break
      case 'pickup':
        list = list.filter(o => o.status === 'complete')
        break
      case 'done':
        list = list.filter(o => o.status === 'closed')
        break
      // 'all' — no filter
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(o =>
        o.workOrderNumber?.toLowerCase().includes(q) ||
        o.companyName?.toLowerCase().includes(q) ||
        o.poNumber?.toLowerCase().includes(q)
      )
    }

    return list.sort((a, b) => {
      // Urgent first, then by date
      if (a.priority !== b.priority) return a.priority - b.priority
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
  }, [siteScoped, tab, search])

  const newCount = siteScoped.filter(o => o.status === 'intake').length
  const activeCount = siteScoped.filter(o => o.status === 'in_progress').length
  const holdCount = siteScoped.filter(o => o.status === 'hold').length
  const pickupCount = siteScoped.filter(o => o.status === 'complete').length
  const doneCount = siteScoped.filter(o => o.status === 'closed').length

  const TABS: Array<{ key: TabFilter; label: string; count: number }> = [
    { key: 'new', label: 'New', count: newCount },
    { key: 'active', label: 'Active', count: activeCount },
    { key: 'hold', label: 'Hold', count: holdCount },
    { key: 'pickup', label: 'Pickup', count: pickupCount },
    { key: 'done', label: 'Done', count: doneCount },
    { key: 'all', label: 'All', count: siteScoped.length },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Shop Service</h1>
          <p className="text-sm text-slate-500 mt-0.5">Equipment repair, testing & inspection</p>
        </div>
        <button
          onClick={() => navigate('/shop/intake')}
          className="flex items-center gap-2 px-4 py-2 bg-blue-800 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          New Intake
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by WO#, customer, or PO..."
          className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 bg-slate-100 p-1 rounded-lg mb-4 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex-1 py-2 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap px-1',
              tab === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            {t.label}
            {t.count > 0 && (
              <span className={cn(
                'ml-1 text-[10px] sm:text-xs',
                tab === t.key ? 'opacity-70' : 'opacity-50',
              )}>
                {t.count}
              </span>
            )}
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
          <Wrench className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p className="font-medium">{EMPTY_MESSAGES[tab]}</p>
          {tab !== 'done' && tab !== 'all' && (
            <p className="text-sm mt-1">Tap "New Intake" to receive equipment for service.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(o => {
            const prio = PRIORITY_LABELS[o.priority] || PRIORITY_LABELS[5]
            const catLabel = o.primaryCategory ? CATEGORY_LABELS[o.primaryCategory] || o.primaryCategory : null
            const progress = o.totalItems > 0 ? Math.round((o.completedItems / o.totalItems) * 100) : 0
            const badge = STATUS_BADGE[o.status] || { label: o.status, color: 'bg-slate-100 text-slate-600' }

            return (
              <div
                key={o.id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/shop/${o.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/shop/${o.id}`) }}
                className="w-full bg-white rounded-lg border border-slate-200 p-4 text-left hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-900">{o.workOrderNumber}</span>
                    {o.priority <= 2 && (
                      <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded-full', prio.color)}>
                        {prio.label}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'text-xs font-medium px-2 py-0.5 rounded-full',
                      badge.color,
                    )}>
                      {badge.label}
                    </span>
                    {can('shop_orders:cancel') && o.status !== 'closed' && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setVoidTarget(o) }}
                        title="Void (no work, no billing)"
                        className="text-slate-400 hover:text-red-600 p-1 rounded"
                      >
                        <Ban className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <p className="text-sm text-slate-600">
                  {o.companyName || 'Unknown'}
                  {o.isInternal && <span className="ml-1 text-xs text-blue-600 font-medium">(Internal)</span>}
                </p>

                <div className="flex items-center gap-3 text-xs text-slate-400 mt-1.5">
                  <span>{formatCalendarDateNumeric(o.intakeDate)}</span>
                  {catLabel && <span>{catLabel}</span>}
                  <span>{o.completedItems}/{o.totalItems} items</span>
                  {o.poNumber && <span>PO: {o.poNumber}</span>}
                </div>

                {/* Personal-monitor bin locations */}
                {o.bins && o.bins.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                    {o.bins.map(b => (
                      <span key={b} className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200">
                        <Package className="w-3 h-3" />
                        {b}
                      </span>
                    ))}
                  </div>
                )}

                {/* Progress bar */}
                {o.totalItems > 0 && o.status !== 'complete' && o.status !== 'closed' && (
                  <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}

                {o._offlineStatus === 'pending' && (
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
        open={!!voidTarget}
        mode="void"
        title={`Void ${voidTarget?.workOrderNumber || 'work order'}`}
        message="Closes this work order with no work done. Items are returned to inventory and NO billing ticket is generated."
        confirmLabel="Void work order"
        busy={voidBusy}
        onConfirm={({ reason }) => voidOrder(reason)}
        onClose={() => setVoidTarget(null)}
      />
    </div>
  )
}
