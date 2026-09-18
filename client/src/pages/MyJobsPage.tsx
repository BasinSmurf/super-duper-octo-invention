import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { api } from '@/lib/api'
import { db } from '@/lib/db'
import { cn } from '@/lib/cn'
import { useAuth } from '@/contexts/AuthContext'
import { discardDraft, pruneAbandonedWizardDrafts } from '@/lib/draftActions'
import { ListChecks, Loader2, Trash2, CloudOff } from 'lucide-react'

interface ShopItem {
  id: string
  serialNumber: string
  equipmentCategory: string
  equipmentDescription: string | null
  reportedIssue: string | null
  serviceType: string
  status: string
  workOrder: {
    id: string
    workOrderNumber: string
    priority: number
    promisedDate: string | null
    company: { name: string }
  }
  product: { name: string } | null
  site: { id: string; name: string; shortCode: string }
}

interface FieldTicket {
  id: string
  ticketNumber: string | null
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  locationDisplay: string | null
  company: { id: string; name: string } | null
  pad: { id: string; name: string } | null
  well: { id: string; wellName: string } | null
}

// Normalized row used by the Field tab (drafts + active, API + local merged).
interface FieldRow {
  id: string
  ticketNumber: string | null
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  companyName: string
  locationDisplay: string | null
  pending: boolean // local-only, not yet synced
  // Unsaved wizard draft (db.drafts) — resumes the wizard instead of opening a
  // ticket. These never reached the explicit "Save Draft", so there's no ticket
  // record yet; tapping one reopens /tickets/new?draft=<id> to keep filling it.
  wizard?: boolean
}

const SHOP_STATUS_LABEL: Record<string, string> = {
  received: 'Received',
  diagnosing: 'Diagnosing',
  awaiting_parts: 'Awaiting Parts',
  awaiting_approval: 'Awaiting Approval',
  in_work: 'In Work',
  warranty_out: 'Warranty Out',
  outside_service: 'Outside Service',
  qc_testing: 'QC Testing',
  on_hold: 'On Hold',
  shop_complete: 'Ready for Pickup',
}

const SHOP_STATUS_COLOR: Record<string, string> = {
  received: 'bg-blue-100 text-blue-700',
  diagnosing: 'bg-purple-100 text-purple-700',
  awaiting_parts: 'bg-amber-100 text-amber-700',
  awaiting_approval: 'bg-rose-100 text-rose-700',
  in_work: 'bg-green-100 text-green-700',
  warranty_out: 'bg-slate-200 text-slate-700',
  outside_service: 'bg-slate-200 text-slate-700',
  qc_testing: 'bg-emerald-100 text-emerald-700',
  on_hold: 'bg-orange-100 text-orange-700',
  shop_complete: 'bg-cyan-100 text-cyan-700',
}

const TICKET_STATUS_COLOR: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  dispatched: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-amber-100 text-amber-700',
}

type Tab = 'field' | 'shop'

export function MyJobsPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialTab: Tab = searchParams.get('tab') === 'shop' ? 'shop' : 'field'
  const [tab, setTabState] = useState<Tab>(initialTab)

  const [shopItems, setShopItems] = useState<ShopItem[]>([])
  const [fieldTickets, setFieldTickets] = useState<FieldTicket[]>([])
  const [loadingShop, setLoadingShop] = useState(true)
  const [loadingField, setLoadingField] = useState(true)

  // #5: local drafts (offline-first) — visible immediately, even before they
  // sync. Reactive via Dexie so a Save-then-return shows up without a refetch.
  const localDrafts = useLiveQuery(
    () => db.tickets.where('status').equals('draft').toArray(),
    [],
  )

  // Unsaved wizard drafts (auto-saved in-progress state). Edit-session scratch
  // is keyed `edit-<ticketId>` — skip those, the ticket itself already lists.
  // Only surface drafts where the tech actually picked a work type (an empty
  // draft from briefly opening the wizard isn't worth showing).
  const wizardDrafts = useLiveQuery(
    () => db.drafts.toArray(),
    [],
  )

  useEffect(() => {
    pruneAbandonedWizardDrafts().catch(err => {
      console.warn('[my-jobs] draft prune skipped:', err instanceof Error ? err.message : err)
    })

    api
      .get<{ data: ShopItem[] }>('/claim/my-items')
      .then(d => setShopItems(d.data))
      .catch(() => setShopItems([]))
      .finally(() => setLoadingShop(false))

    api
      .get<{ data: FieldTicket[] }>('/tickets/assigned-to-me')
      .then(d => setFieldTickets(d.data))
      .catch(() => setFieldTickets([]))
      .finally(() => setLoadingField(false))
  }, [])

  function setTab(next: Tab) {
    setTabState(next)
    const params = new URLSearchParams(searchParams)
    if (next === 'field') params.delete('tab')
    else params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  async function handleDiscard(e: React.MouseEvent, row: FieldRow) {
    e.stopPropagation()
    if (!window.confirm('Delete this draft? This cannot be undone.')) return
    if (row.wizard) {
      // Unsaved wizard draft — just drop the auto-saved state.
      await db.drafts.delete(row.id)
      return
    }
    await discardDraft(row.id)
    // API-sourced copy (if any) won't update on its own — drop it locally.
    setFieldTickets(prev => prev.filter(t => t.id !== row.id))
  }

  // Merge API tickets (which now include synced drafts) with local-only drafts.
  const apiIds = new Set(fieldTickets.map(t => t.id))
  // Local drafts live in THIS device's IndexedDB, so they belong to whoever is
  // signed in here. Match on tech id when we have both, but never hide a draft
  // just because the id is missing — a draft saved while offline can carry a
  // null assignedTechId, and `user` may be momentarily null on an offline load.
  const myLocalDrafts = (localDrafts || []).filter(
    d => !user?.id || !d.assignedTechId || d.assignedTechId === user.id,
  )
  const localOnlyDrafts = myLocalDrafts.filter(d => !apiIds.has(d.id))

  const apiRows: FieldRow[] = fieldTickets.map(t => ({
    id: t.id,
    ticketNumber: t.ticketNumber,
    ticketType: t.ticketType,
    serviceSubtype: t.serviceSubtype,
    status: t.status,
    serviceDate: t.serviceDate,
    companyName: t.company?.name || 'Unknown',
    locationDisplay: t.locationDisplay || t.pad?.name || null,
    pending: false,
  }))
  const localRows: FieldRow[] = localOnlyDrafts.map(d => ({
    id: d.id,
    ticketNumber: d.ticketNumber ?? null,
    ticketType: d.ticketType,
    serviceSubtype: d.serviceSubtype ?? null,
    status: 'draft',
    serviceDate: d.serviceDate,
    // Local Dexie tickets don't denormalize the company name; the location
    // display (set at save time) is the useful at-a-glance label here.
    companyName: d.locationDisplay || 'Unsynced draft',
    locationDisplay: d.locationDisplay ?? null,
    pending: true,
  }))

  const wizardRows: FieldRow[] = (wizardDrafts || [])
    .filter(d => !d.id.startsWith('edit-') && !!d.wizardData?.workType)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(d => {
      const w = d.wizardData
      const loc = [w.location?.field?.name, w.location?.pad?.name, ...(w.location?.wells || []).map(x => x.wellName)]
        .filter(Boolean)
        .join(' > ')
      return {
        id: d.id,
        ticketNumber: null,
        ticketType: w.workType,
        serviceSubtype: w.serviceType || null,
        status: 'draft',
        serviceDate: w.serviceDate || d.updatedAt,
        companyName: w.customer?.name || 'Unsaved draft',
        locationDisplay: loc || null,
        pending: true,
        wizard: true,
      }
    })

  const allRows = [...wizardRows, ...localRows, ...apiRows]
  const draftRows = allRows.filter(r => r.status === 'draft')
  const activeRows = allRows.filter(r => r.status !== 'draft')
  const fieldCount = allRows.length

  function renderRow(row: FieldRow) {
    const isDraft = row.status === 'draft'
    const target = row.wizard
      ? `/tickets/new?draft=${row.id}`
      : isDraft
      ? `/tickets/${row.id}/edit`
      : `/tickets/${row.id}`
    return (
      <div
        key={row.id}
        onClick={() => navigate(target)}
        className="w-full text-left bg-white rounded-lg border border-slate-200 p-4 hover:border-slate-300 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-blue-700">{row.ticketNumber || 'Draft'}</span>
          <span className="font-medium text-slate-900">{row.companyName}</span>
          <span className={cn('text-xs px-1.5 py-0.5 rounded', TICKET_STATUS_COLOR[row.status] || 'bg-slate-100 text-slate-600')}>
            {row.status.replace(/_/g, ' ')}
          </span>
          {row.wizard && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
              not submitted
            </span>
          )}
          {row.pending && !row.wizard && (
            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
              <CloudOff className="w-3 h-3" /> not synced
            </span>
          )}
          {isDraft && (
            <button
              type="button"
              onClick={e => handleDiscard(e, row)}
              className="ml-auto p-1 text-slate-300 hover:text-red-600"
              aria-label="Discard draft"
              title="Discard draft"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-500 flex-wrap mt-0.5">
          <span>{row.ticketType.replace(/_/g, ' ')}</span>
          {row.serviceSubtype && <span className="text-xs">· {row.serviceSubtype.replace(/_/g, ' ')}</span>}
          {row.locationDisplay && <span className="text-xs">· {row.locationDisplay}</span>}
          <span className="text-xs text-slate-400 ml-auto">{row.serviceDate?.slice(0, 10)}</span>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <ListChecks className="w-5 h-5 text-slate-500" />
        <h1 className="text-2xl font-bold text-slate-900">My Jobs</h1>
      </div>
      <p className="text-sm text-slate-500 mb-4">Field tickets, drafts, and shop work order items currently assigned to you.</p>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-100 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab('field')}
          className={cn(
            'px-4 py-2 rounded-md text-sm font-medium transition-colors',
            tab === 'field' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          Field Tickets
          {!loadingField && fieldCount > 0 && (
            <span className="ml-1.5 text-xs text-slate-400">({fieldCount})</span>
          )}
        </button>
        <button
          onClick={() => setTab('shop')}
          className={cn(
            'px-4 py-2 rounded-md text-sm font-medium transition-colors',
            tab === 'shop' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
          )}
        >
          Shop
          {!loadingShop && shopItems.length > 0 && (
            <span className="ml-1.5 text-xs text-slate-400">({shopItems.length})</span>
          )}
        </button>
      </div>

      {tab === 'field' ? (
        loadingField && allRows.length === 0 ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
          </div>
        ) : allRows.length === 0 ? (
          <div className="text-center py-12 text-slate-400">No field tickets or drafts assigned to you</div>
        ) : (
          <div className="space-y-5">
            {draftRows.length > 0 && (
              <div>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                  Drafts / In progress ({draftRows.length})
                </h2>
                <div className="space-y-2">{draftRows.map(renderRow)}</div>
              </div>
            )}
            {activeRows.length > 0 && (
              <div>
                {draftRows.length > 0 && (
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                    Dispatched
                  </h2>
                )}
                <div className="space-y-2">{activeRows.map(renderRow)}</div>
              </div>
            )}
          </div>
        )
      ) : loadingShop ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        </div>
      ) : shopItems.length === 0 ? (
        <div className="text-center py-12 text-slate-400">No shop items claimed by you</div>
      ) : (
        <div className="space-y-2">
          {shopItems.map(item => (
            <button
              key={item.id}
              onClick={() => navigate(`/shop/${item.workOrder.id}`)}
              className="w-full text-left bg-white rounded-lg border border-slate-200 p-4 hover:border-slate-300 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-blue-700">{item.workOrder.workOrderNumber}</span>
                    <span className="font-medium text-slate-900">{item.workOrder.company.name}</span>
                    <span className={cn('text-xs px-1.5 py-0.5 rounded', SHOP_STATUS_COLOR[item.status] || 'bg-slate-100 text-slate-600')}>
                      {SHOP_STATUS_LABEL[item.status] || item.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-slate-500 flex-wrap">
                    <span>{item.product?.name || item.equipmentDescription || item.equipmentCategory}</span>
                    {item.serialNumber && <span className="font-mono text-xs">S/N {item.serialNumber}</span>}
                    <span className="text-xs text-slate-400">{item.site.shortCode}</span>
                    {item.workOrder.promisedDate && (
                      <span className="text-xs text-slate-400">
                        due {item.workOrder.promisedDate.slice(0, 10)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
