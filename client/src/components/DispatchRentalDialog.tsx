import { useState, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { X, Loader2, Phone, AtSign, Truck, ShoppingBag, Package, DollarSign, ShieldAlert, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { db } from '@/lib/db'
import { CustomerSearch } from '@/components/CustomerSearch'
import { ProductSearch } from '@/components/ProductSearch'
import { useCompanyPriceLevels } from '@/lib/priceLevels'
import { loadRentalMonitors, rentalCatalogRate, repriceRentalRows, type RentalCatalogProduct } from '@/lib/rentalCatalog'
import { CREDIT_HOLD_MESSAGE } from '@/lib/creditHold'
import { LocationPicker, type LocationSelection } from '@/components/LocationPicker'
import { EquipmentScanner, type ScannedEquipment } from '@/components/EquipmentScanner'
import { SignaturePad } from '@/components/SignaturePad'
import { BillingRefsField } from '@/components/BillingRefsField'
import { QuantityInput } from '@/components/QuantityInput'
import { selectBillingProfileSeed } from '@/lib/billingProfile'
import { rateUnitAbbrev, rateUnitLong, hasRate } from '@/lib/rentalRates'
import type { BillingRef, RentalComposition, BillingProfileSeed } from '@/lib/db-types'
import { type RentalBom, BOM_TYPE_LABELS, packageVariants, bomDisplayName, bomBaselineItems, bomPackageLine } from '@/lib/rentalBom'
import { todayKey } from '@/lib/dates'

type PickupType = 'dispatch' | 'walk_in'

interface WalkInItem {
  id: string
  serializedEquipmentId: string
  productId: string
  productName: string
  serialNumber: string
  rate: number | null
  rateType: 'daily' | 'weekly' | 'monthly'
}

type MonitorProduct = RentalCatalogProduct

interface CompanyRef {
  id: string
  name: string
  companyType: string
  city: string | null
  state: string | null
  creditHold?: boolean
}

interface DispatchRentalDialogProps {
  open: boolean
  onClose: () => void
  onCreated: (rentalId: string) => void
}

/**
 * New Rental dialog — covers two flows behind a single entry point:
 *
 * - **Dispatch** (default): Phase C slim form. Mints contract in 'scheduled'
 *   state with location + caller/site contacts. Tech adds equipment + waiver
 *   at the Start Job ticket when they go out.
 * - **Walk-in**: counter rental. Customer signs the liability waiver at
 *   pickup, equipment goes out immediately, agreement is created 'active'
 *   with no Pad/Location and no daily-log expectation.
 */
export function DispatchRentalDialog({ open, onClose, onCreated }: DispatchRentalDialogProps) {
  const [assignedTechId, setAssignedTechId] = useState('')
  const [ringCentralChannel, setRingCentralChannel] = useState('')
  const [dispatchUsers, setDispatchUsers] = useState<{ id: string; name: string }[]>([])
  const [dispatchChannels, setDispatchChannels] = useState<{ channel: string }[]>([])
  const [optionsError, setOptionsError] = useState('')
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setOptionsError('')
    Promise.all([api.get<{ data: { id: string; name: string }[] }>('/users/active'), api.get<{ channels: { channel: string }[] }>('/rentals/dispatch-options')])
      .then(([users, options]) => { if (!cancelled) { setDispatchUsers(users.data); setDispatchChannels(options.channels); setRingCentralChannel(previous => previous || (options.channels.find(c => c.channel === 'rentals')?.channel ?? '')) } })
      .catch(() => { if (!cancelled) setOptionsError('Could not load dispatch users and channels. Reopen this form to retry.') })
    return () => { cancelled = true }
  }, [open])
  const [pickupType, setPickupType] = useState<PickupType>('dispatch')
  const [customer, setCustomer] = useState<CompanyRef | null>(null)
  const { levels: rentalPriceLevels } = useCompanyPriceLevels(customer?.id)
  // AR credit hold on the selected customer — a rental is equipment leaving on
  // credit, so the hold blocks dispatching one.
  const [customerCreditHold, setCustomerCreditHold] = useState(false)
  const [location, setLocation] = useState<LocationSelection>({ field: null, pad: null, wells: [] })
  const [billingRateType, setBillingRateType] = useState<'daily' | 'weekly' | 'monthly'>('daily')
  const [startDate, setStartDate] = useState(() => todayKey())
  // #C billing refs repeater (replaces single PO/AFE inputs). Seeded from the
  // customer's profile but NEVER required at dispatch (PO often unknown yet).
  const [billingRefs, setBillingRefs] = useState<BillingRef[]>([])
  const [billingLabels, setBillingLabels] = useState<{ po?: string | null; afe?: string | null; costCode?: string | null }>({})
  // #C composition builder (replaces the isManned/isRigJob/monitorsIncluded toggles)
  const [trailerOn, setTrailerOn] = useState(false)
  const [trailerManned, setTrailerManned] = useState(true)
  const [trailerRate, setTrailerRate] = useState<number | null>(null)
  const [gasMonitors, setGasMonitors] = useState<{ id: string; productId: string; productName: string; qty: number; rate: number | null; manualRate?: boolean }[]>([])
  const [otherItems, setOtherItems] = useState<{ id: string; label: string; productId?: string; catalogProduct?: RentalCatalogProduct; qty: number; rate: number | null; manualRate?: boolean }[]>([])
  const [drillingRig, setDrillingRig] = useState(false)
  const [monitorProducts, setMonitorProducts] = useState<MonitorProduct[]>([])
  // #Wave4 the selected customer's saved rental packages (Standard/Drilling).
  // The composition baseline pre-fills from these; drives the "what's included"
  // preview. Fetched on customer select.
  const [customerBoms, setCustomerBoms] = useState<RentalBom[]>([])
  const [baselinePackageSelected, setBaselinePackageSelected] = useState(true)
  // Which variant of the applicable package type the dispatcher picked. null =
  // the type's default. A pick that stops fitting (manned/rig toggled) falls
  // back to the new type's default rather than carrying a stale id.
  const [selectedBomId, setSelectedBomId] = useState<string | null>(null)
  // The package's own rate, in the agreement's billing unit. Seeded from the
  // bound package product and editable per job — the package is a real charge,
  // so it follows the same set-a-rate-before-dispatch discipline as every other
  // composition line rather than being assumed.
  const [bomPackageRate, setBomPackageRate] = useState<number | null>(null)

  // Person Calling — customer-side requester (dispatch) / signer-at-counter (walk-in)
  const [personCallingName, setPersonCallingName] = useState('')
  const [personCallingPhone, setPersonCallingPhone] = useState('')
  const [personCallingEmail, setPersonCallingEmail] = useState('')

  // On-Site Contact — who'll meet the tech (dispatch only)
  const [siteContactName, setSiteContactName] = useState('')
  const [siteContactPhone, setSiteContactPhone] = useState('')
  const [siteContactEmail, setSiteContactEmail] = useState('')
  const [siteContactSameAsCalling, setSiteContactSameAsCalling] = useState(false)

  // Walk-in: equipment + liability
  const [walkInItems, setWalkInItems] = useState<WalkInItem[]>([])
  const [showEquipmentScanner, setShowEquipmentScanner] = useState(false)
  const [liabilityAcknowledged, setLiabilityAcknowledged] = useState(false)
  const [liabilitySignature, setLiabilitySignature] = useState<string | null>(null)

  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refresh the QB-backed catalog online; keep cached products available offline.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadRentalMonitors().then(products => {
      if (!cancelled) setMonitorProducts(products)
    }).catch(() => { if (!cancelled) setMonitorProducts([]) })
    return () => { cancelled = true }
  }, [open])

  // #C seed billing-ref rows + labels from the customer's profile (never required here)
  useEffect(() => {
    if (!customer?.id) { setBillingLabels({}); setCustomerCreditHold(false); return }
    let cancelled = false
    ;(async () => {
      const c = await db.companies.get(customer.id)
      if (cancelled) return
      setCustomerCreditHold(!!c?.creditHold || !!customer.creditHold)
      setBillingLabels({ po: c?.poLabel, afe: c?.afeLabel, costCode: c?.costCenterLabel })
      setBillingRefs(prev => {
        if (prev.length > 0) return prev
        const profile = selectBillingProfileSeed(c?.billingProfilesSeed as BillingProfileSeed[] | undefined, { ticketType: 'rental', division: 'D4' })
        const seeded: BillingRef[] = [
          { id: uuidv4(), type: 'po', value: profile?.defaultPoNumber || '', required: false },
        ]
        if (profile?.defaultAfeNumber) seeded.push({ id: uuidv4(), type: 'afe', value: profile.defaultAfeNumber, required: false })
        return seeded
      })
    })()
    return () => { cancelled = true }
  }, [customer?.id])

  // Load the customer's saved rental packages and PRE-FILL the job from them.
  //
  // A package on file is a statement that this is what the customer's jobs
  // deploy — so dispatch shouldn't have to re-assert it by hand. Previously
  // this seeded `manned` but never turned the trailer ON, so a dispatcher with
  // a perfectly good package still had to tick Trailer and type a rate, which
  // is the whole thing the package was supposed to remove.
  //
  // The BOM carries `manned` + `includedTechs`, which only describe a trailer,
  // so a package existing is taken to mean the job has one. A monitors-only job
  // is the exception, and the dispatcher just unticks it.
  //
  // Fetch on customer change only; package selection controls the pre-fill below.
  useEffect(() => {
    setSelectedBomId(null)
    if (!customer?.id) { setCustomerBoms([]); return }
    let cancelled = false
    ;(async () => {
      try {
        const boms = await api.get<RentalBom[]>(`/companies/${customer.id}/rental-boms`)
        if (cancelled) return
        setCustomerBoms(boms || [])
      } catch {
        if (!cancelled) setCustomerBoms([])
      }
    })()
    return () => { cancelled = true }
  }, [customer?.id])

  // Apply saved defaults only while the package is selected, including when
  // the package request finishes after dispatch has already deselected it.
  useEffect(() => {
    if (!baselinePackageSelected) return
    const standard = customerBoms.find(b => b.bomType === 'standard')
    if (!standard) return
    setTrailerManned(standard.manned)
    setTrailerOn(true)
    if (standard.packageProductId) setTrailerRate(0)
  }, [customerBoms, baselinePackageSelected])

  // Catalog/contract responses may arrive after a line is selected. Refresh
  // automatic quotes, while preserving rates dispatch has explicitly edited.
  useEffect(() => {
    setGasMonitors(rows => repriceRentalRows(rows, monitorProducts, billingRateType, rentalPriceLevels))
  }, [billingRateType, monitorProducts, rentalPriceLevels])

  useEffect(() => {
    setOtherItems(rows => rows.map(row => row.catalogProduct && !row.manualRate
      ? { ...row, rate: rentalCatalogRate(row.catalogProduct, billingRateType, rentalPriceLevels) } : row))
  }, [billingRateType, rentalPriceLevels])

  // Auto-populate the package rate from the customer's bound package item —
  // re-seeding when the applicable package changes (Drilling toggle) or the
  // billing unit flips, so the number always matches its unit. Mirrors the
  // gas-monitor rule: an absent product default never wipes a rate the
  // dispatcher typed by hand.
  // NOTE: must stay above the `if (!open)` early return — it's a hook.
  useEffect(() => {
    const variants = packageVariants(customerBoms, drillingRig, trailerManned)
    const bom = variants.find(b => b.id === selectedBomId) ?? variants[0] ?? null
    const pkg = bomPackageLine(bom, billingRateType)
    setBomPackageRate(prev => pkg?.rate ?? prev)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerBoms, drillingRig, trailerManned, billingRateType, selectedBomId])

  if (!open) return null

  function reset() {
    setAssignedTechId('')
    setRingCentralChannel('')
    setPickupType('dispatch')
    setCustomer(null)
    setLocation({ field: null, pad: null, wells: [] })
    setBillingRateType('daily')
    setStartDate(todayKey())
    setBillingRefs([])
    setBillingLabels({})
    setTrailerOn(false)
    setTrailerManned(true)
    setTrailerRate(null)
    setGasMonitors([])
    setOtherItems([])
    setDrillingRig(false)
    setCustomerBoms([])
    setBaselinePackageSelected(true)
    setSelectedBomId(null)
    setBomPackageRate(null)
    setPersonCallingName('')
    setPersonCallingPhone('')
    setPersonCallingEmail('')
    setSiteContactName('')
    setSiteContactPhone('')
    setSiteContactEmail('')
    setSiteContactSameAsCalling(false)
    setWalkInItems([])
    setShowEquipmentScanner(false)
    setLiabilityAcknowledged(false)
    setLiabilitySignature(null)
    setNotes('')
    setError(null)
  }

  function close() {
    reset()
    onClose()
  }

  const rateUnit = rateUnitAbbrev(billingRateType)
  const rateTypeLabel = billingRateType === 'weekly' ? 'Weekly' : billingRateType === 'monthly' ? 'Monthly' : 'Daily'

  // #Wave4 the baseline package that applies to this rental: rig when the rig
  // toggle is on; otherwise manned/unmanned follows the existing trailer flag.
  // Legacy Standard/Drilling rows are still accepted as resolver fallbacks.
  // A customer may price several variants of one type ("w/ gas detection" vs
  // "no monitors"); the default is preselected and the rest are one click away.
  const bomVariants = baselinePackageSelected ? packageVariants(customerBoms, drillingRig, trailerManned) : []
  const resolvedBom = bomVariants.find(b => b.id === selectedBomId) ?? bomVariants[0] ?? null
  const baselineItems = bomBaselineItems(resolvedBom)
  // The package's billable line. Bound package items still get customer price
  // level handling; unbound/no-package rentals can carry an explicit manual
  // rate so a dispatcher-entered daily rate does not disappear.
  const packageLine = bomPackageLine(resolvedBom, billingRateType)
  const manualPackageLine = pickupType === 'dispatch' && baselinePackageSelected && customer && !packageLine
    ? {
        label: `${rateTypeLabel} Rental Rate`,
        bomType: (drillingRig ? 'drilling' : 'standard') as 'drilling' | 'standard',
        productId: null,
        productName: null,
        qty: 1,
        rate: null,
        priceLevel: null,
      }
    : null
  const packageRateLine = packageLine ?? manualPackageLine
  const boundPackageBills = pickupType === 'dispatch' && !!packageLine?.productId
  const manualPackageBills = pickupType === 'dispatch' && !!packageRateLine && !packageLine?.productId && hasRate(bomPackageRate)
  const packageBills = boundPackageBills || manualPackageBills

  function toggleBaselinePackage(selected: boolean) {
    setBaselinePackageSelected(selected)
    // A trailer previously covered by the package needs its own rate when
    // dispatch switches to manual items. Keep all manually added items.
    if (!selected && packageBills && trailerRate === 0) setTrailerRate(null)
  }

  // #5 Every present composition line must carry a rate before dispatch — an
  // unpriced line would later block invoicing (the server fails rather than
  // silently under-bill). 0 is allowed (free/included); only blank is missing.
  const compositionPriced =
    (pickupType !== 'dispatch' || !trailerOn || packageBills || hasRate(trailerRate)) &&
    gasMonitors.filter(g => g.productId).every(g => hasRate(g.rate)) &&
    otherItems.filter(o => o.label.trim()).every(o => hasRate(o.rate)) &&
    (!boundPackageBills || hasRate(bomPackageRate))

  const baseValid = !!customer && !!startDate && !!billingRateType && !!personCallingName.trim()
  // Dispatch must capture an on-site contact — it rides through to the rental
  // agreement and surfaces on the daily manned-trailer ticket so the tech never
  // has to pop back to Rental. "Same as caller" satisfies it in one click.
  // Walk-in is a counter rental with no site contact, so it's exempt.
  const siteContactValid = pickupType !== 'dispatch' || siteContactSameAsCalling || !!siteContactName.trim()
  const walkInValid = walkInItems.length > 0 && liabilityAcknowledged && !!liabilitySignature
  const canSubmit = (pickupType === 'dispatch'
    ? (baseValid && siteContactValid)
    : (baseValid && walkInValid)) && compositionPriced && !customerCreditHold

  async function handleSubmit() {
    if (!customer || !canSubmit) return
    setSubmitting(true)
    setError(null)

    // If "same as calling" is checked, copy over (dispatch only).
    const effectiveSiteName = siteContactSameAsCalling ? personCallingName : siteContactName
    const effectiveSitePhone = siteContactSameAsCalling ? personCallingPhone : siteContactPhone
    const effectiveSiteEmail = siteContactSameAsCalling ? personCallingEmail : siteContactEmail

    // Seed the on-site contact as the initial PIC so the manned-trailer ticket's
    // Person(s)-in-Charge roster is pre-filled (the on-site contact IS the person
    // the tech deals with on site). When "same as caller" is checked this is the
    // person calling, exactly as dispatch expects. Techs can add/edit from the
    // ticket; this write-through just means the roster is never empty at start.
    const seededPics = effectiveSiteName.trim()
      ? [{
          id: uuidv4(),
          name: effectiveSiteName.trim(),
          phone: effectiveSitePhone.trim() || undefined,
          email: effectiveSiteEmail.trim() || undefined,
          addedAt: new Date().toISOString(),
          addedBy: 'Dispatch',
        }]
      : undefined

    try {
      // #C derive flat PO/AFE from the repeater (rental stores flats; no
      // billing_refs column on the agreement). Cost-code rows aren't persisted
      // on rentals (no column) — PO/AFE drive rental billing.
      const firstRef = (t: BillingRef['type']) => billingRefs.find(r => r.type === t && r.value.trim())?.value.trim()

      // #C composition spec/BOM. Trailer + Drilling Rig are dispatch-only;
      // walk-in rents Gas Monitor + Other.
      const composition: RentalComposition = {
        trailer: (pickupType === 'dispatch' && trailerOn) ? { manned: trailerManned, rate: packageBills && !hasRate(trailerRate) ? 0 : trailerRate } : null,
        gasMonitors: gasMonitors.filter(g => g.productId).map(g => ({
          id: g.id, productId: g.productId, productName: g.productName, qty: g.qty || 1, rate: g.rate,
        })),
        other: otherItems.filter(o => o.label.trim()).map(o => ({ id: o.id, productId: o.productId, label: o.label.trim(), qty: o.qty || 1, rate: o.rate })),
        drillingRig: pickupType === 'dispatch' ? drillingRig : false,
        // #Wave4 snapshot the resolved customer BOM as the baseline (frozen with
        // the agreement; descriptive, covered by the flat rate). Dispatch-only.
        ...(pickupType === 'dispatch' && resolvedBom
          ? { bom: baselineItems, bomType: resolvedBom.bomType }
          : {}),
        // The package's single billable line. bomExtras stays absent here —
        // over-baseline gear isn't knowable until the tech scans at deploy.
        ...(packageBills && packageRateLine
          ? { bomPackage: { ...packageRateLine, rate: bomPackageRate } }
          : {}),
      }

      const commonPayload = {
        companyId: customer.id,
        billingRateType,
        startDate,
        poNumber: firstRef('po'),
        afeNumber: firstRef('afe'),
        composition,
        notes: notes.trim() || undefined,
        personCallingName: personCallingName.trim() || undefined,
        personCallingPhone: personCallingPhone.trim() || undefined,
        personCallingEmail: personCallingEmail.trim() || undefined,
      }

      const payload = pickupType === 'dispatch'
        ? {
            ...commonPayload,
            pickupType: 'dispatch',
            assignedTechId: assignedTechId || undefined,
            ringCentralChannel: ringCentralChannel || undefined,
            fieldId: location.field?.id || undefined,
            padId: location.pad?.id || undefined,
            wellId: location.wells[0]?.id || undefined,
            wellIds: location.wells.map(w => w.id),
            // Dispatch contract — no equipment, no waiver. Those land at Start Job.
            status: 'scheduled' as const,
            items: [],
            siteContactName: effectiveSiteName.trim() || undefined,
            siteContactPhone: effectiveSitePhone.trim() || undefined,
            siteContactEmail: effectiveSiteEmail.trim() || undefined,
            // On-site contact seeds the PIC roster (see seededPics above).
            pics: seededPics,
          }
        : {
            ...commonPayload,
            pickupType: 'walk_in',
            // Walk-in is a counter rental — no Pad/Location/site contact, deploy now.
            status: 'active' as const,
            items: walkInItems.map(item => ({
              serializedEquipmentId: item.serializedEquipmentId,
              productId: item.productId,
              rate: item.rate,
              rateType: item.rateType,
            })),
            liabilityAcknowledged: true,
            liabilitySignedByName: personCallingName.trim(),
            liabilitySignature,
            liabilitySignedAt: new Date().toISOString(),
          }

      const rental = await api.post<{ id: string; agreementNumber: string }>('/rentals', payload)
      onCreated(rental.id)
      close()
    } catch (e: any) {
      setError(e?.message || 'Failed to create rental')
    } finally {
      setSubmitting(false)
    }
  }

  function rateForProduct(prod: RentalCatalogProduct): number | null {
    return rentalCatalogRate(prod, billingRateType, rentalPriceLevels)
  }

  async function addEquipment(equip: ScannedEquipment) {
    setShowEquipmentScanner(false)
    if (walkInItems.some(i => i.serializedEquipmentId === equip.id)) return

    const newItems: WalkInItem[] = [{
      id: uuidv4(),
      serializedEquipmentId: equip.id,
      productId: equip.productId,
      productName: equip.product.name,
      serialNumber: equip.serialNumber,
      rate: rateForProduct(equip.product),
      rateType: billingRateType,
    }]

    // Auto-expand assemblies (mirrors TicketWizard rental behavior)
    if (equip.product.isAssembly) {
      try {
        const childRes = await api.get<{ data: Array<{
          id: string; serialNumber: string; productId: string; status: string;
          product: { id: string; partNumber: string; name: string; category: string }
        }> }>(`/equipment/${equip.id}/children`)
        for (const child of childRes.data) {
          if (child.status !== 'available') continue
          if (walkInItems.some(i => i.serializedEquipmentId === child.id)) continue
          if (newItems.some(i => i.serializedEquipmentId === child.id)) continue
          const childProd = await db.products.get(child.productId)
          newItems.push({
            id: uuidv4(),
            serializedEquipmentId: child.id,
            productId: child.productId,
            productName: child.product.name,
            serialNumber: child.serialNumber,
            rate: childProd ? rateForProduct(childProd) : null,
            rateType: billingRateType,
          })
        }
      } catch {
        // children fetch failed — keep just the parent
      }
    }

    setWalkInItems(prev => [...prev, ...newItems])
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl my-8">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">New Rental</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {pickupType === 'dispatch'
                ? <>Creates the contract in <span className="font-medium">scheduled</span> state. Tech adds equipment + signs at the Start Job ticket.</>
                : <>Counter rental — customer signs now and walks out with the equipment. Created <span className="font-medium">active</span>.</>
              }
            </p>
          </div>
          <button onClick={close} className="text-slate-400 hover:text-slate-700 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              {error}
            </div>
          )}

          {pickupType === 'dispatch' && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm font-medium text-slate-700">RingCentral channel (optional)
              <select value={ringCentralChannel} onChange={e => setRingCentralChannel(e.target.value)} className="block w-full mt-1 border rounded-lg p-2">
                <option value="">Select channel (optional)</option>
                {dispatchChannels.map(c => <option key={c.channel} value={c.channel}>Rental creation</option>)}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-700">Assigned tech (optional)
              <select value={assignedTechId} onChange={e => setAssignedTechId(e.target.value)} className="block w-full mt-1 border rounded-lg p-2">
                <option value="">Unassigned</option>
                {dispatchUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            {optionsError && <p className="text-sm text-red-700 sm:col-span-2">{optionsError}</p>}
            {!optionsError && dispatchChannels.length === 0 && <p className="text-sm text-amber-700 sm:col-span-2">No RingCentral destinations available. Configure a channel in Settings.</p>}
          </div>}
          {/* Pickup type toggle */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPickupType('dispatch')}
              aria-pressed={pickupType === 'dispatch'}
              className={
                'flex items-center gap-2 p-3 rounded-lg border-2 text-sm font-medium transition-colors ' +
                (pickupType === 'dispatch'
                  ? 'border-blue-500 bg-blue-50 text-blue-800'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300')
              }
            >
              <Truck className="w-4 h-4" />
              <div className="text-left flex-1">
                <p className="text-sm font-semibold">Dispatch</p>
                <p className="text-[11px] font-normal opacity-75">Tech delivers on site</p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setPickupType('walk_in')}
              aria-pressed={pickupType === 'walk_in'}
              className={
                'flex items-center gap-2 p-3 rounded-lg border-2 text-sm font-medium transition-colors ' +
                (pickupType === 'walk_in'
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300')
              }
            >
              <ShoppingBag className="w-4 h-4" />
              <div className="text-left flex-1">
                <p className="text-sm font-semibold">Walk-in</p>
                <p className="text-[11px] font-normal opacity-75">Sign + take at counter</p>
              </div>
            </button>
          </div>

          {/* Customer */}
          <CustomerSearch value={customer} onChange={setCustomer} />
          {customerCreditHold && (
            <div className="flex items-start gap-2 rounded-lg border-2 border-red-600 bg-red-600 px-3 py-2.5 text-sm font-semibold text-white">
              <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
              <span>{CREDIT_HOLD_MESSAGE}</span>
            </div>
          )}

          {/* Location — dispatch only */}
          {pickupType === 'dispatch' && customer && (
            <LocationPicker companyId={customer.id} value={location} onChange={setLocation} />
          )}

          {/* Person Calling (dispatch) / Customer Rep at counter (walk-in) */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
              <Phone className="w-4 h-4 text-slate-500" />
              {pickupType === 'walk_in' ? 'Customer Rep' : 'Person Calling'} <span className="text-red-500">*</span>
            </h3>
            <p className="text-xs text-slate-500">
              {pickupType === 'walk_in'
                ? 'Person at the counter — will sign the liability waiver below.'
                : "Who phoned this in (customer's office, dispatcher, etc.)"}
            </p>
            <input
              type="text"
              value={personCallingName}
              onChange={e => setPersonCallingName(e.target.value)}
              placeholder="Name *"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="tel"
                value={personCallingPhone}
                onChange={e => setPersonCallingPhone(e.target.value)}
                placeholder="Phone"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
              <input
                type="email"
                value={personCallingEmail}
                onChange={e => setPersonCallingEmail(e.target.value)}
                placeholder="Email"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
          </div>

          {/* On-Site Contact — dispatch only */}
          {pickupType === 'dispatch' && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                <AtSign className="w-4 h-4 text-slate-500" /> On-Site Contact <span className="text-red-500">*</span>
              </h3>
              <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={siteContactSameAsCalling}
                  onChange={e => setSiteContactSameAsCalling(e.target.checked)}
                  className="w-3.5 h-3.5 accent-blue-600"
                />
                same as caller
              </label>
            </div>
            {!siteContactSameAsCalling && (
              <>
                <input
                  type="text"
                  value={siteContactName}
                  onChange={e => setSiteContactName(e.target.value)}
                  placeholder="Name *"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="tel"
                    value={siteContactPhone}
                    onChange={e => setSiteContactPhone(e.target.value)}
                    placeholder="Phone"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                  <input
                    type="email"
                    value={siteContactEmail}
                    onChange={e => setSiteContactEmail(e.target.value)}
                    placeholder="Email"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>
              </>
            )}
            {siteContactSameAsCalling && (
              <p className="text-xs text-slate-500 italic">Will copy from Person Calling on submit.</p>
            )}
          </div>
          )}

          {/* Billing + dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Start Date *</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Billing Rate *</label>
              <select
                value={billingRateType}
                onChange={e => setBillingRateType(e.target.value as 'daily' | 'weekly' | 'monthly')}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          </div>

          {/* #C PO/AFE/Cost-Code repeater — seeded from the profile, never
              required at dispatch (PO often unknown until deployment). */}
          <BillingRefsField refs={billingRefs} onChange={setBillingRefs} labels={billingLabels} />

          {/* #C Composition — stackable Trailer / Gas Monitor / Other (+ Drilling Rig).
              Dispatch-only: the tech composes the BOM for a delivered rental. A
              walk-in is the unit(s) the customer carries out, so it's serial-scan
              only (Equipment section below) — no by-type builder. */}
          {pickupType === 'dispatch' && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">What's on this rental?</h3>
            {/* #Wave4 Baseline package — the customer's saved BOM the flat rate
                covers. Standard by default; their Drilling package when Drilling
                Rig is on. Extras above this (monitors/other above) bill separately. */}
            <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/60">
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-sm font-medium text-slate-800 flex items-center gap-2"><Package className="w-4 h-4 text-slate-500" /> Baseline package</span>
                <input type="checkbox" checked={baselinePackageSelected} onChange={e => toggleBaselinePackage(e.target.checked)} className="w-4 h-4 accent-blue-600" />
              </label>
              {bomVariants.length > 1 && resolvedBom && (
                <select
                  aria-label="Package variant"
                  value={resolvedBom.id}
                  onChange={e => setSelectedBomId(e.target.value)}
                  className="mt-2 w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white"
                >
                  {bomVariants.map(b => (
                    <option key={b.id} value={b.id}>{bomDisplayName(b)}{b.isDefault ? ' (default)' : ''}</option>
                  ))}
                </select>
              )}
              <div className="mt-1">
                {resolvedBom && (
                  <span className="text-xs text-slate-400">
                    {bomVariants.length > 1 ? BOM_TYPE_LABELS[resolvedBom.bomType] : bomDisplayName(resolvedBom)}{resolvedBom.manned ? ` · ${resolvedBom.includedTechs} tech${resolvedBom.includedTechs === 1 ? '' : 's'} incl.` : ' · unmanned'}
                  </span>
                )}
              </div>
              {!baselinePackageSelected ? (
                <p className="mt-1 text-xs font-medium text-slate-600">Deselected — add and price items manually below. No package contents or charge will be included.</p>
              ) : !customer ? (
                <p className="mt-1 text-xs text-slate-400 italic">Pick a customer to load their package.</p>
              ) : resolvedBom ? (
                baselineItems.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {baselineItems.map((b, i) => (
                      <span key={i} className="text-xs bg-white border border-slate-200 text-slate-700 px-2 py-0.5 rounded-full">{b.qty}× {b.label}</span>
                    ))}
                  </div>
                ) : <p className="mt-1 text-xs text-slate-400 italic">Package has no items.</p>
              ) : drillingRig ? (
                <p className="mt-1 text-xs text-amber-600">No Drilling package on file for {customer.name} — no baseline requirement.</p>
              ) : (
                <p className="mt-1 text-xs text-slate-400 italic">No Standard package on file. Add one on the customer profile.</p>
              )}

              {/* The package's own charge — one line per billing period, seeded
                  from the bound item's rate and adjusted to the customer's
                  price level at invoice time. Gear beyond the list above bills
                  on top, resolved from what the tech actually scans at deploy. */}
              {packageRateLine && (
                packageRateLine.productId ? (
                  <div className="mt-3 pt-2 border-t border-slate-200 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{packageRateLine.label}</p>
                      <p className="text-[11px] text-slate-400">
                        Bills as one line per {rateUnitLong(billingRateType)}
                        {packageRateLine.priceLevel
                          ? <> · <span className="text-slate-500">{packageRateLine.priceLevel} price level</span></>
                          : <> · <span className="text-amber-600">list price — no level entry for this customer</span></>}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-slate-400 text-sm">$</span>
                      <input
                        type="number" step="0.01" min="0"
                        value={bomPackageRate ?? ''}
                        onChange={e => setBomPackageRate(e.target.value ? parseFloat(e.target.value) : null)}
                        placeholder="rate"
                        className="w-24 border border-slate-300 rounded px-2 py-1 text-sm text-right"
                      />
                      <span className="text-xs text-slate-400 w-8">{rateUnit}</span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 pt-2 border-t border-slate-200 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{packageRateLine.label}</p>
                      <p className="text-[11px] text-amber-600">
                        {resolvedBom
                          ? 'No billing item bound — uses the invoice fallback item.'
                          : 'No Standard package on file — uses the invoice fallback item.'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-slate-400 text-sm">$</span>
                      <input
                        type="number" step="0.01" min="0"
                        value={bomPackageRate ?? ''}
                        onChange={e => setBomPackageRate(e.target.value ? parseFloat(e.target.value) : null)}
                        placeholder="rate"
                        className="w-24 border border-slate-300 rounded px-2 py-1 text-sm text-right"
                      />
                      <span className="text-xs text-slate-400 w-8">{rateUnit}</span>
                    </div>
                  </div>
                )
              )}

              {baselinePackageSelected && <p className="mt-2 text-[11px] text-slate-400">
                {packageBills
                  ? 'The package bills as one line; anything deployed beyond the list bills on top.'
                  : resolvedBom
                    ? 'Package contents are tracked; enter a rate or price individual lines below.'
                    : 'Enter a rental rate here, or price individual lines below.'}
              </p>}
            </div>
            <div className="border border-slate-200 rounded-lg p-3">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm font-medium text-slate-800">Drilling Rig <span className="font-normal text-slate-500">— use this customer's Drilling package</span></span>
                  <input type="checkbox" checked={drillingRig} onChange={e => setDrillingRig(e.target.checked)} className="w-4 h-4 accent-blue-600" />
                </label>
              </div>

            {/* Everything below is ON TOP of the package. Labelled explicitly
                because the old order (trailer/monitors first, package last) read
                as a list of things the dispatcher still had to enter — when the
                package already covers them. */}
            {resolvedBom && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Additional</span>
                <span className="text-xs text-slate-400">beyond the package — usually nothing</span>
                <div className="flex-1 border-t border-slate-200" />
              </div>
            )}

            <div className="border border-slate-200 rounded-lg p-3">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm font-medium text-slate-800 flex items-center gap-2"><Truck className="w-4 h-4 text-slate-500" /> Trailer</span>
                  <input type="checkbox" checked={trailerOn} onChange={e => setTrailerOn(e.target.checked)} className="w-4 h-4 accent-blue-600" />
                </label>
                {trailerOn && (
                  <div className="mt-2 space-y-2">
                    <div className="flex gap-2">
                      {([true, false] as const).map(m => (
                        <button key={String(m)} type="button" onClick={() => setTrailerManned(m)} aria-pressed={trailerManned === m}
                          className={'flex-1 px-3 py-1.5 rounded border-2 text-sm font-medium ' + (trailerManned === m ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600 hover:border-slate-300')}>
                          {m ? 'Manned' : 'Unmanned'}
                        </button>
                      ))}
                    </div>
                    {/* A trailer the package already covers isn't a $0 extra —
                        it's part of what the package line charges for. Showing a
                        zero in a rate box reads like a mistake; say it instead.
                        Still overridable, for a second trailer beyond the one
                        the package includes. */}
                    {packageBills && trailerRate === 0 ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-slate-500">Covered by the package</span>
                        <button type="button" onClick={() => setTrailerRate(null)}
                          className="text-xs font-medium text-blue-600 hover:text-blue-700">Charge separately</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-slate-500">Rate</span>
                        <span className="text-xs text-slate-400">$</span>
                        <input type="number" min={0} value={trailerRate ?? ''} placeholder="rate"
                          onChange={e => setTrailerRate(e.target.value ? parseFloat(e.target.value) : null)}
                          className="w-24 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                        <span className="text-xs text-slate-400">/{rateUnit}</span>
                        {packageBills && (
                          <button type="button" onClick={() => setTrailerRate(0)}
                            className="text-xs font-medium text-blue-600 hover:text-blue-700 ml-1">included</button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

            {/* Gas Monitors — stackable, part from the QB monitor catalog */}
            <div className="border border-slate-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-800">Gas Monitors</span>
                <span className="text-xs text-slate-400">{gasMonitors.length} added</span>
              </div>
              {gasMonitors.map((g, idx) => (
                <div key={g.id} className="flex gap-2 items-center">
                  <select
                    value={g.productId}
                    onChange={e => {
                      const opt = monitorProducts.find(p => p.id === e.target.value)
                      // Seed the per-unit rate from the product's rental default for the chosen rate type.
                      const seeded = opt ? rateForProduct(opt) : null
                      setGasMonitors(rows => rows.map((r, i) => i === idx ? { ...r, productId: e.target.value, productName: opt?.name || '', rate: seeded, manualRate: false } : r))
                    }}
                    className="flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded text-sm bg-white"
                  >
                    <option value="">— pick monitor type —</option>
                    {monitorProducts.map(p => <option key={p.id} value={p.id}>{p.partNumber ? `${p.partNumber} — ` : ''}{p.name}</option>)}
                  </select>
                  <QuantityInput min={1} value={g.qty}
                    onChange={qty => setGasMonitors(rows => rows.map((r, i) => i === idx ? { ...r, qty } : r))}
                    className="w-16 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-slate-400">$</span>
                    <input type="number" min={0} value={g.rate ?? ''} placeholder="rate"
                      onChange={e => { const v = e.target.value ? parseFloat(e.target.value) : null; setGasMonitors(rows => rows.map((r, i) => i === idx ? { ...r, rate: v, manualRate: true } : r)) }}
                      className="w-20 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                    <span className="text-xs text-slate-400">/{rateUnit}</span>
                  </div>
                  <button type="button" onClick={() => setGasMonitors(rows => rows.filter((_, i) => i !== idx))} className="text-slate-400 hover:text-red-600 px-1"><X className="w-4 h-4" /></button>
                </div>
              ))}
              <button type="button" onClick={() => setGasMonitors(rows => [...rows, { id: uuidv4(), productId: '', productName: '', qty: 1, rate: null }])} className="text-sm font-medium text-blue-600 hover:text-blue-700">+ Add gas monitor</button>
            </div>

            {/* QB-backed additional items, with a manual option for custom charges. */}
            <div className="border border-slate-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-800">Other</span>
                <span className="text-xs text-slate-400">{otherItems.length} added</span>
              </div>
              <ProductSearch
                division={4}
                priceLevels={rentalPriceLevels}
                placeholder="Search QB item or part # to add…"
                onSelect={product => setOtherItems(rows => [...rows, {
                  id: uuidv4(), productId: product.id, catalogProduct: product,
                  label: product.name, qty: 1, rate: rateForProduct(product), manualRate: false,
                }])}
              />
              {otherItems.map((o, idx) => (
                <div key={o.id} className="flex gap-2 items-center">
                  <input type="text" value={o.label} placeholder="Wind sock, signage, …"
                    onChange={e => setOtherItems(rows => rows.map((r, i) => i === idx ? { ...r, label: e.target.value } : r))}
                    className="flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                  <QuantityInput min={1} value={o.qty}
                    onChange={qty => setOtherItems(rows => rows.map((r, i) => i === idx ? { ...r, qty } : r))}
                    className="w-16 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-slate-400">$</span>
                    <input type="number" min={0} value={o.rate ?? ''} placeholder="rate"
                      onChange={e => { const v = e.target.value ? parseFloat(e.target.value) : null; setOtherItems(rows => rows.map((r, i) => i === idx ? { ...r, rate: v, manualRate: true } : r)) }}
                      className="w-20 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                    <span className="text-xs text-slate-400">/{rateUnit}</span>
                  </div>
                  <button type="button" onClick={() => setOtherItems(rows => rows.filter((_, i) => i !== idx))} className="text-slate-400 hover:text-red-600 px-1"><X className="w-4 h-4" /></button>
                </div>
              ))}
              <button type="button" onClick={() => setOtherItems(rows => [...rows, { id: uuidv4(), label: '', qty: 1, rate: null }])} className="text-sm font-medium text-blue-600 hover:text-blue-700">+ Add other</button>
            </div>



          </div>
          )}

          {/* Walk-in: Equipment */}
          {pickupType === 'walk_in' && (
            <div className="bg-emerald-50/40 border border-emerald-200 rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                  <Package className="w-4 h-4 text-emerald-700" /> Equipment <span className="text-red-500">*</span>
                </h3>
                <span className="text-xs text-slate-500">{walkInItems.length} item{walkInItems.length !== 1 ? 's' : ''}</span>
              </div>

              {walkInItems.length > 0 && (
                <div className="space-y-2">
                  {walkInItems.map((item, idx) => (
                    <div key={item.id} className="bg-white rounded-md border border-slate-200 p-3">
                      <div className="flex items-start gap-3">
                        <span className="text-xs font-mono text-slate-400 mt-0.5">{idx + 1}.</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate">{item.productName}</p>
                          <p className="text-xs text-slate-500 font-mono">{item.serialNumber}</p>
                          <div className="flex items-center gap-2 mt-1.5">
                            <DollarSign className="w-3 h-3 text-slate-400" />
                            <input
                              type="number"
                              value={item.rate ?? ''}
                              onChange={e => {
                                const val = e.target.value ? parseFloat(e.target.value) : null
                                setWalkInItems(prev => prev.map((it, i) => i === idx ? { ...it, rate: val } : it))
                              }}
                              placeholder="Rate"
                              className="w-24 px-2 py-1 border border-slate-200 rounded text-sm"
                            />
                            <span className="text-xs text-slate-500">/ {item.rateType}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setWalkInItems(prev => prev.filter((_, i) => i !== idx))}
                          className="p-1 text-slate-400 hover:text-red-500"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowEquipmentScanner(true)}
                className="w-full flex items-center justify-center gap-2 py-2.5 border-2 border-dashed border-emerald-300 rounded-md text-sm font-medium text-emerald-700 hover:border-emerald-500 hover:bg-emerald-50 transition-colors"
              >
                <Package className="w-4 h-4" />
                Scan / Add Equipment
              </button>
            </div>
          )}

          {/* Walk-in: Liability waiver */}
          {pickupType === 'walk_in' && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4" /> Equipment Liability Waiver <span className="text-red-500">*</span>
              </h3>
              <p className="text-xs text-amber-800 leading-relaxed">
                By signing below, the customer accepts full responsibility for the care and condition of
                the rented equipment listed above. The customer agrees to be liable for any damage, loss,
                or destruction beyond normal wear and tear during the rental period. Repair or replacement
                costs will be billed to the customer account if equipment is returned damaged or non-operational.
              </p>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={liabilityAcknowledged}
                  onChange={e => setLiabilityAcknowledged(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-slate-700">
                  Customer has read and accepts the liability waiver above
                </span>
              </label>

              <SignaturePad
                label={`Signature — ${personCallingName.trim() || 'Customer Rep'}`}
                value={liabilitySignature}
                onChange={setLiabilitySignature}
              />
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Dispatch Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Any details for the tech (special instructions, gate codes, contact preferences, etc.)"
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          {baseValid && !compositionPriced && (
            <span className="mr-auto text-xs text-amber-700">Set a rate on every line before dispatching.</span>
          )}
          <button
            onClick={close}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className={
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50 ' +
              (pickupType === 'walk_in' ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-blue-700 hover:bg-blue-600')
            }
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {pickupType === 'walk_in' ? 'Sign & Deploy' : 'Dispatch Rental'}
          </button>
        </div>
      </div>

      {showEquipmentScanner && (
        <EquipmentScanner
          filterStatus="available"
          allowCreate
          onEquipmentFound={addEquipment}
          onClose={() => setShowEquipmentScanner(false)}
        />
      )}
    </div>
  )
}
