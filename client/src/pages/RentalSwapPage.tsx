import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { api } from '@/lib/api'
import { todayKey } from '@/lib/dates'
import type { ManualRentalEquipment, OfflineRentalAgreement } from '@/lib/db-types'
import { saveManualRentalVisit } from '@/lib/manualRentalVisit'
import { useAuth } from '@/contexts/AuthContext'
import { formatEquipmentTestDate } from '@/lib/rentalDeploymentItems'
import { LineItemEditor, type LineItem } from '@/components/LineItemEditor'
import { useCompanyPriceLevels } from '@/lib/priceLevels'
import { loadSwapBillingLines } from '@/lib/rentalSwapBilling'
import { ArrowLeft, RotateCcw } from 'lucide-react'

interface RentalOption {
  id: string
  companyId: string
  agreementNumber: string
  company: { name: string }
  field?: { name: string } | null
  pad?: { name: string } | null
  well?: { wellName: string } | null
}
type SwapSelection = Pick<ManualRentalEquipment, 'serial' | 'type' | 'testDate'>

export function RentalSwapPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [rentals, setRentals] = useState<RentalOption[]>([])
  const [rentalId, setRentalId] = useState(searchParams.get('rentalId') || '')
  const [items, setItems] = useState<ManualRentalEquipment[]>([])
  const [rental, setRental] = useState<OfflineRentalAgreement | null>(null)
  const [selections, setSelections] = useState<Record<string, SwapSelection>>({})
  const [reason, setReason] = useState('')
  const [step, setStep] = useState<'equipment' | 'billing'>('equipment')
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [billingReady, setBillingReady] = useState(false)
  const seededRental = useRef<string | null>(null)
  const selectedRental = rentals.find(rental => rental.id === rentalId)
  const { levels: priceLevels, loaded: pricesLoaded } = useCompanyPriceLevels(selectedRental?.companyId)
  const [swapDate, setSwapDate] = useState(todayKey())
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const requestId = useRef(uuidv4())
  const submitting = useRef(false)
  const fieldClass = 'w-full rounded-lg border border-slate-300 p-2 text-sm'

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const all: RentalOption[] = []
        let total = Infinity
        while (all.length < total) {
          const result = await api.get<{ data: RentalOption[]; total: number }>(`/rentals?status=active&limit=100&offset=${all.length}`)
          all.push(...result.data)
          total = result.total
          if (!result.data.length || cancelled) break
        }
        if (!cancelled) setRentals(all)
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load rentals') }
      finally { if (!cancelled) setLoading(false) }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setItems([])
    setRental(null)
    setSelections({})
    setStep('equipment')
    setLineItems([])
    setBillingReady(false)
    seededRental.current = null
    requestId.current = uuidv4()
    if (!rentalId) return
    setLoading(true)
    api.get<OfflineRentalAgreement>(`/rentals/${rentalId}`)
      .then(result => { if (!cancelled) { setRental(result); setItems((result.visitEquipment || result.composition?.manualEquipment || []).filter(item => item.status !== 'returned')) } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load equipment') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [rentalId])

  useEffect(() => {
    if (!rentalId || !pricesLoaded || seededRental.current === rentalId) return
    let cancelled = false
    loadSwapBillingLines(priceLevels)
      .then(lines => {
        if (cancelled) return
        setLineItems(lines)
        seededRental.current = rentalId
        setBillingReady(true)
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load billing defaults') })
    return () => { cancelled = true }
  }, [rentalId, pricesLoaded, priceLevels])

  async function submit() {
    if (submitting.current || !rental || !rentalId || !billingReady || !Object.keys(selections).length) return
    if (Object.values(selections).some(row => !row.serial.trim() || !row.type.trim() || !row.testDate.trim())) { setError('Enter Serial, Type, and Test date for every replacement.'); return }
    if (lineItems.some(line => line.rate == null)) { setError('Enter a rate on each billing line (zero is allowed).'); return }
    if (!swapDate || swapDate > todayKey()) { setError('Choose a swap date on or before today.'); return }
    submitting.current = true
    setSaving(true)
    setError('')
    try {
      const ticket = await saveManualRentalVisit(rental, {
        requestId: requestId.current, workType: 'rental_swap', reason, lineItems, serviceDate: swapDate,
        selections: Object.entries(selections).map(([itemId, replacement]) => ({ itemId, replacement, expected: items.find(row => row.id === itemId) })),
      }, user?.id, user?.role)
      navigate(`/tickets/${ticket.id}`)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not swap equipment') }
    finally { setSaving(false); submitting.current = false }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <button type="button" disabled={saving} onClick={() => navigate('/tickets/start')} className="flex items-center gap-2 text-sm text-blue-700"><ArrowLeft className="h-4 w-4" /> Back to Tickets</button>
      <h1 className="flex items-center gap-2 text-xl font-semibold"><RotateCcw className="h-5 w-5" /> D4 — Swap Ticket</h1>
      <p className="text-sm text-slate-600">Select deployed rows and enter replacement Serial, Type, and Test date, then time and mileage. Rental rates and billing dates continue.</p>
      <p className="text-sm font-medium text-slate-500">{step === 'equipment' ? '1. Equipment' : '2. Billing'}</p>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <fieldset disabled={saving} className="space-y-4">
        {step === 'equipment' ? <>
        <label className="block space-y-1 text-sm font-medium">Open rental
          <select className={fieldClass} value={rentalId} onChange={e => { setRentalId(e.target.value); setError('') }}>
            <option value="">Select a rental…</option>
            {rentals.map(rental => <option key={rental.id} value={rental.id}>{rental.agreementNumber} — {rental.company.name}{[rental.field?.name, rental.pad?.name, rental.well?.wellName].filter(Boolean).map(name => ` / ${name}`).join('')}</option>)}
          </select>
        </label>
        <label className="block space-y-1 text-sm font-medium">Swap date <span className="text-red-500">*</span>
          <input type="date" value={swapDate} max={todayKey()} required onChange={e => setSwapDate(e.target.value)} className={fieldClass} />
          <span className="block text-xs font-normal text-slate-500">Use the day the equipment was swapped. This becomes the swap ticket’s service date.</span>
        </label>
        {loading && <p className="text-sm text-slate-500">Loading…</p>}
        {!loading && !rentals.length && <p className="text-sm text-slate-500">No open rentals found.</p>}
        {!loading && rentalId && !items.length && <p className="text-sm text-slate-500">This rental has no deployed equipment to swap.</p>}
        {items.map(item => {
          const selected = selections[item.id]
          return <div key={item.id} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
            <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={!!selected} onChange={e => setSelections(prev => {
              const next = { ...prev }
              if (e.target.checked) next[item.id] = { serial: '', type: item.type, testDate: '' }
              else delete next[item.id]
              return next
            })} /> {item.type} — {item.serial}</label>
            <p className="text-sm text-slate-600">Current test date: {item.testDate}</p>
            {selected && <div className="grid gap-3 sm:grid-cols-3">
              {(['serial', 'type', 'testDate'] as const).map(field => <label key={field} className="text-sm">Replacement {field === 'testDate' ? 'Test date' : field === 'serial' ? 'Serial' : 'Type'}
                <input type="text" className={fieldClass} value={selected[field]} required
                  placeholder={field === 'testDate' ? 'MM/DD/YYYY' : undefined}
                  onBlur={() => field === 'testDate' && setSelections(prev => ({ ...prev, [item.id]: { ...prev[item.id], testDate: formatEquipmentTestDate(prev[item.id].testDate) } }))}
                  onChange={e => setSelections(prev => ({ ...prev, [item.id]: { ...prev[item.id], [field]: e.target.value } }))} />
              </label>)}
            </div>}
          </div>
        })}
        <label className="block space-y-1 text-sm font-medium">Reason / work notes (optional)
          <textarea className={fieldClass} rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is the equipment being swapped?" />
        </label>
        <p className="text-sm text-slate-600">{Object.keys(selections).length} equipment swap(s) selected. Only selected items will change.</p>
        <button type="button" disabled={loading || saving || !rentalId || !Object.keys(selections).length || !swapDate || swapDate > todayKey()} onClick={() => { setStep('billing'); setError('') }} className="rounded-lg bg-blue-700 px-4 py-2 text-white disabled:opacity-50">Next: Billing</button>
        </> : <>
          <h2 className="text-lg font-semibold">Billing — Labor &amp; Mileage</h2>
          <p className="text-sm text-slate-600">Enter actual hours and miles. Charges will be reviewed and billed with this rental.</p>
          {!billingReady ? <p className="text-sm text-slate-500">Loading billing defaults…</p>
            : <LineItemEditor items={lineItems} onChange={setLineItems} serviceType="general" division={4} priceLevels={priceLevels} />}
          <div className="flex justify-between gap-3">
            <button type="button" onClick={() => { setStep('equipment'); setError('') }} className="rounded-lg border border-slate-300 px-4 py-2">Back: Equipment</button>
            <button type="button" disabled={saving || !billingReady || !Object.keys(selections).length || !swapDate || swapDate > todayKey()} onClick={() => void submit()} className="rounded-lg bg-blue-700 px-4 py-2 text-white disabled:opacity-50">{saving ? 'Saving…' : 'Complete Swap Ticket'}</button>
          </div>
        </>}
      </fieldset>
    </div>
  )
}
