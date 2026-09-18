import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { AlertTriangle, Loader2, ArrowRight } from 'lucide-react'

interface StaleTransfer {
  id: string
  transferredAt: string
  notes: string | null
  fromSite: { name: string; shortCode: string }
  toSite: { name: string; shortCode: string }
  transferredBy: { name: string } | null
  workOrder: { id: string; workOrderNumber: string; company: { name: string } }
}

export function StaleTransfersPage() {
  const navigate = useNavigate()
  const [transfers, setTransfers] = useState<StaleTransfer[]>([])
  const [thresholdDays, setThresholdDays] = useState(3)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .get<{ thresholdDays: number; data: StaleTransfer[] }>('/shop-transfers/stale')
      .then(d => { setTransfers(d.data); setThresholdDays(d.thresholdDays) })
      .catch(() => setTransfers([]))
      .finally(() => setLoading(false))
  }, [])

  function daysInTransit(iso: string): number {
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-5 h-5 text-amber-500" />
        <h1 className="text-2xl font-bold text-slate-900">Stale Transfers</h1>
      </div>
      <p className="text-sm text-slate-500 mb-6">
        Inter-shop transfers initiated more than {thresholdDays} days ago and not yet received.
      </p>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        </div>
      ) : transfers.length === 0 ? (
        <div className="text-center py-12 text-slate-400">No stale transfers — everything's been received</div>
      ) : (
        <div className="space-y-2">
          {transfers.map(t => (
            <button
              key={t.id}
              onClick={() => navigate(`/shop/${t.workOrder.id}`)}
              className="w-full text-left bg-white rounded-lg border border-amber-200 p-4 hover:border-amber-300 transition-colors"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-blue-700">{t.workOrder.workOrderNumber}</span>
                <span className="font-medium text-slate-900">{t.workOrder.company.name}</span>
                <span className="ml-auto text-xs font-semibold text-amber-700">
                  {daysInTransit(t.transferredAt)} days in transit
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-sm text-slate-500 mt-1">
                <span className="font-mono text-xs">{t.fromSite.shortCode}</span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                <span className="font-mono text-xs">{t.toSite.shortCode}</span>
                <span className="text-xs text-slate-400">
                  · initiated {t.transferredAt.slice(0, 10)}
                  {t.transferredBy && ` by ${t.transferredBy.name}`}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
