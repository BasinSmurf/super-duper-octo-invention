import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { db } from '@/lib/db'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getActiveSiteId } from '@/lib/site'
import { CustomerSearch } from '@/components/CustomerSearch'
import { useSync } from '@/contexts/SyncContext'
import {
  ShopUnitEntry,
  buildShopItemPayload,
  partLabel,
  isMonitor,
  CATEGORIES,
  SERVICE_TYPES,
  type IntakeItem,
} from '@/components/ShopUnitEntry'
import { ShopLabelPrintDialog, collectLabelUnits } from '@/components/ShopLabelPrintDialog'
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  ClipboardList,
  CheckCircle2,
} from 'lucide-react'

type Customer = { id: string; name: string; companyType: string; city: string | null; state: string | null }

type Step = 'customer' | 'items' | 'review'
const STEPS: Step[] = ['customer', 'items', 'review']
const STEP_LABELS: Record<Step, string> = {
  customer: 'Customer',
  items: 'Equipment',
  review: 'Review',
}

type PreferredContact = 'call' | 'text' | 'email'
interface ContactPerson {
  name: string
  phone: string
  email: string
  preferred: PreferredContact
}
const EMPTY_CONTACT: ContactPerson = { name: '', phone: '', email: '', preferred: 'call' }

function isContactValid(c: ContactPerson): boolean {
  if (!c.name.trim()) return false
  if (c.preferred === 'call' || c.preferred === 'text') return !!c.phone.trim()
  if (c.preferred === 'email') return !!c.email.trim()
  return false
}

export function ShopIntakePage() {
  const navigate = useNavigate()
  const { enabled: offlineEnabled } = useSync()
  const [step, setStep] = useState<Step>('customer')

  // Basin Safety's well-known company record (for internal work)
  const BASIN_SAFETY: Customer = { id: 'co-basin', name: 'Basin Safety', companyType: 'both', city: 'Williston', state: 'ND' }

  // Step 1: Customer info (incl. contacts)
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [isInternal, setIsInternal] = useState(false)
  const [poNumber, setPoNumber] = useState('')
  const [afeNumber, setAfeNumber] = useState('')
  // Tier 1 reservation billing — routes the QB customer to Pale Horse when
  // this WO is invoiced. Shop work has no pad, so it's a per-WO checkbox.
  const [tier1, setTier1] = useState(false)
  const [intakeNotes, setIntakeNotes] = useState('')
  const [primaryCategory, setPrimaryCategory] = useState('')
  const [priority, setPriority] = useState(5)

  // Contacts — inlined into the customer step
  const [dropOffContact, setDropOffContact] = useState<ContactPerson>(EMPTY_CONTACT)
  const [pickupSameAsDropOff, setPickupSameAsDropOff] = useState(true)
  const [pickupContact, setPickupContact] = useState<ContactPerson>(EMPTY_CONTACT)
  const effectivePickupContact = pickupSameAsDropOff ? dropOffContact : pickupContact

  // Step 2: Items (Equipment)
  const [items, setItems] = useState<IntakeItem[]>([])
  const [occupiedBins, setOccupiedBins] = useState<Map<string, { workOrderNumber: string; workOrderId?: string; itemId: string }>>(new Map())

  const hasDeferredSerials = items.some(item => !item.serialNumber.trim())
  const validItemCount = items.length > 0 && (!hasDeferredSerials || (items.length > 10 && items.length <= 1000))

  useEffect(() => {
    api.get<{ data: Array<{ bin: string; workOrderNumber: string; workOrderId?: string; itemId: string }> }>('/shop-orders/occupied-bins')
      .then(res => setOccupiedBins(new Map(res.data.map(d => [d.bin, { workOrderNumber: d.workOrderNumber, workOrderId: d.workOrderId, itemId: d.itemId }]))))
      .catch(() => setOccupiedBins(new Map()))
  }, [])

  // Step 3: Submit (Review)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  // Intake print dialog (operator confirms printer + per-unit selection;
  // replaces auto-fire). Holds the created WO so the dialog can list every
  // unit — parents and SCBA components — as its label checklist.
  const [printPromptWo, setPrintPromptWo] = useState<any>(null)

  const stepIndex = STEPS.indexOf(step)

  function canAdvance(): boolean {
    switch (step) {
      case 'customer':
        return !!customer && isContactValid(dropOffContact) && isContactValid(effectivePickupContact)
      case 'items':
        return validItemCount
      case 'review':
        return true
      default:
        return false
    }
  }

  function goNext() {
    const idx = STEPS.indexOf(step)
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1])
  }

  function goBack() {
    const idx = STEPS.indexOf(step)
    if (idx > 0) setStep(STEPS[idx - 1])
  }

  async function handleSubmit() {
    if (!customer || !validItemCount) return
    setSubmitting(true)
    setSubmitError('')

    try {
      const dropOffPayload = {
        name: dropOffContact.name.trim(),
        phone: dropOffContact.phone.trim() || null,
        email: dropOffContact.email.trim() || null,
        preferred: dropOffContact.preferred,
      }
      const pickupSrc = effectivePickupContact
      const pickupPayload = {
        name: pickupSrc.name.trim(),
        phone: pickupSrc.phone.trim() || null,
        email: pickupSrc.email.trim() || null,
        preferred: pickupSrc.preferred,
      }

      const payload = {
        companyId: customer.id,
        isInternal,
        // Basin Site the equipment is being received at — the active-site
        // switcher. Without this the server falls back to the founding site
        // (Williston), forcing a phantom transfer round-trip for Dickinson
        // intakes.
        intakeSiteId: getActiveSiteId() || undefined,
        intakeDate: new Date().toISOString(),
        intakeNotes: intakeNotes || null,
        poNumber: poNumber || null,
        afeNumber: afeNumber || null,
        tier1: isInternal ? false : tier1,
        primaryCategory: primaryCategory || null,
        priority,
        massIntake: hasDeferredSerials,
        dropOffContact: dropOffPayload,
        pickupContact: pickupPayload,
        items: items.map(buildShopItemPayload),
      }

      // Try API first
      try {
        const result = await api.post<any>('/shop-orders', payload)
        if (result?.id) {
          // Online: hand off to the print-confirm dialog instead of auto-firing
          // labels. The dialog navigates to the WO once the operator prints or
          // skips. setSubmitting(false) so the page isn't stuck behind the modal.
          setSubmitting(false)
          setPrintPromptWo(result)
          return
        }
      } catch (err) {
        // A server rejection is not an offline save. Keep the entered form
        // and show the reason instead of creating an unsaveable Pending order.
        if (err instanceof ApiError) throw err
        if (!offlineEnabled) throw new Error('Work order was not saved. Check your connection and try again. Your equipment list is still here.')
        // No HTTP response: retain the existing offline fallback.
      }

      // Offline fallback: save to Dexie + mutation queue
      const woId = uuidv4()
      const now = new Date().toISOString()

      await db.transaction('rw', [db.shopWorkOrders, db.mutationQueue], async () => {
        await db.shopWorkOrders.put({
          id: woId,
          workOrderNumber: 'Pending...',
          status: 'intake',
          companyId: customer.id,
          companyName: customer.name,
          isInternal,
          poNumber: poNumber || null,
          afeNumber: afeNumber || null,
          tier1: isInternal ? false : tier1,
          intakeDate: now,
          intakeNotes: intakeNotes || null,
          intakeById: null,
          intakeByName: undefined,
          // Basin Site this WO was received at — the active-site switcher; the
          // server falls back to the founding site when this is blank.
          intakeSiteId: getActiveSiteId() ?? '',
          sourceLocationId: null,
          returnLocationId: null,
          promisedDate: null,
          priority,
          completedDate: null,
          returnedDate: null,
          totalItems: items.length,
          completedItems: 0,
          primaryCategory: primaryCategory || null,
          notes: null,
          dropOffContactName: dropOffPayload.name,
          dropOffContactPhone: dropOffPayload.phone,
          dropOffContactEmail: dropOffPayload.email,
          dropOffContactPreferred: dropOffPayload.preferred,
          pickupContactName: pickupPayload.name,
          pickupContactPhone: pickupPayload.phone,
          pickupContactEmail: pickupPayload.email,
          pickupContactPreferred: pickupPayload.preferred,
          pickupSignedByName: null,
          pickupSignature: null,
          pickupSignedAt: null,
          pickupNotes: null,
          createdAt: now,
          updatedAt: now,
          _offlineStatus: 'pending',
        })

        await db.mutationQueue.add({
          table: 'shopWorkOrders',
          action: 'create',
          entityId: woId,
          payload: { ...payload, id: woId },
          createdAt: now,
          status: 'pending',
          retryCount: 0,
        })
      })

      navigate(`/shop/${woId}`)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create work order')
    }
    setSubmitting(false)
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Intake print dialog — print? / which printer / which units */}
      {printPromptWo && (
        <ShopLabelPrintDialog
          woId={printPromptWo.id}
          units={collectLabelUnits(printPromptWo)}
          onDone={() => navigate(`/shop/${printPromptWo.id}`)}
        />
      )}

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/shop')} className="p-2 -ml-2 text-slate-600 hover:text-slate-900">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-900">Shop Intake</h1>
          <p className="text-sm text-slate-500">Receive equipment for service</p>
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2 flex-1">
            <div className={cn(
              'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold',
              i < stepIndex ? 'bg-emerald-500 text-white' :
              i === stepIndex ? 'bg-blue-800 text-white' :
              'bg-slate-200 text-slate-500',
            )}>
              {i < stepIndex ? '✓' : i + 1}
            </div>
            <span className={cn(
              'text-xs font-medium',
              i === stepIndex ? 'text-slate-900' : 'text-slate-400',
            )}>
              {STEP_LABELS[s]}
            </span>
            {i < STEPS.length - 1 && <div className="flex-1 h-px bg-slate-200" />}
          </div>
        ))}
      </div>

      {/* Step 1: Customer */}
      {step === 'customer' && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Customer</label>
            {isInternal ? (
              <div className="px-3 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-sm font-medium text-blue-900">
                Basin Safety (Internal)
              </div>
            ) : (
              <CustomerSearch value={customer} onChange={setCustomer} />
            )}
          </div>

          {/* Internal toggle */}
          <label className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={isInternal}
              onChange={e => {
                const checked = e.target.checked
                setIsInternal(checked)
                if (checked) {
                  setCustomer(BASIN_SAFETY)
                } else if (customer?.id === BASIN_SAFETY.id) {
                  setCustomer(null)
                }
              }}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <div>
              <p className="text-sm font-medium text-blue-900">Internal Work</p>
              <p className="text-xs text-blue-700">Basin Safety equipment — no customer billing</p>
            </div>
          </label>

          {/* Category */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Primary Category</label>
            <select
              value={primaryCategory}
              onChange={e => setPrimaryCategory(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            >
              <option value="">Mixed / Not specified</option>
              {CATEGORIES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          {/* PO + AFE */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">PO Number</label>
              <input
                value={poNumber}
                onChange={e => setPoNumber(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                placeholder="Optional"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">AFE Number</label>
              <input
                value={afeNumber}
                onChange={e => setAfeNumber(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                placeholder="Optional"
              />
            </div>
          </div>

          {/* Tier 1 reservation billing — customer routing, so only for
              billable (non-internal) work. */}
          {!isInternal && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tier1}
                onChange={e => setTier1(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-500"
              />
              <span className="text-sm text-slate-700">
                Tier 1 reservation
                <span className="block text-xs text-slate-500">Bills through Pale Horse without adding a surcharge.</span>
              </span>
            </label>
          )}

          {/* Priority */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Priority</label>
            <div className="flex gap-2">
              {[{ v: 1, l: 'Urgent' }, { v: 2, l: 'High' }, { v: 5, l: 'Normal' }, { v: 10, l: 'Low' }].map(p => (
                <button
                  key={p.v}
                  type="button"
                  onClick={() => setPriority(p.v)}
                  className={cn(
                    'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors',
                    priority === p.v ? 'bg-blue-100 border-blue-300 text-blue-800' : 'bg-white border-slate-200 text-slate-600',
                  )}
                >
                  {p.l}
                </button>
              ))}
            </div>
          </div>

          {/* Contacts — inline so the counter user can't navigate past without filling them */}
          <div className="pt-2 border-t border-slate-200 space-y-4">
            <ContactCard
              title="Person Dropping Off"
              subtitle="Who's bringing the equipment in?"
              value={dropOffContact}
              onChange={setDropOffContact}
              accent="emerald"
            />

            <label className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={pickupSameAsDropOff}
                onChange={e => setPickupSameAsDropOff(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <div>
                <p className="text-sm font-medium text-slate-900">Pickup contact same as drop-off</p>
                <p className="text-xs text-slate-500">Uncheck if a different person should be called when ready</p>
              </div>
            </label>

            {!pickupSameAsDropOff && (
              <ContactCard
                title="Pickup Contact"
                subtitle="Who do we call when it's ready?"
                value={pickupContact}
                onChange={setPickupContact}
                accent="blue"
              />
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Intake Notes</label>
            <textarea
              value={intakeNotes}
              onChange={e => setIntakeNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none"
              placeholder="General notes about this batch..."
            />
          </div>
        </div>
      )}

      {/* Step 2: Items */}
      {step === 'items' && (
        <ShopUnitEntry
          items={items}
          onChange={setItems}
          defaultCategory={primaryCategory}
          allowMassIntake
          occupiedBins={occupiedBins}
        />
      )}

      {/* Step 3: Review */}
      {step === 'review' && (
        <div className="space-y-4">
          {submitError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {submitError}
            </div>
          )}

          <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-3">
            <h3 className="font-semibold text-slate-900 flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Work Order Summary
            </h3>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-slate-500 text-xs">Customer</p>
                <p className="font-medium">{customer?.name}</p>
                {isInternal && <p className="text-xs text-blue-600 font-medium">Internal Work</p>}
              </div>
              <div>
                <p className="text-slate-500 text-xs">Items</p>
                <p className="font-medium">{items.length} piece{items.length !== 1 ? 's' : ''}</p>
              </div>
              {primaryCategory && (
                <div>
                  <p className="text-slate-500 text-xs">Category</p>
                  <p className="font-medium">{CATEGORIES.find(c => c.value === primaryCategory)?.label || primaryCategory}</p>
                </div>
              )}
              <div>
                <p className="text-slate-500 text-xs">Priority</p>
                <p className="font-medium">
                  {priority === 1 ? 'Urgent' : priority === 2 ? 'High' : priority === 5 ? 'Normal' : 'Low'}
                </p>
              </div>
              {poNumber && <div><p className="text-slate-500 text-xs">PO</p><p className="font-medium">{poNumber}</p></div>}
              {afeNumber && <div><p className="text-slate-500 text-xs">AFE</p><p className="font-medium">{afeNumber}</p></div>}
            </div>

            {intakeNotes && (
              <div>
                <p className="text-slate-500 text-xs">Notes</p>
                <p className="text-sm text-slate-700">{intakeNotes}</p>
              </div>
            )}

            <div className="pt-2 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-slate-500 text-xs uppercase tracking-wide">Drop-off</p>
                <p className="font-medium text-slate-900">{dropOffContact.name || '—'}</p>
                <p className="text-xs text-slate-500">{[dropOffContact.phone, dropOffContact.email].filter(Boolean).join(' · ') || '—'}</p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wide mt-0.5">Prefers {dropOffContact.preferred}</p>
              </div>
              <div>
                <p className="text-slate-500 text-xs uppercase tracking-wide">Pickup contact</p>
                <p className="font-medium text-slate-900">
                  {effectivePickupContact.name || '—'}
                  {pickupSameAsDropOff && <span className="ml-1 text-[10px] text-slate-400">(same as drop-off)</span>}
                </p>
                <p className="text-xs text-slate-500">{[effectivePickupContact.phone, effectivePickupContact.email].filter(Boolean).join(' · ') || '—'}</p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wide mt-0.5">Prefers {effectivePickupContact.preferred}</p>
              </div>
            </div>
          </div>

          {/* Items list preview */}
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-medium text-slate-700 mb-2">Equipment ({items.length})</h3>
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {items.map((item, idx) => (
                <div key={item.id} className="py-1 border-b border-slate-50 last:border-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-slate-400 w-6">{idx + 1}</span>
                    <span className="font-mono font-medium text-slate-900 flex-1">{item.serialNumber || 'Serial required at QA'}</span>
                    <span className="text-slate-500">{SERVICE_TYPES.find(s => s.value === item.serviceType)?.label}</span>
                  </div>
                  {/* FEX review */}
                  {item.equipmentCategory === 'fire_extinguisher' && (item.fexBrand || item.fexSize || item.fexType) && (
                    <div className="ml-6 text-[10px] text-orange-600">
                      {[item.fexBrand, item.fexSize, item.fexType].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {/* Monitor review */}
                  {isMonitor(item.equipmentCategory) && (item.monitorBrand || item.monitorModel || item.monitorGasTypes.length > 0) && (
                    <div className="ml-6 text-[10px] text-teal-600">
                      {[item.monitorBrand, item.monitorModel].filter(Boolean).join(' ')}
                      {item.monitorGasTypes.length > 0 && ` · ${item.monitorGasTypes.join(', ')}`}
                    </div>
                  )}
                  {/* Personal-monitor bin review */}
                  {item.equipmentCategory === 'personal_monitor' && item.binLocation && (
                    <div className="ml-6 text-[10px] font-medium text-teal-700">{item.binLocation}</div>
                  )}
                  {/* Fall Arrest review */}
                  {item.equipmentCategory === 'fall_arrest' && (item.fallArrestBrand || item.fallArrestModel) && (
                    <div className="ml-6 text-[10px] text-purple-600">
                      {[item.fallArrestBrand, item.fallArrestModel].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {/* Other review */}
                  {item.equipmentCategory === 'other' && item.otherDescription && (
                    <div className="ml-6 text-[10px] text-slate-500 italic">
                      {item.otherDescription}
                    </div>
                  )}
                  {/* SCBA review */}
                  {item.equipmentCategory === 'scba' && (
                    <div className="ml-6 text-[10px] text-blue-600">
                      {[
                        item.scbaCaseSerial && `Case: ${item.scbaCaseSerial}`,
                        item.scbaRegulatorSerial && `Reg: ${item.scbaRegulatorSerial}`,
                        item.scbaMaskSerial && `Mask: ${item.scbaMaskSerial}`,
                        item.scbaHarnessSerial && `Harness: ${item.scbaHarnessSerial}`,
                        ...item.scbaBottleSerials.map(bs => `Bottle: ${bs}`),
                        (item.scbaNotIncluded?.length ?? 0) > 0 && `Not included: ${item.scbaNotIncluded!.map(partLabel).join(', ')}`,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex gap-3 mt-6">
        {stepIndex > 0 && (
          <button
            type="button"
            onClick={goBack}
            className="flex items-center gap-2 px-4 py-3 border border-slate-300 rounded-lg text-slate-700 font-medium text-sm hover:bg-slate-50 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
        )}

        <div className="flex-1" />

        {step !== 'review' ? (
          <button
            type="button"
            onClick={goNext}
            disabled={!canAdvance()}
            className="flex items-center gap-2 px-6 py-3 bg-blue-800 text-white rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors disabled:opacity-40"
          >
            Next
            <ArrowRight className="w-4 h-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !validItemCount}
            className="flex items-center gap-2 px-6 py-3 bg-emerald-700 text-white rounded-lg font-medium text-sm hover:bg-emerald-600 transition-colors disabled:opacity-40"
          >
            {submitting ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Creating...</>
            ) : (
              <><CheckCircle2 className="w-4 h-4" /> Create Work Order ({items.length} items)</>
            )}
          </button>
        )}
      </div>
    </div>
  )
}

const PREFERRED_OPTIONS: Array<{ value: PreferredContact; label: string }> = [
  { value: 'call', label: 'Call' },
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
]

interface ContactCardProps {
  title: string
  subtitle: string
  value: ContactPerson
  onChange: (next: ContactPerson) => void
  accent: 'emerald' | 'blue'
}

function ContactCard({ title, subtitle, value, onChange, accent }: ContactCardProps) {
  const accentClasses = accent === 'emerald'
    ? { bg: 'bg-emerald-50', border: 'border-emerald-200', label: 'text-emerald-700', activeBtn: 'bg-emerald-600 text-white border-emerald-600', idleBtn: 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-100' }
    : { bg: 'bg-blue-50', border: 'border-blue-200', label: 'text-blue-700', activeBtn: 'bg-blue-700 text-white border-blue-700', idleBtn: 'bg-white text-blue-700 border-blue-300 hover:bg-blue-100' }

  const phoneRequired = value.preferred === 'call' || value.preferred === 'text'
  const emailRequired = value.preferred === 'email'

  return (
    <div className={cn('rounded-lg border p-4 space-y-3', accentClasses.bg, accentClasses.border)}>
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </div>

      <div>
        <label className={cn('block text-xs font-medium mb-1', accentClasses.label)}>
          Name <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={value.name}
          onChange={e => onChange({ ...value, name: e.target.value })}
          placeholder="Full name"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={cn('block text-xs font-medium mb-1', accentClasses.label)}>
            Phone {phoneRequired && <span className="text-red-500">*</span>}
          </label>
          <input
            type="tel"
            value={value.phone}
            onChange={e => onChange({ ...value, phone: e.target.value })}
            placeholder="(555) 555-5555"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
          />
        </div>
        <div>
          <label className={cn('block text-xs font-medium mb-1', accentClasses.label)}>
            Email {emailRequired && <span className="text-red-500">*</span>}
          </label>
          <input
            type="email"
            value={value.email}
            onChange={e => onChange({ ...value, email: e.target.value })}
            placeholder="name@example.com"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
          />
        </div>
      </div>

      <div>
        <label className={cn('block text-xs font-medium mb-1.5', accentClasses.label)}>
          Preferred contact <span className="text-red-500">*</span>
        </label>
        <div className="flex gap-2">
          {PREFERRED_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange({ ...value, preferred: opt.value })}
              className={cn(
                'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors',
                value.preferred === opt.value ? accentClasses.activeBtn : accentClasses.idleBtn,
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
