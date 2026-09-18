// D4 → Return (ADR-0013, net-new). Return rental gear with item-level
// selection — partial OK (e.g. just the monitors today). Distinct from
// "Finish Job", which force-returns everything remaining and completes the
// agreement. Rides the same endpoints RentalDetailPage already uses
// (PATCH /:id/items/:itemId/return, PATCH /:id/complete) — this page is a
// new field-wizard entry point onto that machinery, not a new backend.

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, Package, CheckSquare, Square, RotateCcw } from 'lucide-react'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { CustomerSearch } from '@/components/CustomerSearch'
import { RentalInspectionEditor, type InspectionData } from '@/components/RentalInspectionEditor'

type Customer = { id: string; name: string; companyType: string; city: string | null; state: string | null }

interface AgreementSummary {
  id: string
  agreementNumber: string | null
  padName?: string | null
  wellName?: string | null
}

interface DeployedItem {
  id: string
  productName: string
  serialNumber: string
  serializedEquipmentId: string
}

export function RentalReturnPage() {
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [loadingAgreements, setLoadingAgreements] = useState(false)
  const [agreements, setAgreements] = useState<AgreementSummary[]>([])
  const [agreementId, setAgreementId] = useState<string | null>(null)
  const [items, setItems] = useState<DeployedItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [queue, setQueue] = useState<DeployedItem[]>([])
  // Decided once when the batch starts (Finish Job, or the tech happened to
  // check every deployed item) — NOT recomputed mid-drain, which would race
  // against the still-updating items/checked state as each item completes.
  const [batchCompletesAgreement, setBatchCompletesAgreement] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!customer) { setAgreements([]); setAgreementId(null); return }
    setLoadingAgreements(true)
    api.get<{ data: AgreementSummary[] }>(`/rentals?companyId=${customer.id}&status=active`)
      .then(res => {
        const data = res.data || []
        setAgreements(data)
        setAgreementId(data.length === 1 ? data[0].id : null)
      })
      .catch(() => setAgreements([]))
      .finally(() => setLoadingAgreements(false))
  }, [customer])

  useEffect(() => {
    if (!agreementId) { setItems([]); return }
    setLoadingItems(true)
    api.get<any>(`/rentals/${agreementId}`)
      .then(data => {
        const deployed = (data.items || [])
          .filter((i: any) => i.status === 'deployed')
          .map((i: any) => ({
            id: i.id,
            productName: i.product?.name || 'Equipment',
            serialNumber: i.serializedEquipment?.serialNumber || '?',
            serializedEquipmentId: i.serializedEquipmentId,
          }))
        setItems(deployed)
        setChecked(new Set())
      })
      .catch(() => setItems([]))
      .finally(() => setLoadingItems(false))
  }, [agreementId])

  function toggleItem(id: string) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startReturn(finishJob: boolean) {
    const targets = finishJob ? items : items.filter(i => checked.has(i.id))
    if (targets.length === 0) return
    setBatchCompletesAgreement(finishJob || targets.length === items.length)
    setQueue(targets)
  }

  async function handleInspected(item: DeployedItem, inspectionData: InspectionData) {
    if (!agreementId) return
    try {
      await db.rentalAgreementItems.update(item.id, {
        status: 'returned',
        returnedDate: new Date().toISOString(),
        _offlineStatus: 'pending',
      })
      await db.equipment.update(item.serializedEquipmentId, {
        status: 'available',
        currentRentalId: null,
        currentCustomerId: null,
      })
      const now = new Date().toISOString()
      await db.mutationQueue.add({
        table: 'rentalAgreementItems',
        action: 'update',
        entityId: item.id,
        payload: { status: 'returned', returnedDate: now },
        createdAt: now,
        status: 'pending',
        retryCount: 0,
      })
      try {
        await api.patch(`/rentals/${agreementId}/items/${item.id}/return`, { inspectionData })
      } catch {
        // Will sync later via the mutation queue
      }

      const remaining = queue.filter(i => i.id !== item.id)
      setQueue(remaining)
      setItems(prev => prev.filter(i => i.id !== item.id))

      if (remaining.length === 0) {
        if (batchCompletesAgreement) await completeAgreement()
        setDone(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to return item')
    }
  }

  async function completeAgreement() {
    if (!agreementId) return
    const now = new Date().toISOString()
    await db.rentalAgreements.update(agreementId, {
      status: 'completed',
      endDate: now,
      updatedAt: now,
      _offlineStatus: 'pending',
    })
    await db.mutationQueue.add({
      table: 'rentalAgreements',
      action: 'update',
      entityId: agreementId,
      payload: { status: 'completed', endDate: now },
      createdAt: now,
      status: 'pending',
      retryCount: 0,
    })
    try {
      await api.patch(`/rentals/${agreementId}/complete`, {})
    } catch {
      // Will sync later via the mutation queue
    }
  }

  const selectedAgreement = agreements.find(a => a.id === agreementId)

  return (
    <div className="mx-auto max-w-2xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1 -ml-1 text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
          <RotateCcw className="w-5 h-5 text-blue-700" /> Return Rental Gear
        </h1>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm">{error}</div>
      )}

      {done ? (
        <div className="bg-white rounded-xl border border-slate-200 p-6 text-center">
          <p className="text-slate-900 font-medium">Return recorded.</p>
          <p className="text-sm text-slate-500 mt-1">
            {items.length === 0 ? 'All items returned — agreement completed.' : `${items.length} item(s) still deployed.`}
          </p>
          <button
            onClick={() => navigate(agreementId ? `/rentals/${agreementId}` : '/rentals')}
            className="mt-4 px-4 py-2 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800"
          >
            View rental agreement
          </button>
        </div>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Customer</label>
            <CustomerSearch value={customer} onChange={setCustomer} />
          </div>

          {loadingAgreements && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" /> Looking up active rentals...
            </div>
          )}

          {customer && !loadingAgreements && agreements.length === 0 && (
            <p className="text-sm text-slate-400 italic">No active rental for this customer.</p>
          )}

          {agreements.length > 1 && !agreementId && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-slate-700">Which agreement?</p>
              {agreements.map(a => (
                <button
                  key={a.id}
                  onClick={() => setAgreementId(a.id)}
                  className="w-full text-left border border-slate-200 rounded-lg p-3 hover:bg-slate-50"
                >
                  <span className="text-sm font-medium text-slate-900">{[a.padName, a.wellName].filter(Boolean).join(' › ') || a.agreementNumber}</span>
                </button>
              ))}
            </div>
          )}

          {agreementId && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-slate-700">
                  Deployed items {selectedAgreement?.agreementNumber ? `(${selectedAgreement.agreementNumber})` : ''}
                </p>
              </div>

              {loadingItems ? (
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading items...
                </div>
              ) : items.length === 0 ? (
                <p className="text-sm text-slate-400 italic">Nothing deployed on this agreement.</p>
              ) : (
                <div className="space-y-1.5">
                  {items.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => toggleItem(item.id)}
                      className="w-full flex items-center gap-3 border border-slate-200 rounded-lg p-3 hover:bg-slate-50 text-left"
                    >
                      {checked.has(item.id)
                        ? <CheckSquare className="w-5 h-5 text-blue-600 shrink-0" />
                        : <Square className="w-5 h-5 text-slate-300 shrink-0" />}
                      <Package className="w-4 h-4 text-slate-400 shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-slate-900">{item.productName}</span>
                        <span className="block text-xs text-slate-500">{item.serialNumber}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {items.length > 0 && !loadingItems && (
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => startReturn(false)}
                    disabled={checked.size === 0}
                    className="flex-1 px-4 py-2.5 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50"
                  >
                    Return {checked.size || ''} checked item{checked.size === 1 ? '' : 's'}
                  </button>
                  <button
                    onClick={() => startReturn(true)}
                    className="px-4 py-2.5 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50"
                  >
                    Finish Job (return all)
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {queue.length > 0 && (
        <RentalInspectionEditor
          key={queue[0].id}
          equipmentName={queue[0].productName}
          serialNumber={queue[0].serialNumber}
          headerNote={batchCompletesAgreement ? 'Finishing job — this closes out the agreement' : undefined}
          onComplete={(data) => handleInspected(queue[0], data)}
          onCancel={() => setQueue([])}
        />
      )}
    </div>
  )
}
