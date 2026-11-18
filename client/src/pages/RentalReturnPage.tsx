import { v4 as uuidv4 } from 'uuid'
import { useAuth } from '@/contexts/AuthContext'
import { saveManualRentalVisit } from '@/lib/manualRentalVisit'
import { LineItemEditor, type LineItem } from '@/components/LineItemEditor'
import { useCompanyPriceLevels } from '@/lib/priceLevels'
import { loadSwapBillingLines } from '@/lib/rentalSwapBilling'
import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Package, CheckSquare, Square, RotateCcw } from 'lucide-react'
import type { ManualRentalEquipment } from '@/lib/db-types'
import { api } from '@/lib/api'
import { todayKey } from '@/lib/dates'
import { CustomerSearch } from '@/components/CustomerSearch'
import { RentalInspectionEditor, type InspectionData } from '@/components/RentalInspectionEditor'

type Customer = { id: string; name: string; companyType: string; city: string | null; state: string | null }

interface AgreementSummary {
  id: string
  agreementNumber: string | null
  padName?: string | null
  wellName?: string | null
  company?: { name: string } | null
  field?: { name: string } | null
  pad?: { name: string } | null
  well?: { wellName: string } | null
}

export function RentalReturnPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const submitting = useRef(false)
  const [saving, setSaving] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [ticketId] = useState(() => uuidv4())
  const [rental, setRental] = useState<any>(null)
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [billing, setBilling] = useState(false)
  const [billingReady, setBillingReady] = useState(false)
  const [batchItems, setBatchItems] = useState<ManualRentalEquipment[]>([])
  const [inspectionIndex, setInspectionIndex] = useState(0)
  const [itemInspections, setItemInspections] = useState<Record<string, InspectionData>>({})
  const { levels: priceLevels, loaded: pricesLoaded } = useCompanyPriceLevels(rental?.companyId)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [loadingAgreements, setLoadingAgreements] = useState(true)
  const [agreements, setAgreements] = useState<AgreementSummary[]>([])
  const [agreementId, setAgreementId] = useState<string | null>(searchParams.get('rentalId'))
  const [items, setItems] = useState<ManualRentalEquipment[]>([])
  const [loadingItems, setLoadingItems] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [batchCompletesAgreement, setBatchCompletesAgreement] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [returnDate, setReturnDate] = useState(() => searchParams.get('returnDate') || todayKey())
  const [batchReturnDate, setBatchReturnDate] = useState('')

  useEffect(() => {
    let cancelled = false
    setAgreements([])
    setAgreementId(searchParams.get('rentalId'))
    setLoadingAgreements(true)
    setError('')
    async function loadAgreements() {
      try {
        const all: AgreementSummary[] = []
        let total = Infinity
        while (all.length < total && !cancelled) {
          const params = new URLSearchParams({ status: 'active', limit: '100', offset: String(all.length) })
          if (customer?.id) params.set('companyId', customer.id)
          const res = await api.get<{ data: AgreementSummary[]; total: number }>(`/rentals?${params}`)
          all.push(...res.data)
          total = res.total
          if (!res.data.length) break
        }
        if (!cancelled) setAgreements(all)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load active rentals')
      } finally {
        if (!cancelled) setLoadingAgreements(false)
      }
    }
    void loadAgreements()
    return () => { cancelled = true }
  }, [customer?.id])

  useEffect(() => {
    let cancelled = false
    setItems([])
    setChecked(new Set())
    if (!agreementId) { setLoadingItems(false); return }
    setLoadingItems(true)
    api.get<any>(`/rentals/${agreementId}`)
      .then(data => {
        if (cancelled) return
        setRental(data)
        const deployed = (data.visitEquipment || data.composition?.manualEquipment || []).filter((row: ManualRentalEquipment) => row.status !== 'returned')
        setItems(deployed)
        setChecked(new Set())
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load deployed items') })
      .finally(() => { if (!cancelled) setLoadingItems(false) })
    return () => { cancelled = true }
  }, [agreementId])

  useEffect(() => {
    if (!rental || !pricesLoaded) return
    let cancelled = false
    setBillingReady(false)
    loadSwapBillingLines(priceLevels).then(lines => {
      if (cancelled) return
      setLineItems(lines.map(line => line.lineType === 'labor' ? { ...line, notes: 'Equipment return' } : line))
      setBillingReady(true)
    }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load billing defaults') })
    return () => { cancelled = true }
  }, [rental?.id, pricesLoaded, priceLevels])

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
    if (!returnDate || returnDate > todayKey()) {
      setError('Choose a return date on or before today.')
      return
    }
    if (targets.some(item => item.deployedAt?.slice(0, 10) > returnDate)) {
      setError('Return date cannot precede deployment of the selected gear.')
      return
    }
    setError('')
    setBatchReturnDate(returnDate)
    setBatchCompletesAgreement(finishJob || targets.length === items.length)
    setBatchItems(targets)
    setInspectionIndex(0)
    setItemInspections({})
    setBilling(true)
  }

  async function handleInspected(inspectionData: InspectionData) {
    if (!agreementId || !rental || submitting.current) return
    const current = batchItems[inspectionIndex]
    if (!current) return
    const inspections = { ...itemInspections, [current.id]: inspectionData }
    setItemInspections(inspections)
    if (inspectionIndex + 1 < batchItems.length) { setInspectionIndex(inspectionIndex + 1); return }
    submitting.current = true
    setSaving(true)
    setError('')
    try {
      await saveManualRentalVisit(rental, {
        requestId: ticketId, workType: 'rental_return', serviceDate: batchReturnDate,
        selections: batchItems.map(item => ({ itemId: item.id, expected: item, inspection: inspections[item.id] })),
        lineItems,
      }, user?.id, user?.role)
      setInspecting(false)
      setItems(prev => prev.filter(item => !batchItems.some(returned => returned.id === item.id)))
      setDone(true)
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to return equipment') }
    finally { submitting.current = false; setSaving(false) }
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
            {items.length === 0 ? 'All equipment returned — rental ready for final billing.' : `${items.length} item(s) still deployed.`}
          </p>
          <button
            onClick={() => navigate(agreementId ? `/rentals/${agreementId}` : '/rentals')}
            className="mt-4 px-4 py-2 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800"
          >
            View rental agreement
          </button>
        </div>
      ) : billing ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Billing — Labor &amp; Mileage</h2>
          <p className="text-sm text-slate-600">Enter return hours and miles. Charges bill with this job in the rental sweep.</p>
          {billingReady ? <LineItemEditor items={lineItems} onChange={setLineItems} serviceType="general" division={4} priceLevels={priceLevels} /> : <p>Loading billing defaults…</p>}
          <div className="flex justify-between">
            <button onClick={() => setBilling(false)} className="border rounded-lg px-4 py-2">Back: Equipment</button>
            <button disabled={!billingReady || lineItems.some(line => line.rate == null)} onClick={() => { setBilling(false); setInspecting(true) }} className="bg-blue-700 text-white rounded-lg px-4 py-2 disabled:opacity-50">Inspect &amp; Complete Return Ticket</button>
          </div>
        </div>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Filter by customer (optional)</label>
            <CustomerSearch value={customer} onChange={setCustomer} />
          </div>

          <label className="block text-sm font-medium text-slate-700">
            Return date <span className="text-red-500">*</span>
            <input type="date" value={returnDate} max={todayKey()} required
              onChange={e => setReturnDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <span className="block text-xs font-normal text-slate-500 mt-1">Use the day the gear was returned. Finish Job uses this date to end the rental.</span>
          </label>

          {loadingAgreements && (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" /> Looking up active rentals...
            </div>
          )}

          {!loadingAgreements && !error && agreements.length === 0 && (
            <p className="text-sm text-slate-400 italic">{customer ? 'No active rental for this customer.' : 'No active rentals found.'}</p>
          )}

          {!loadingAgreements && agreements.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-slate-700">Choose an active rental</p>
              {agreements.map(a => (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={agreementId === a.id}
                  onClick={() => {
                    if (agreementId === a.id) return
                    setItems([])
                    setChecked(new Set())
                    setLoadingItems(true)
                    setError('')
                    setAgreementId(a.id)
                  }}
                  className={`w-full text-left border-2 rounded-lg p-3 ${agreementId === a.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                >
                  <span className="block text-sm font-medium text-slate-900">{a.agreementNumber || a.id.slice(0, 8)}</span>
                  <span className="block text-xs text-slate-500 mt-1">Customer: {a.company?.name || 'Unknown'}</span>
                  <span className="block text-xs text-slate-500 mt-1">Site: {[a.field?.name, a.pad?.name || a.padName, a.well?.wellName || a.wellName].filter(Boolean).join(' › ') || 'No site specified'}</span>
                </button>
              ))}
            </div>
          )}

          {agreementId && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-slate-700">
                  Deployed equipment {selectedAgreement?.agreementNumber ? `(${selectedAgreement.agreementNumber})` : ''}
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
                        <span className="block text-sm font-medium text-slate-900">{item.type}</span>
                        <span className="block text-xs text-slate-500">{item.serial} · Test date: {item.testDate}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {items.length > 0 && !loadingItems && <button type="button" className="mt-2 text-sm text-blue-700" onClick={() => setChecked(checked.size === items.length ? new Set() : new Set(items.map(item => item.id)))}>{checked.size === items.length ? 'Clear selection' : 'Select all'}</button>}
              {items.length > 0 && !loadingItems && (
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => startReturn(false)}
                    disabled={checked.size === 0 || !returnDate || returnDate > todayKey()}
                    className="flex-1 px-4 py-2.5 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50"
                  >
                    Return {checked.size || ''} checked item{checked.size === 1 ? '' : 's'}
                  </button>
                  <button
                    onClick={() => startReturn(true)}
                    disabled={!returnDate || returnDate > todayKey()}
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

      {inspecting && (
        <RentalInspectionEditor
          key={batchItems[inspectionIndex]?.id}
          equipmentName={batchItems[inspectionIndex]?.type || 'Equipment'}
          serialNumber={batchItems[inspectionIndex]?.serial || ''}
          headerNote={`Inspect item ${inspectionIndex + 1} of ${batchItems.length}.${batchCompletesAgreement ? ' Returning all deployed rows closes the rental and makes the final bill ready.' : ''}`}
          submitLabel={inspectionIndex + 1 < batchItems.length ? 'Next equipment inspection' : 'Save return visit'}
          saving={saving}
          error={error}
          onComplete={handleInspected}
          onCancel={() => { if (!saving) { setInspecting(false); setBilling(true) } }}
        />
      )}
    </div>
  )
}
