import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Clock, Send, Wrench } from 'lucide-react'
import { api } from '@/lib/api'
import { formatCalendarDate } from '@/lib/dates'
import { titleCase } from './portalUtils'

interface ShopItem {
  id: string
  itemNumber: number
  serialNumber: string
  equipmentDescription: string | null
  equipmentCategory: string
  serviceType: string
  status: string
  reportedIssue: string | null
  diagnosisNotes: string | null
  quoteSentAt: string | null
  quoteApprovedAt: string | null
  quoteDeclinedAt: string | null
  workCompletedAt: string | null
}

interface ShopOrder {
  id: string
  workOrderNumber: string
  status: string
  intakeDate: string
  promisedDate: string | null
  completedDate: string | null
  returnedDate: string | null
  pickupContactName: string | null
  pickupContactPhone: string | null
  pickupContactEmail: string | null
  totalItems: number
  completedItems: number
  intakeSite: { name: string } | null
  sourceLocation: { name: string } | null
  returnLocation: { name: string } | null
  items: ShopItem[]
}

function statusClass(status: string) {
  if (status === 'awaiting_approval') return 'bg-amber-50 text-amber-800 border-amber-200'
  if (status === 'shop_complete' || status === 'returned' || status === 'closed') return 'bg-green-50 text-green-700 border-green-200'
  if (status === 'on_hold') return 'bg-red-50 text-red-700 border-red-200'
  return 'bg-slate-100 text-slate-700 border-slate-200'
}

export function PortalShopPage() {
  const [orders, setOrders] = useState<ShopOrder[]>([])
  const [status, setStatus] = useState('open')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    api.get<{ data: ShopOrder[] }>(`/portal/shop-orders?status=${status}`)
      .then((res) => setOrders(res.data))
      .catch((err) => setError(err.message || 'Could not load shop work'))
      .finally(() => setLoading(false))
  }, [status])

  const needsApproval = useMemo(
    () => orders.filter((order) => order.items.some((item) => item.status === 'awaiting_approval')),
    [orders],
  )

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-black">Shop Approvals</h1>
            <p className="text-sm text-slate-600 mt-1">Customer-visible shop work, quote approvals, and pickup readiness.</p>
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2 border border-slate-300 bg-white text-sm"
          >
            <option value="open">Open work</option>
            <option value="closed">Closed work</option>
            <option value="all">All shop work</option>
          </select>
        </div>
      </div>

      {needsApproval.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 p-4 text-amber-900 flex gap-3">
          <Send className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">{needsApproval.length} work order{needsApproval.length === 1 ? '' : 's'} awaiting approval</p>
            <p className="text-sm mt-1">The next slice can wire the internal “Send for approval” action to land directly here.</p>
          </div>
        </div>
      )}

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}
      {loading ? (
        <p className="text-slate-500 text-center py-12">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="text-slate-500 text-center py-12">No shop work is currently visible.</p>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => {
            const approvalItems = order.items.filter((item) => item.status === 'awaiting_approval')
            const completePct = order.totalItems > 0 ? Math.round((order.completedItems / order.totalItems) * 100) : 0
            return (
              <article key={order.id} className="bg-white border border-slate-200">
                <div className="p-4 border-b border-slate-200 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-extrabold text-black">{order.workOrderNumber}</h2>
                      <span className={`text-xs px-2 py-0.5 border font-semibold ${statusClass(order.status)}`}>{titleCase(order.status)}</span>
                      {approvalItems.length > 0 && <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-800 font-bold">{approvalItems.length} approval item{approvalItems.length === 1 ? '' : 's'}</span>}
                    </div>
                    <p className="text-sm text-slate-700 mt-1">
                      {order.intakeSite?.name ?? 'Shop'} / Intake {formatCalendarDate(order.intakeDate)}
                      {order.promisedDate ? ` / Promised ${formatCalendarDate(order.promisedDate)}` : ''}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      Pickup contact: {order.pickupContactName || order.pickupContactPhone || order.pickupContactEmail || 'not shown'}
                    </p>
                  </div>
                  <div className="min-w-[180px]">
                    <div className="flex justify-between text-xs text-slate-600 mb-1">
                      <span>{order.completedItems} of {order.totalItems} complete</span>
                      <span>{completePct}%</span>
                    </div>
                    <div className="h-2 bg-slate-100">
                      <div className="h-2 bg-blue-700" style={{ width: `${completePct}%` }} />
                    </div>
                  </div>
                </div>

                <div className="p-4 grid gap-3 lg:grid-cols-2">
                  {order.items.map((item) => (
                    <div key={item.id} className="border border-slate-200 p-3 bg-slate-50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-bold text-black">
                            #{item.itemNumber} {item.equipmentDescription || titleCase(item.equipmentCategory)}
                          </p>
                          <p className="text-sm text-slate-700 mt-1">Serial {item.serialNumber} / {titleCase(item.serviceType)}</p>
                        </div>
                        <span className={`text-xs px-2 py-0.5 border font-semibold whitespace-nowrap ${statusClass(item.status)}`}>{titleCase(item.status)}</span>
                      </div>
                      {item.reportedIssue && <p className="text-sm text-slate-600 mt-2">Issue: {item.reportedIssue}</p>}
                      {item.diagnosisNotes && <p className="text-sm text-slate-600 mt-2">Diagnosis: {item.diagnosisNotes}</p>}
                      <div className="flex flex-wrap gap-2 mt-3">
                        {item.quoteSentAt && <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-amber-50 text-amber-800 font-semibold"><Clock className="w-3.5 h-3.5" /> Quote sent</span>}
                        {item.quoteApprovedAt && <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-green-50 text-green-700 font-semibold"><CheckCircle2 className="w-3.5 h-3.5" /> Approved</span>}
                        {item.workCompletedAt && <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-green-50 text-green-700 font-semibold"><Wrench className="w-3.5 h-3.5" /> Work complete</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
