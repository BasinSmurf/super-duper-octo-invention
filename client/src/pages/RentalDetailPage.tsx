import { useSync } from '@/contexts/SyncContext'
import type { ManualRentalEquipment } from '@/lib/db-types'
import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { db } from '@/lib/db'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { usePermissions } from '@/contexts/PermissionsContext'
import { ConfirmDestructiveDialog } from '@/components/ConfirmDestructiveDialog'
import { rateUnitAbbrev, rateUnitLong, hasRate } from '@/lib/rentalRates'
import { CustomerSearch } from '@/components/CustomerSearch'
import { ProductSearch } from '@/components/ProductSearch'
import { useCompanyPriceLevels } from '@/lib/priceLevels'
import { loadRentalMonitors, rentalCatalogRate, repriceRentalRows, type RentalCatalogProduct } from '@/lib/rentalCatalog'
import { LocationPicker, type LocationSelection } from '@/components/LocationPicker'
import { DeployInspectionModal } from '@/components/DeployInspectionModal'
import { resolveDeployCategory, type DeployInspectionResult } from '@/lib/deployChecklist'
import { RentalInspectionEditor, type InspectionData } from '@/components/RentalInspectionEditor'
import { EquipmentScanner, type ScannedEquipment } from '@/components/EquipmentScanner'
import { LiveClock } from '@/components/LiveClock'
import { JobTypePillRow } from '@/components/JobTypePills'
import { RentalBillingSettings } from '@/components/RentalBillingSettings'
import { BomExtrasEditor } from '@/components/BomExtrasEditor'
import { type RentalBom, EQUIP_CAT_LABEL, bomDisplayName, bomPackageLine, netAlreadyLined, switchPackageComposition } from '@/lib/rentalBom'
import {
  ArrowLeft,
  Package,
  Loader2,
  Calendar,
  DollarSign,
  CheckCircle2,
  RotateCcw,
  ClipboardList,
  ChevronRight,
  Phone,
  User,
  Mail,
  Plus,
  MapPin,
  Pencil,
  Save,
  X,
  FileDown,
  Trash2,
} from 'lucide-react'
import type { OfflineRentalAgreement, OfflineRentalAgreementItem, RentalPic } from '@/lib/db-types'
import { formatCalendarDateNumeric } from '@/lib/dates'

// #1 "sup+ can change ANYTHING" — full working copy of the agreement for the
// edit panel. Built in openEdit(), submitted as one PUT with a required reason.
interface EditForm {
  customer: { id: string; name: string; companyType: string; city: string | null; state: string | null } | null
  location: LocationSelection
  locationTouched: boolean
  startDate: string
  rateType: 'daily' | 'weekly' | 'monthly'
  cadence: 'daily' | 'weekly' | 'monthly'
  po: string
  afe: string
  notes: string
  pcName: string; pcPhone: string; pcEmail: string
  scName: string; scPhone: string; scEmail: string
  compTouched: boolean
  trailerOn: boolean; trailerManned: boolean; trailerRate: number | null
  monitors: { id: string; productId: string; productName: string; qty: number; rate: number | null; manualRate?: boolean }[]
  other: { id: string; label: string; productId?: string | null; catalogProduct?: RentalCatalogProduct; qty: number; rate: number | null; manualRate?: boolean }[]
  rig: boolean
  // On-job package switch. undefined = keep the package the rental has;
  // a package id = move to that variant; null = drop the package entirely.
  // Takes effect from effectiveDate as a new composition window, so days
  // already on the old package keep billing at the old package's rate.
  packageId?: string | null
  effectiveDate: string
  compositionCorrection: boolean
  pics: RentalPic[]
  reason: string
}

const centralToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

interface LinkedTicket {
  id: string
  ticketNumber: string
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  dispatchNotes: string | null
  workDescription: string | null
  internalNotes: string | null
  assignedTechName: string | null
}

interface AgreementDetail extends OfflineRentalAgreement {
  items: Array<OfflineRentalAgreementItem & {
    productName?: string
    serialNumber?: string
    productCategory?: string
  }>
  linkedTickets?: LinkedTicket[]
  // Denormalized location names (from API include) — multiple jobs per company,
  // so the well/pad is what actually identifies this rental.
  fieldName?: string | null
  padName?: string | null
  wellName?: string | null
  billingCadence?: string
  isFullyBilled?: boolean
  lastBilledThrough?: string | null
}

interface LinkedInvoice {
  id: string
  invoiceNumber: string
  status: string
  periodStart: string | null
  periodEnd: string | null
}

export function RentalDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { syncState, enabled: offlineEnabled } = useSync()
  const { can } = usePermissions()
  const canEdit = hasPermission(user?.role, 'rentals:edit')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  async function handleDelete({ reason, override }: { reason: string; override: boolean }) {
    setDeleteBusy(true)
    try {
      const res = await api.delete<{ warnings?: string[] }>(`/rentals/${id}`, { reason, override })
      try { await db.rentalAgreements.delete(id as string) } catch { /* offline cache */ }
      if (res?.warnings?.length) alert(res.warnings.join('\n'))
      navigate('/rentals')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete rental')
      setDeleteBusy(false)
    }
  }
  const [agreement, setAgreement] = useState<AgreementDetail | null>(null)
  const agreementLoadRequest = useRef(0)
  // #1 Edit-with-reason: field_super / billing_ar / boss / admin can correct
  // ANYTHING on an existing rental. The reason is appended to notes as an
  // informal audit line.
  const [edit, setEdit] = useState<EditForm | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [monitorProducts, setMonitorProducts] = useState<RentalCatalogProduct[]>([])
  // The customer's saved packages, for the on-job "Change package" picker.
  const [customerPackages, setCustomerPackages] = useState<RentalBom[]>([])
  const { levels: editPriceLevels } = useCompanyPriceLevels(edit?.customer?.id)
  useEffect(() => {
    setEdit(previous => previous ? { ...previous,
      monitors: repriceRentalRows(previous.monitors, monitorProducts, previous.rateType, editPriceLevels),
      other: previous.other.map(row => row.catalogProduct && !row.manualRate
        ? { ...row, rate: rentalCatalogRate(row.catalogProduct, previous.rateType, editPriceLevels) } : row),
    } : previous)
  }, [edit?.rateType, monitorProducts, editPriceLevels])
  const patchEdit = (p: Partial<EditForm>) => setEdit(prev => prev ? { ...prev, ...p } : prev)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [linkedInvoices, setLinkedInvoices] = useState<LinkedInvoice[]>([])
  const [returningItem, setReturningItem] = useState<OfflineRentalAgreementItem | null>(null)
  const [completing, setCompleting] = useState(false)
  const [returnDate, setReturnDate] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))
  const [finalBillReady, setFinalBillReady] = useState(false)
  // #2 Redeploy / Add Gear: each scan posts a dated deployment event.
  const [replacesItemId, setReplacesItemId] = useState('')
  const [showRedeploy, setShowRedeploy] = useState(false)
  const [showRedeployScanner, setShowRedeployScanner] = useState(false)
  const [redeployDate, setRedeployDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [addingGear, setAddingGear] = useState(false)
  // #20 scanned gear waiting on its required deploy inspection
  const [pendingGear, setPendingGear] = useState<ScannedEquipment | null>(null)

  useEffect(() => {
    if (!id) return
    api.get<{ data: LinkedInvoice[] }>(`/invoices?rentalAgreementId=${id}`)
      .then(res => setLinkedInvoices(res.data || []))
      .catch(() => setLinkedInvoices([]))
  }, [id])

  useEffect(() => {
    if (!id) return
    const refresh = () => { void loadAgreement(id) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [id, syncState.lastSyncedAt])
  useEffect(() => { if (id) void loadAgreement(id) }, [id, syncState.lastSyncedAt])

  async function loadAgreement(agreementId: string) {
    const request = ++agreementLoadRequest.current
    try {
      // Try Dexie first
      const local = await db.rentalAgreements.get(agreementId)
      const localItems = await db.rentalAgreementItems
        .where('rentalAgreementId')
        .equals(agreementId)
        .toArray()

      if (local) {
        // Enrich items with product/equipment names from Dexie
        const enrichedItems = await Promise.all(
          localItems.map(async item => {
            const product = item.productId ? await db.products.get(item.productId) : null
            const equip = item.serializedEquipmentId ? await db.equipment.get(item.serializedEquipmentId) : null
            return {
              ...item,
              productName: item.productName || product?.name || 'Unknown Product',
              serialNumber: item.serialNumber || equip?.serialNumber || '?',
              productCategory: product?.category || '',
            }
          })
        )
        if (request === agreementLoadRequest.current) setAgreement({ ...local, items: enrichedItems })
        setLoading(false)
      }

      // Pending local deployment owns the visible state until the outbox lands.
      if (local?._offlineStatus === 'pending') { setLoading(false); return }
      // Try API for fresh data
      try {
        const apiData = await api.get<any>(`/rentals/${agreementId}`)
        if (apiData?.id) {
          const detail: AgreementDetail = {
            id: apiData.id,
            agreementNumber: apiData.agreementNumber,
            companyId: apiData.companyId,
            companyName: apiData.company?.name || '',
            fieldId: apiData.fieldId,
            padId: apiData.padId,
            wellId: apiData.wellId,
            fieldName: apiData.field?.name || null,
            padName: apiData.pad?.name || null,
            wellName: apiData.well?.wellName || null,
            visitEquipment: apiData.visitEquipment,
            status: apiData.status,
            pickupType: apiData.pickupType || 'dispatch',
            startDate: apiData.startDate,
            endDate: apiData.endDate,
            billingRateType: apiData.billingRateType,
            billingPolicy: apiData.billingPolicy,
            billingCadence: apiData.billingCadence || 'monthly',
            isFullyBilled: apiData.isFullyBilled ?? false,
            lastBilledThrough: apiData.lastBilledThrough ?? null,
            poNumber: apiData.poNumber || '',
            afeNumber: apiData.afeNumber || '',
            notes: apiData.notes || '',
            isManned: apiData.isManned ?? true,
            isRigJob: apiData.isRigJob ?? false,
            monitorsIncluded: apiData.monitorsIncluded ?? false,
            liabilityAcknowledged: apiData.liabilityAcknowledged ?? false,
            liabilitySignedByName: apiData.liabilitySignedByName || '',
            liabilitySignature: apiData.liabilitySignature || null,
            liabilitySignedAt: apiData.liabilitySignedAt || null,
            siteContactName: apiData.siteContactName || '',
            siteContactPhone: apiData.siteContactPhone || '',
            siteContactEmail: apiData.siteContactEmail || '',
            personCallingName: apiData.personCallingName || null,
            personCallingPhone: apiData.personCallingPhone || null,
            personCallingEmail: apiData.personCallingEmail || null,
            pics: apiData.pics || null,
            composition: apiData.composition || null,
            createdAt: apiData.createdAt,
            updatedAt: apiData.updatedAt,
            items: (apiData.items || []).map((item: any) => ({
              id: item.id,
              rentalAgreementId: item.rentalAgreementId,
              productId: item.productId,
              productName: item.product?.name || item.productName || 'Unknown',
              serializedEquipmentId: item.serializedEquipmentId,
              serialNumber: item.serializedEquipment?.serialNumber || item.serialNumber || '?',
              productCategory: item.product?.category || '',
              rate: item.rate ? Number(item.rate) : null,
              rateType: item.rateType,
              deployedDate: item.deployedDate,
              returnedDate: item.returnedDate,
              status: item.status,
            })),
            linkedTickets: (apiData.linkedServiceTickets || []).map((t: any) => ({
              id: t.id,
              ticketNumber: t.ticketNumber,
              ticketType: t.ticketType,
              serviceSubtype: t.serviceSubtype || null,
              status: t.status,
              serviceDate: t.serviceDate,
              dispatchNotes: t.dispatchNotes || null,
              workDescription: t.workDescription || null,
              internalNotes: t.internalNotes || null,
              assignedTechName: t.assignedTech?.name || null,
            })),
          }
          if (request === agreementLoadRequest.current) setAgreement(detail)
        }
      } catch {
        // Offline — use local data
      }
    } catch {
      setError('Could not load rental agreement')
    }
    setLoading(false)
  }

  async function openEdit() {
    if (!agreement) return
    setError('')
    // Seed the location picker with the current selection from Dexie (best
    // effort — a miss just means the picker starts empty and untouched).
    let loc: LocationSelection = { field: null, pad: null, wells: [] }
    try {
      // Seed all selected wells (wellIds), falling back to the legacy single wellId.
      const wellIds = (agreement.wellIds && agreement.wellIds.length)
        ? agreement.wellIds
        : (agreement.wellId ? [agreement.wellId] : [])
      const [field, pad, wells] = await Promise.all([
        agreement.fieldId ? db.fields.get(agreement.fieldId) : null,
        agreement.padId ? db.pads.get(agreement.padId) : null,
        wellIds.length ? db.wells.where('id').anyOf(wellIds).toArray() : Promise.resolve([]),
      ])
      loc = {
        field: field ? { id: field.id, name: field.name } : null,
        pad: pad ? { id: pad.id, name: pad.name, fieldId: pad.fieldId } : null,
        wells: wells.map(w => ({ id: w.id, wellName: w.wellName || '', padId: w.padId || '' })),
      }
    } catch { /* picker starts empty */ }
    // Use the same QB catalog and pricing as new à la carte rentals.
    try { setMonitorProducts(await loadRentalMonitors()) }
    catch { setMonitorProducts([]) }
    try { setCustomerPackages(await api.get<RentalBom[]>(`/companies/${agreement.companyId}/rental-boms`) || []) }
    catch { setCustomerPackages([]) }

    const comp = agreement.composition
    setEdit({
      customer: { id: agreement.companyId, name: agreement.companyName || '', companyType: '', city: null, state: null },
      location: loc,
      locationTouched: false,
      startDate: agreement.startDate?.split('T')[0] || '',
      rateType: (agreement.billingRateType as EditForm['rateType']) || 'daily',
      cadence: (agreement.billingCadence as EditForm['cadence']) || 'monthly',
      po: agreement.poNumber || '',
      afe: agreement.afeNumber || '',
      notes: agreement.notes || '',
      pcName: agreement.personCallingName || '', pcPhone: agreement.personCallingPhone || '', pcEmail: agreement.personCallingEmail || '',
      scName: agreement.siteContactName || '', scPhone: agreement.siteContactPhone || '', scEmail: agreement.siteContactEmail || '',
      compTouched: false,
      trailerOn: !!comp?.trailer,
      trailerManned: comp?.trailer?.manned ?? true,
      trailerRate: comp?.trailer?.rate ?? null,
      monitors: (comp?.gasMonitors || []).map(g => ({ id: g.id, productId: g.productId, productName: g.productName || '', qty: g.qty, rate: g.rate ?? null, manualRate: true })),
      other: (comp?.other || []).map(o => ({ id: o.id, productId: o.productId, label: o.label, qty: o.qty, rate: o.rate ?? null, manualRate: true })),
      rig: !!comp?.drillingRig,
      packageId: undefined,
      effectiveDate: centralToday(),
      compositionCorrection: false,
      pics: (agreement.pics || []).map(p => ({ ...p })),
      reason: '',
    })
  }

  // The package the edit would switch TO (undefined = no switch requested).
  const switchTarget = edit?.packageId ? customerPackages.find(b => b.id === edit.packageId) ?? null : null

  /**
   * The package-related composition fields for the next window. Without a
   * switch they carry through untouched (rebuilding without them would
   * silently delete a charge). With one, the roster, the package line, and the
   * over-baseline extras are all rebuilt against the new package — extras are
   * re-diffed from what's on site NOW, so gear the new package covers stops
   * billing as an overage on the switch date.
   */
  function packageFieldsForSave(): Record<string, unknown> {
    const comp = agreement?.composition
    if (!edit || edit.packageId === undefined) {
      return {
        ...(comp?.bom ? { bom: comp.bom } : {}),
        ...(comp?.bomType ? { bomType: comp.bomType } : {}),
        ...(comp?.bomPackage ? { bomPackage: comp.bomPackage } : {}),
        ...(comp?.bomExtras ? { bomExtras: comp.bomExtras } : {}),
      }
    }
    if (edit.packageId === null || !switchTarget) return {}
    // On site now, minus gear already carried on its own priced line.
    const onSite = (agreement?.items || [])
      .filter(i => !i.returnedDate && i.status !== 'returned')
      .map(i => i.productCategory || null)
    const lined = new Map<string, number>()
    for (const m of edit.monitors) {
      const cat = monitorProducts.find(p => p.id === m.productId)?.category
      if (cat) lined.set(cat, (lined.get(cat) || 0) + (m.qty || 1))
    }
    const next = switchPackageComposition(switchTarget, edit.rateType, netAlreadyLined(onSite, lined))
    return {
      bom: next.bom,
      bomType: next.bomType,
      ...(next.bomPackage ? { bomPackage: next.bomPackage } : {}),
      ...(next.bomExtras.length ? { bomExtras: next.bomExtras } : {}),
    }
  }

  // #5 When the composition is being edited, every present line needs a rate
  // (0 = free/included). Mirrors the dispatch dialog so a sup is told up-front
  // rather than AR hitting the server's fail-loud guard at invoice time.
  function compositionEditIncomplete(): boolean {
    if (!edit?.compTouched) return false
    if (switchTarget && !hasRate(bomPackageLine(switchTarget, edit.rateType)?.rate)) return true
    return (edit.trailerOn && !hasRate(edit.trailerRate))
      || edit.monitors.some(m => m.productId && !hasRate(m.rate))
      || edit.other.some(o => o.label.trim() && !hasRate(o.rate))
  }

  async function handleSaveEdit() {
    if (!agreement || !id || !edit) return
    if (!edit.reason.trim()) {
      setError('A reason for the edit is required.')
      return
    }
    if (compositionEditIncomplete()) {
      setError('Set a rate on every ordered line before saving (0 = free/included).')
      return
    }
    const companyChanged = !!edit.customer && edit.customer.id !== agreement.companyId
    if (companyChanged && !confirm(
      `Move this rental from ${agreement.companyName || 'current customer'} to ${edit.customer!.name}?\n\nFuture invoices will bill the new customer. Already-generated invoices keep the old one.`
    )) return

    setSavingEdit(true)
    setError('')
    // Append an informal audit line to notes (no audit-history UI by design).
    const stamp = new Date().toLocaleDateString()
    const who = user?.name || user?.email || 'unknown'
    const auditLine = `— edited ${stamp} by ${who}: ${edit.reason.trim()}`
    const composedNotes = [edit.notes.trim(), auditLine].filter(Boolean).join('\n')

    const payload: any = {
      poNumber: edit.po.trim(),
      afeNumber: edit.afe.trim(),
      notes: composedNotes,
      startDate: edit.startDate || undefined,
      billingRateType: edit.rateType,
      billingCadence: edit.cadence,
      personCallingName: edit.pcName.trim(), personCallingPhone: edit.pcPhone.trim(), personCallingEmail: edit.pcEmail.trim(),
      siteContactName: edit.scName.trim(), siteContactPhone: edit.scPhone.trim(), siteContactEmail: edit.scEmail.trim(),
      pics: edit.pics.filter(p => p.name.trim()),
    }
    // Location goes out when touched or when the customer moved (the old
    // field/pad/well belong to the old company — server requires it then).
    if (edit.locationTouched || companyChanged) {
      payload.fieldId = edit.location.field?.id ?? null
      payload.padId = edit.location.pad?.id ?? null
      payload.wellId = edit.location.wells[0]?.id ?? null
      payload.wellIds = edit.location.wells.map(w => w.id)
    }
    if (companyChanged) payload.companyId = edit.customer!.id
    // Composition: only rebuild when touched — never silently flip a legacy
    // per-item rental onto composition billing.
    if (edit.compTouched) {
      payload.effectiveDate = edit.effectiveDate || centralToday()
      payload.compositionCorrection = edit.compositionCorrection
      payload.reason = edit.reason.trim()
      payload.composition = {
        ...(agreement.composition?.manualEquipment ? { manualEquipment: agreement.composition.manualEquipment } : {}),
        trailer: edit.trailerOn ? { manned: edit.trailerManned, rate: edit.trailerRate } : null,
        gasMonitors: edit.monitors.filter(m => m.productId).map(m => ({
          id: m.id, productId: m.productId, productName: m.productName, qty: m.qty || 1, rate: m.rate,
        })),
        other: edit.other.filter(o => o.label.trim()).map(o => ({ id: o.id, productId: o.productId, label: o.label.trim(), qty: o.qty || 1, rate: o.rate })),
        drillingRig: edit.rig,
        // The package roster, its billable line, and the over-baseline extras:
        // carried through untouched unless the package is being switched.
        ...packageFieldsForSave(),
      }
    }

    try {
      await api.put(`/rentals/${id}`, payload)
      try {
        await db.rentalAgreements.update(id, {
          poNumber: payload.poNumber, afeNumber: payload.afeNumber, notes: composedNotes,
          ...(companyChanged ? { companyId: edit.customer!.id, companyName: edit.customer!.name } : {}),
          _offlineStatus: 'synced',
        })
      } catch { /* dexie miss ok */ }
      setEdit(null)
      await loadAgreement(id) // refresh names (well/pad/company) from the API include
    } catch (e: any) {
      setError(e?.message || 'Could not save changes — try again.')
    }
    setSavingEdit(false)
  }

  async function persistReturnedItem(item: OfflineRentalAgreementItem, inspectionData: InspectionData) {
    if (!id || !returnDate) throw new Error('Choose a return date')
    let pending = false
    try {
      await api.patch(`/rentals/${id}/items/${item.id}/return`, { inspectionData, returnedDate: returnDate })
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) throw err
      if (!offlineEnabled) throw new Error('Connect to the server to save this return. This account does not run offline sync.')
      pending = true
    }
    const now = new Date().toISOString()
    if (pending) await db.mutationQueue.add({ table: 'rentalAgreementItems', action: 'update', entityId: item.id,
      payload: { status: 'returned', returnedDate: returnDate, inspectionData }, createdAt: now, status: 'pending', retryCount: 0 })
    await db.rentalAgreementItems.update(item.id, { status: 'returned', returnedDate: returnDate,
      _offlineStatus: pending ? 'pending' : 'synced' })
    await db.equipment.update(item.serializedEquipmentId, { status: 'available', currentRentalId: null, currentCustomerId: null })
  }

  async function handleReturnItem(item: OfflineRentalAgreementItem, inspectionData: InspectionData) {
    if (!agreement || !id) return
    try {
      await persistReturnedItem(item, inspectionData)
      if (agreement.items.filter(i => i.status === 'deployed' && i.id !== item.id).length === 0 && (agreement.composition?.manualEquipment || []).every(row => row.status === 'returned')) await completeAgreement()
      setReturningItem(null)
      await loadAgreement(id)
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to return item') }
  }

  async function completeAgreement() {
    if (!id || !returnDate) throw new Error('Choose a close date')
    const now = new Date().toISOString()
    let pending = false
    try { await api.patch(`/rentals/${id}/complete`, { endDate: returnDate }) }
    catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) throw err
      if (!offlineEnabled) throw new Error('Connect to the server to save this return. This account does not run offline sync.')
      pending = true
    }
    if (pending) await db.mutationQueue.add({ table: 'rentalAgreements', action: 'update', entityId: id,
      payload: { status: 'completed', endDate: returnDate }, createdAt: now, status: 'pending', retryCount: 0 })
    await db.rentalAgreements.update(id, { status: 'completed', endDate: returnDate, updatedAt: now,
      _offlineStatus: pending ? 'pending' : 'synced' })
    setFinalBillReady(!pending)
  }

  // #2 Redeploy: add a scanned piece of gear as a dated deployment event.
  // Online-first (direct POST, with assembly expansion); offline falls back to
  // #20 QA gate: the scanner hands off here; the actual POST happens in
  // performAddGear once the required inspection completes.
  function handleAddGear(equip: ScannedEquipment) {
    if (!id || !agreement) return
    // Already on this rental? skip.
    if (agreement.items.some(i => i.serializedEquipmentId === equip.id && i.status === 'deployed')) {
      setShowRedeployScanner(false)
      return
    }
    setShowRedeployScanner(false)
    setPendingGear(equip)
  }

  // Dexie + a queued create so the deployedDate (backdatable) still syncs later.
  // Single create path per item — no double-create.
  async function performAddGear(equip: ScannedEquipment, inspection: DeployInspectionResult) {
    if (!id || !agreement) return
    const getRate = (prod: { defaultRentalRateDaily?: number | null; defaultRentalRateWeekly?: number | null; defaultRentalRateMonthly?: number | null }) => {
      if (agreement.billingRateType === 'daily') return prod.defaultRentalRateDaily ?? null
      if (agreement.billingRateType === 'weekly') return prod.defaultRentalRateWeekly ?? null
      if (agreement.billingRateType === 'monthly') return prod.defaultRentalRateMonthly ?? null
      return null
    }
    const itemId = uuidv4()
    setAddingGear(true)
    setError('')
    try {
      // ONLINE path — post the parent, then any available assembly children.
      const parentItem = await api.post<{ id: string }>(`/rentals/${id}/items`, {
        id: itemId, replacesItemId: replacesItemId || undefined,
        serializedEquipmentId: equip.id,
        productId: equip.productId,
        rate: getRate(equip.product),
        rateType: agreement.billingRateType,
        deployedDate: redeployDate,
        deployInspection: inspection,
      })
      if (equip.product.isAssembly) {
        try {
          const childRes = await api.get<{ data: Array<{ id: string; productId: string; status: string }> }>(`/equipment/${equip.id}/children`)
          for (const child of childRes.data) {
            if (child.status !== 'available') continue
            if (agreement.items.some(i => i.serializedEquipmentId === child.id && i.status === 'deployed')) continue
            const childProd = await db.products.get(child.productId)
            await api.post(`/rentals/${id}/items`, {
              serializedEquipmentId: child.id,
              productId: child.productId,
              rate: childProd ? getRate(childProd) : null,
              rateType: agreement.billingRateType,
              deployedDate: redeployDate,
              // Children of an assembly are covered by the parent's inspection.
              deployInspection: {
                category: 'general',
                answers: {},
                flagged: false,
                notes: '',
                inspectedAt: inspection.inspectedAt,
                inspectedBy: inspection.inspectedBy,
                coveredBy: parentItem.id,
              },
            })
          }
        } catch {
          // children fetch/post failed — parent still landed
        }
      }
      setShowRedeploy(false)
      loadAgreement(id)
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        setError(error.message)
        return
      }
      // OFFLINE fallback — parent only, via Dexie + queued create.
      try {
        const now = new Date().toISOString()
        await db.rentalAgreementItems.add({
          id: itemId,
          rentalAgreementId: id,
          productId: equip.productId,
          productName: equip.product.name,
          serializedEquipmentId: equip.id,
          serialNumber: equip.serialNumber,
          rate: getRate(equip.product),
          rateType: agreement.billingRateType,
          deployedDate: redeployDate,
          returnedDate: null,
          status: 'deployed',
          _offlineStatus: 'pending',
        })
        await db.equipment.update(equip.id, {
          status: 'rented',
          currentRentalId: id,
          currentCustomerId: agreement.companyId,
        })
        await db.mutationQueue.add({
          table: 'rentalAgreementItems',
          action: 'create',
          entityId: itemId,
          payload: {
            replacesItemId: replacesItemId || undefined,
            deployInspection: inspection,
            rentalAgreementId: id,
            productId: equip.productId,
            serializedEquipmentId: equip.id,
            rate: getRate(equip.product),
            rateType: agreement.billingRateType,
            deployedDate: redeployDate,
            status: 'deployed',
          },
          createdAt: now,
          status: 'pending',
          retryCount: 0,
        })
        setShowRedeployScanner(false)
        setShowRedeploy(false)
        loadAgreement(id)
      } catch (e2) {
        setError(e2 instanceof Error ? e2.message : 'Failed to add gear')
      }
    } finally {
      setAddingGear(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    )
  }

  if (!agreement) {
    return (
      <div className="text-center py-20 text-slate-400">
        <p className="font-medium">{error || 'Rental agreement not found'}</p>
        <button onClick={() => navigate('/rentals')} className="mt-3 text-blue-600 text-sm font-medium">
          Back to Rentals
        </button>
      </div>
    )
  }

  const visitEquipment: ManualRentalEquipment[] = agreement.visitEquipment || [
    ...(agreement.composition?.manualEquipment || []),
    ...agreement.items.map(item => ({ id: item.id, serial: item.serialNumber || '', type: item.productName || 'Equipment', testDate: item.deployInspection?.testDate || '',
      deployedAt: item.deployedDate, status: item.status === 'returned' ? 'returned' as const : 'deployed' as const, returnedAt: item.returnedDate || undefined })),
  ]
  const deployedVisitCount = visitEquipment.filter(item => item.status !== 'returned').length
  const deployedCount = agreement.items.filter(i => i.status === 'deployed').length
  const returnedCount = agreement.items.filter(i => i.status === 'returned').length

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/rentals')} className="p-2 -ml-2 text-slate-600 hover:text-slate-900">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2 flex-wrap">
            {agreement.companyName}
            {agreement.pickupType === 'walk_in' && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                Walk-in
              </span>
            )}
          </h1>
          {/* Location — well/pad identifies the job (multiple rentals per company) */}
          {(agreement.wellName || agreement.padName) && (
            <p className="text-sm text-slate-700 flex items-center gap-1.5 mt-0.5">
              <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="truncate">
                {agreement.padName}
                {agreement.wellName && (
                  <span className="font-semibold text-slate-900">
                    {agreement.padName ? ' › ' : ''}{agreement.wellName}
                  </span>
                )}
              </span>
            </p>
          )}
          <JobTypePillRow agreement={agreement} className="mt-1" />
          <p className="text-xs text-slate-400 font-mono mt-1">{agreement.agreementNumber || 'Pending...'}</p>
          {/* #A live clock + device timezone — "what zone are we in" */}
          <LiveClock className="text-xs mt-0.5" />
        </div>
        <span className={cn(
          'text-xs font-medium px-2.5 py-1 rounded-full',
          agreement.status === 'active' ? 'bg-green-100 text-green-700' :
          agreement.status === 'completed' ? 'bg-slate-100 text-slate-600' :
          'bg-red-100 text-red-700',
        )}>
          {agreement.status}
        </span>
        <button
          type="button"
          onClick={async () => {
            try {
              const token = localStorage.getItem('sundog_token')
              const res = await fetch(`/api/rentals/${id}/pdf`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              })
              if (!res.ok) throw new Error('PDF export failed')
              const blob = await res.blob()
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `rental-${agreement.agreementNumber || id}.pdf`
              a.click()
              URL.revokeObjectURL(url)
            } catch (e: any) {
              setError(e.message || 'PDF export failed')
            }
          }}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
          title="Export rental agreement as PDF"
        >
          <FileDown className="w-3.5 h-3.5" />
          PDF
        </button>
        {canEdit && !edit && (
          <button
            type="button"
            onClick={openEdit}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
          >
            <Pencil className="w-3.5 h-3.5" />
            Edit
          </button>
        )}
        {can('rentals:delete') && !edit && (
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
            title="Permanently delete this rental"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
        )}
      </div>

      <ConfirmDestructiveDialog
        open={deleteOpen}
        mode="delete"
        title={`Delete rental ${agreement.agreementNumber || ''}`}
        message="Permanently removes this rental agreement and its items/logs. Equipment is freed back to inventory."
        showOverride
        overrideLabel="Override: delete even if active with deployed items (items will be freed)."
        busy={deleteBusy}
        onConfirm={handleDelete}
        onClose={() => setDeleteOpen(false)}
      />

      {/* #1 Edit panel — sup+ can change anything; a reason is required */}
      {edit && (
        <div className="bg-white rounded-lg border border-blue-200 ring-1 ring-blue-100 p-4 mb-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Edit Rental</h3>
            <button type="button" onClick={() => setEdit(null)} className="text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Customer + location */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Customer</label>
              <CustomerSearch
                value={edit.customer}
                onChange={c => {
                  // Old field/pad/well belong to the old company — clear on move.
                  patchEdit({ customer: c, location: { field: null, pad: null, wells: [] }, locationTouched: true })
                }}
              />
              {edit.customer && edit.customer.id !== agreement.companyId && (
                <p className="text-xs text-amber-700 mt-1">
                  Moving to {edit.customer.name} — re-pick the location below. Future invoices bill the new customer.
                </p>
              )}
            </div>
            {agreement.pickupType !== 'walk_in' && edit.customer && (
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Location</label>
                <LocationPicker
                  companyId={edit.customer.id}
                  value={edit.location}
                  onChange={loc => patchEdit({ location: loc, locationTouched: true })}
                  multiWell={false}
                />
              </div>
            )}
          </div>

          {/* Dates + billing */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Start Date</label>
              <input
                type="date"
                value={edit.startDate}
                onChange={e => patchEdit({ startDate: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Billing Rate</label>
              <select
                value={edit.rateType}
                onChange={e => patchEdit({ rateType: e.target.value as EditForm['rateType'] })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Billing Cadence</label>
              <select
                value={edit.cadence}
                onChange={e => patchEdit({ cadence: e.target.value as EditForm['cadence'] })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-white"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              <p className="text-[11px] text-slate-400 mt-0.5">How often to actually invoice — usually monthly</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">PO #</label>
              <input
                type="text"
                value={edit.po}
                onChange={e => patchEdit({ po: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">AFE #</label>
              <input
                type="text"
                value={edit.afe}
                onChange={e => patchEdit({ afe: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>

          {/* Contacts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-slate-600">Person Calling</p>
              <input type="text" value={edit.pcName} onChange={e => patchEdit({ pcName: e.target.value })} placeholder="Name"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <input type="tel" value={edit.pcPhone} onChange={e => patchEdit({ pcPhone: e.target.value })} placeholder="Phone"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              <input type="email" value={edit.pcEmail} onChange={e => patchEdit({ pcEmail: e.target.value })} placeholder="Email"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            {agreement.pickupType !== 'walk_in' && (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-slate-600">On-Site Contact</p>
                <input type="text" value={edit.scName} onChange={e => patchEdit({ scName: e.target.value })} placeholder="Name"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                <input type="tel" value={edit.scPhone} onChange={e => patchEdit({ scPhone: e.target.value })} placeholder="Phone"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                <input type="email" value={edit.scEmail} onChange={e => patchEdit({ scEmail: e.target.value })} placeholder="Email"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            )}
          </div>

          {/* Composition — what's ordered + the rates */}
          <div className="border border-slate-200 rounded-lg p-3 space-y-3">
            <p className="text-xs font-semibold text-slate-600">
              Ordered Composition
              <span className="font-normal text-slate-400"> — rates are per {rateUnitLong(edit.rateType)}; these drive the invoice</span>
            </p>
            {agreement.pickupType !== 'walk_in' && (customerPackages.length > 0 || agreement.composition?.bomPackage) && (() => {
              const current = agreement.composition?.bomPackage
              const nextLine = switchTarget ? bomPackageLine(switchTarget, edit.rateType) : null
              const preview = edit.packageId ? packageFieldsForSave() as { bomExtras?: { label: string; qty?: number; rate?: number | null }[] } : null
              return (
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5 space-y-2">
                  <label className="block text-xs font-medium text-slate-600">
                    Package
                    <select
                      aria-label="Rental package"
                      value={edit.packageId === undefined ? '__keep' : edit.packageId === null ? '__none' : edit.packageId}
                      onChange={e => {
                        const v = e.target.value
                        const packageId = v === '__keep' ? undefined : v === '__none' ? null : v
                        const target = packageId ? customerPackages.find(b => b.id === packageId) : null
                        // A trailer the new package covers rides inside its line
                        // ($0, like dispatch); without a package it needs its own rate.
                        const trailerRate = !edit.trailerOn ? edit.trailerRate
                          : target?.packageProductId ? 0
                          : packageId === null && edit.trailerRate === 0 ? null
                          : edit.trailerRate
                        patchEdit({ packageId, trailerRate, compTouched: true })
                      }}
                      className="mt-1 w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white font-normal"
                    >
                      <option value="__keep">{current ? `Keep: ${current.label}${typeof current.rate === 'number' ? ` @ $${current.rate}/${rateUnitAbbrev(edit.rateType)}` : ''}` : 'Keep: no package'}</option>
                      {customerPackages.map(b => {
                        const line = bomPackageLine(b, edit.rateType)
                        return (
                          <option key={b.id} value={b.id}>
                            {bomDisplayName(b)}{typeof line?.rate === 'number' ? ` — $${line.rate}/${rateUnitAbbrev(edit.rateType)}` : ' — no rate'}
                          </option>
                        )
                      })}
                      {current && <option value="__none">No package — bill items individually</option>}
                    </select>
                  </label>
                  {edit.packageId !== undefined && (
                    <div className="text-xs text-slate-600 space-y-1">
                      {switchTarget && nextLine && (
                        <p>
                          Bills as <span className="font-medium">{nextLine.label}</span>
                          {typeof nextLine.rate === 'number'
                            ? <> @ ${nextLine.rate}/{rateUnitAbbrev(edit.rateType)}{nextLine.priceLevel ? <span className="text-slate-400"> ({nextLine.priceLevel} price level)</span> : <span className="text-amber-600"> (list — not on this customer&rsquo;s price level)</span>}</>
                            : <span className="text-red-600"> — no rate; bind a QB item on the customer&rsquo;s package first</span>}
                        </p>
                      )}
                      {switchTarget && switchTarget.items.length > 0 && (
                        <p className="text-slate-500">Includes {switchTarget.items.map(i => `${i.qty}× ${i.label || EQUIP_CAT_LABEL[i.equipmentCategory] || i.equipmentCategory}`).join(', ')}</p>
                      )}
                      {preview?.bomExtras?.length
                        ? <p className="text-slate-500">Over the new package (re-checked against gear on site): {preview.bomExtras.map(x => `${x.qty ?? 1}× ${x.label}${typeof x.rate === 'number' ? ` @ $${x.rate}` : ' — unpriced'}`).join('; ')}</p>
                        : switchTarget ? <p className="text-slate-400">Nothing on site beyond the new package.</p> : null}
                      {switchTarget && (() => {
                        // Gear the new package includes that is ALSO on its own
                        // priced line would bill twice — the line isn't an overage.
                        const included = new Set(switchTarget.items.map(i => i.equipmentCategory))
                        const dup = edit.monitors.filter(m => m.productId && included.has(monitorProducts.find(p => p.id === m.productId)?.category || ''))
                        return dup.length ? (
                          <p className="text-amber-700">
                            This package includes area monitors, and {dup.map(m => `${m.qty}× ${m.productName || 'monitor'}`).join(', ')} still bill on their own line below. Remove that line if the package covers them.
                          </p>
                        ) : null
                      })()}
                      {edit.packageId === null && <p className="text-amber-700">The package line, its contents, and its overages stop on the date below. Price the trailer and any gear individually.</p>}
                    </div>
                  )}
                </div>
              )
            })()}
              <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={edit.compositionCorrection}
                  onChange={e => patchEdit({ compositionCorrection: e.target.checked, compTouched: true })} />
                Correct charges from the start of this rental
              </label>
              {edit.compositionCorrection ? <p className="text-xs text-amber-700">Billing will use these charges for every unbilled day, replacing earlier charge changes. Void or correct existing invoices first.</p> :
              <label className="flex items-center justify-between gap-2 text-xs font-medium text-slate-600">
                <span>Changes take effect <span className="font-normal text-slate-400">— earlier days keep billing as they were</span></span>
                <input type="date" value={edit.effectiveDate} max={centralToday()}
                  onChange={e => patchEdit({ effectiveDate: e.target.value })}
                  className="px-2 py-1 border border-slate-300 rounded text-sm font-normal" />
              </label>}
              </div>
            {agreement.pickupType !== 'walk_in' && (
              <div>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm font-medium text-slate-800">Trailer</span>
                  <input type="checkbox" checked={edit.trailerOn}
                    onChange={e => patchEdit({ trailerOn: e.target.checked, compTouched: true })}
                    className="w-4 h-4 accent-blue-600" />
                </label>
                {edit.trailerOn && (
                  <div className="mt-2 flex items-center gap-2">
                    {([true, false] as const).map(m => (
                      <button key={String(m)} type="button"
                        onClick={() => patchEdit({ trailerManned: m, compTouched: true })}
                        className={cn('px-3 py-1.5 rounded border-2 text-xs font-medium',
                          edit.trailerManned === m ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600')}>
                        {m ? 'Manned' : 'Unmanned'}
                      </button>
                    ))}
                    <span className="text-xs text-slate-400 ml-2">$</span>
                    <input type="number" min={0} value={edit.trailerRate ?? ''} placeholder="rate"
                      onChange={e => patchEdit({ trailerRate: e.target.value ? parseFloat(e.target.value) : null, compTouched: true })}
                      className="w-24 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                  </div>
                )}
              </div>
            )}
            {edit.monitors.map((g, idx) => (
              <div key={g.id} className="flex gap-2 items-center">
                <select value={g.productId}
                  onChange={e => {
                    const opt = monitorProducts.find(p => p.id === e.target.value)
                    patchEdit({
                      monitors: edit.monitors.map((r, i) => i === idx ? { ...r, productId: e.target.value, productName: opt?.name || '', rate: opt ? rentalCatalogRate(opt, edit.rateType, editPriceLevels) : null, manualRate: false } : r),
                      compTouched: true,
                    })
                  }}
                  className="flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded text-sm bg-white">
                  <option value="">— pick monitor type —</option>
                  {monitorProducts.map(p => <option key={p.id} value={p.id}>{p.partNumber ? `${p.partNumber} — ` : ''}{p.name}</option>)}
                  {g.productId && !monitorProducts.some(p => p.id === g.productId) && (
                    <option value={g.productId}>{g.productName || 'Current selection'}</option>
                  )}
                </select>
                <input type="number" min={1} value={g.qty}
                  onChange={e => patchEdit({ monitors: edit.monitors.map((r, i) => i === idx ? { ...r, qty: parseInt(e.target.value) || 1 } : r), compTouched: true })}
                  className="w-14 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                <span className="text-xs text-slate-400">$</span>
                <input type="number" min={0} value={g.rate ?? ''} placeholder="rate"
                  onChange={e => patchEdit({ monitors: edit.monitors.map((r, i) => i === idx ? { ...r, rate: e.target.value ? parseFloat(e.target.value) : null, manualRate: true } : r), compTouched: true })}
                  className="w-20 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                <button type="button" onClick={() => patchEdit({ monitors: edit.monitors.filter((_, i) => i !== idx), compTouched: true })}
                  className="text-slate-400 hover:text-red-600 px-1"><X className="w-4 h-4" /></button>
              </div>
            ))}
            <div className="flex gap-4">
              <button type="button"
                onClick={() => patchEdit({ monitors: [...edit.monitors, { id: uuidv4(), productId: '', productName: '', qty: 1, rate: null }], compTouched: true })}
                className="text-sm font-medium text-blue-600 hover:text-blue-700">+ Gas monitor</button>
              <button type="button"
                onClick={() => patchEdit({ other: [...edit.other, { id: uuidv4(), label: '', qty: 1, rate: null }], compTouched: true })}
                className="text-sm font-medium text-blue-600 hover:text-blue-700">+ Other item</button>
            </div>
            <ProductSearch division={4} priceLevels={editPriceLevels} placeholder="Search QB item or part # to add…"
              onSelect={product => patchEdit({ other: [...edit.other, {
                id: uuidv4(), productId: product.id, catalogProduct: product, label: product.name,
                qty: 1, rate: rentalCatalogRate(product, edit.rateType, editPriceLevels), manualRate: false,
              }], compTouched: true })} />
            {edit.other.map((o, idx) => (
              <div key={o.id} className="flex gap-2 items-center">
                <input type="text" value={o.label} placeholder="Wind sock, signage, …"
                  onChange={e => patchEdit({ other: edit.other.map((r, i) => i === idx ? { ...r, label: e.target.value } : r), compTouched: true })}
                  className="flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                <input type="number" min={1} value={o.qty}
                  onChange={e => patchEdit({ other: edit.other.map((r, i) => i === idx ? { ...r, qty: parseInt(e.target.value) || 1 } : r), compTouched: true })}
                  className="w-14 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                <span className="text-xs text-slate-400">$</span>
                <input type="number" min={0} value={o.rate ?? ''} placeholder="rate"
                  onChange={e => patchEdit({ other: edit.other.map((r, i) => i === idx ? { ...r, rate: e.target.value ? parseFloat(e.target.value) : null, manualRate: true } : r), compTouched: true })}
                  className="w-20 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                <button type="button" onClick={() => patchEdit({ other: edit.other.filter((_, i) => i !== idx), compTouched: true })}
                  className="text-slate-400 hover:text-red-600 px-1"><X className="w-4 h-4" /></button>
              </div>
            ))}
          </div>

          {/* PICs */}
          <div className="border border-slate-200 rounded-lg p-3 space-y-2">
            <p className="text-xs font-semibold text-slate-600">Person(s) in Charge</p>
            {edit.pics.map((p, idx) => (
              <div key={p.id} className="flex gap-2 items-center">
                <input type="text" value={p.name} placeholder="Name"
                  onChange={e => patchEdit({ pics: edit.pics.map((r, i) => i === idx ? { ...r, name: e.target.value } : r) })}
                  className="flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                <input type="tel" value={p.phone || ''} placeholder="Phone"
                  onChange={e => patchEdit({ pics: edit.pics.map((r, i) => i === idx ? { ...r, phone: e.target.value } : r) })}
                  className="w-32 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                <button type="button" onClick={() => patchEdit({ pics: edit.pics.filter((_, i) => i !== idx) })}
                  className="text-slate-400 hover:text-red-600 px-1"><X className="w-4 h-4" /></button>
              </div>
            ))}
            <button type="button"
              onClick={() => patchEdit({ pics: [...edit.pics, { id: uuidv4(), name: '', phone: '', addedAt: new Date().toISOString(), addedBy: user?.name || undefined }] })}
              className="text-sm font-medium text-blue-600 hover:text-blue-700">+ Add PIC</button>
          </div>

          {/* Notes + reason */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Notes</label>
            <textarea
              value={edit.notes}
              onChange={e => patchEdit({ notes: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Reason for edit <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={edit.reason}
              onChange={e => patchEdit({ reason: e.target.value })}
              placeholder="Why are you changing this? (recorded on the rental)"
              className={cn(
                'w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none',
                edit.reason.trim() ? 'border-slate-300' : 'border-amber-300 bg-amber-50',
              )}
            />
          </div>
          {compositionEditIncomplete() && (
            <p className="text-xs text-amber-700">Set a rate on every ordered line before saving (0 = free/included).</p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={savingEdit || !edit.reason.trim() || !edit.customer || compositionEditIncomplete()}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {savingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save changes
            </button>
            <button
              type="button"
              onClick={() => setEdit(null)}
              className="px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {visitEquipment.length > 0 && <div className="bg-white border rounded-lg p-4 mb-4">
        <h2 className="font-semibold mb-2">Rental equipment</h2>
        {agreement.status === 'active' && <div className="flex gap-4 mb-3 text-sm text-blue-700">
          <button type="button" onClick={() => navigate(`/tickets/swap?rentalId=${agreement.id}`)}>Swap equipment</button>
          <button type="button" onClick={() => navigate(`/rentals/return?rentalId=${agreement.id}&returnDate=${returnDate}`)}>Return / inspect selected equipment</button>
        </div>}
        <div className="overflow-x-auto"><table className="w-full text-sm text-left">
          <thead><tr><th className="p-2">Serial</th><th className="p-2">Type</th><th className="p-2">Test date</th><th className="p-2">Status</th><th className="p-2">Inspection</th></tr></thead>
          <tbody>{visitEquipment.map(item => <tr key={item.id} className="border-t"><td className="p-2">{item.serial}</td><td className="p-2">{item.type}</td><td className="p-2">{item.testDate}</td><td className="p-2">{item.status === 'returned' ? `Returned ${item.returnedAt}` : 'Deployed'}</td><td className="p-2">{item.returnInspectionId && <button className="text-blue-700" onClick={() => navigate(`/tickets/${item.returnInspectionId}`)}>View batch inspection</button>}</td></tr>)}</tbody>
        </table></div>
      </div>}
      {/* Info Card */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            <div>
              <p className="text-slate-500 text-xs">Start Date</p>
              <p className="font-medium">{formatCalendarDateNumeric(agreement.startDate)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-slate-400" />
            <div>
              <p className="text-slate-500 text-xs">Billing</p>
              <p className="font-medium capitalize">{agreement.billingRateType}</p>
            </div>
          </div>
          <div>
            <p className="text-slate-500 text-xs">Job Type</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${agreement.isManned ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                {agreement.isManned ? 'Manned' : 'Unmanned'}
              </span>
              {agreement.isRigJob && <span className="text-xs px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-medium">Rig Job</span>}
              {agreement.monitorsIncluded && <span className="text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-full font-medium">Monitors</span>}
            </div>
          </div>
          {agreement.poNumber && (
            <div>
              <p className="text-slate-500 text-xs">PO</p>
              <p className="font-medium">{agreement.poNumber}</p>
            </div>
          )}
          {agreement.afeNumber && (
            <div>
              <p className="text-slate-500 text-xs">AFE</p>
              <p className="font-medium">{agreement.afeNumber}</p>
            </div>
          )}
        </div>
      </div>

      {/* Site Contact Card */}
      <RentalBillingSettings id={agreement.id} policy={agreement.billingPolicy}
        canEdit={canEdit && agreement.status !== 'cancelled'} onSaved={() => loadAgreement(agreement.id)} />

      {agreement.pickupType === 'walk_in' && <section className="mb-4 rounded-lg border bg-white p-4 text-sm">
        <h3 className="font-semibold">Rented to</h3>
        <p>{agreement.personCallingName || agreement.liabilitySignedByName || 'Contact not recorded'}</p>
        {agreement.personCallingPhone && <p>{agreement.personCallingPhone}</p>}
        <p className="text-slate-500">Bill to: {agreement.companyName}</p>
      </section>}
      {agreement.siteContactName && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-2">
            <User className="w-4 h-4 text-slate-400" />
            Site Contact
          </h3>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-slate-900">{agreement.siteContactName}</p>
            {agreement.siteContactPhone && (
              <a href={`tel:${agreement.siteContactPhone}`} className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800">
                <Phone className="w-3.5 h-3.5" />
                {agreement.siteContactPhone}
              </a>
            )}
            {agreement.siteContactEmail && (
              <a href={`mailto:${agreement.siteContactEmail}`} className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800">
                <Mail className="w-3.5 h-3.5" />
                {agreement.siteContactEmail}
              </a>
            )}
          </div>
        </div>
      )}

      {/* #C Rental composition — what was ordered (dispatch-time spec/BOM) */}
      {agreement.composition && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-2">
            <Package className="w-4 h-4 text-slate-400" />
            Rental charges
          </h3>
          <div className="space-y-1.5 text-sm text-slate-800">
            {(() => {
              const unit = rateUnitAbbrev(agreement.billingRateType)
              // $0 is a real rate (deliberately free/included); null = not priced yet.
              const rateTag = (rate?: number | null) =>
                typeof rate === 'number'
                  ? <span className="text-xs text-slate-500">{rate === 0 ? ' — included' : ` @ $${rate}/${unit}`}</span>
                  : null
              return (
                <>
                  {agreement.composition!.trailer && (
                    <p>Trailer — <span className="font-medium">{agreement.composition!.trailer.manned ? 'Manned' : 'Unmanned'}</span>{rateTag(agreement.composition!.trailer.rate)}</p>
                  )}
                  {agreement.composition!.gasMonitors?.map(g => (
                    <p key={g.id}>{g.qty}× {g.productName || 'Gas Monitor'}{rateTag(g.rate)}</p>
                  ))}
                  {agreement.composition!.other?.map(o => (
                    <p key={o.id}>{o.qty}× {o.label}{rateTag(o.rate)}</p>
                  ))}
                  {agreement.composition!.bomPackage && (
                    <p>
                      {agreement.composition!.bomPackage.label}
                      {rateTag(agreement.composition!.bomPackage.rate)}
                      <span className="text-xs text-slate-400"> — package charge; listed baseline equipment is included</span>
                    </p>
                  )}
                  <BomExtrasEditor id={agreement.id} extras={agreement.composition!.bomExtras || []} unit={unit}
                    canEdit={canEdit && agreement.status !== 'cancelled'} onSaved={() => loadAgreement(agreement.id)} />
                </>
              )
            })()}
            {(agreement.composition.bom?.length ?? 0) > 0 && (
              <div className="mt-1">
                <p className="font-medium">
                  {agreement.composition.drillingRig ? 'Drilling Rig BOM' : 'Included package equipment — no separate charge'}
                  <span className="font-normal text-xs text-slate-400"> — covered by the package, not charged individually</span>
                </p>
                <ul className="list-disc pl-5 text-xs text-slate-600">
                  {(agreement.composition.bom || []).map((b, i) => <li key={i}>{b.qty}× {b.label}</li>)}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* #1 PIC roster — forepersons captured from manned-trailer tickets */}
      {Array.isArray(agreement.pics) && agreement.pics.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-2">
            <User className="w-4 h-4 text-slate-400" />
            Person(s) in Charge
          </h3>
          <div className="space-y-2.5">
            {agreement.pics.map(pic => (
              <div key={pic.id} className="space-y-0.5">
                <p className="text-sm font-medium text-slate-900">{pic.name}</p>
                {pic.phone && (
                  <a href={`tel:${pic.phone}`} className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800">
                    <Phone className="w-3.5 h-3.5" />
                    {pic.phone}
                  </a>
                )}
                {pic.email && (
                  <a href={`mailto:${pic.email}`} className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800">
                    <Mail className="w-3.5 h-3.5" />
                    {pic.email}
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inventory records remain available beneath the shared visit equipment list. */}
      <details className="mb-4 rounded-lg border border-slate-200 bg-white">
      <summary className="cursor-pointer p-4 text-sm font-medium">Stock records and add gear</summary>
      <div className="bg-white rounded-lg border border-slate-200 mb-4">
        <div className="p-4 border-b border-slate-100">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2">
              <Package className="w-4 h-4" />
              Equipment ({agreement.items.length})
            </h2>
            <div className="flex gap-2 text-xs">
              {deployedCount > 0 && (
                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full font-medium">
                  {deployedCount} deployed
                </span>
              )}
              {returnedCount > 0 && (
                <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full font-medium">
                  {returnedCount} returned
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="divide-y divide-slate-100">
          {agreement.items.map(item => (
            <div key={item.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-slate-900">{item.productName}</p>
                  <p className="text-xs text-slate-500 font-mono">{item.serialNumber}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                    <span>Deployed {formatCalendarDateNumeric(item.deployedDate)}</span>
                    {item.rate != null && (
                      <span>${Number(item.rate).toFixed(2)}/{item.rateType?.charAt(0) || 'd'}</span>
                    )}
                    {item.returnedDate && (
                      <span>Returned {formatCalendarDateNumeric(item.returnedDate)}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded-full',
                    item.status === 'deployed' ? 'bg-blue-100 text-blue-700' :
                    item.status === 'returned' ? 'bg-green-100 text-green-700' :
                    'bg-amber-100 text-amber-700',
                  )}>
                    {item.status}
                  </span>

                  {item.status === 'deployed' && agreement.status === 'active' && (
                    <button
                      type="button"
                      onClick={() => setReturningItem(item)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Return
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* #2 Redeploy / Add Gear — only while the rental is active */}
        {['active', 'scheduled'].includes(agreement.status) && (
          <div className="p-4 border-t border-slate-100">
            {!showRedeploy ? (
              <button
                type="button"
                onClick={() => setShowRedeploy(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                <Plus className="w-4 h-4" />
                Redeploy / Add Gear
              </button>
            ) : (
              <div className="space-y-3">
                <label className="block text-xs font-medium text-slate-600">Deployment purpose
                  <select aria-label="Deployment purpose" value={replacesItemId} onChange={e => setReplacesItemId(e.target.value)} className="block border rounded-lg px-3 py-2 mt-1">
                    <option value="">Additional equipment</option>
                    {agreement.items.filter(i => i.status === 'deployed').map(i => <option key={i.id} value={i.id}>Replace {i.serialNumber || i.id}</option>)}
                  </select>
                </label>
                {replacesItemId && <p className="text-xs text-slate-500">The original unit is returned on the deployment date. Only the replacement bills for that date. Scan the same product type.</p>}
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Deployed date
                    <span className="ml-2 font-normal text-slate-400">defaults to today — backdate if the gear was already on site</span>
                  </label>
                  <input
                    type="date"
                    value={redeployDate}
                    max={(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()}
                    onChange={e => setRedeployDate(e.target.value)}
                    className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={addingGear}
                    onClick={() => setShowRedeployScanner(true)}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    {addingGear ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
                    Scan equipment
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowRedeploy(false); setError('') }}
                    className="px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      </details>

      {showRedeployScanner && (
        <EquipmentScanner
          filterStatus="available"
          allowCreate
          onEquipmentFound={handleAddGear}
          onClose={() => setShowRedeployScanner(false)}
        />
      )}

      {/* #20 Required deploy inspection — flagged answers need a note but don't block */}
      {pendingGear && (
        <DeployInspectionModal
          equipmentName={pendingGear.product.name}
          serialNumber={pendingGear.serialNumber}
          category={resolveDeployCategory(pendingGear.product)}
          inspectedBy={user?.name || null}
          onComplete={result => {
            const gear = pendingGear
            setPendingGear(null)
            performAddGear(gear, result)
          }}
          onCancel={() => setPendingGear(null)}
        />
      )}

      {/* Site Log — dispatched rentals only. Walk-ins are counter transactions
          with no on-site presence to log. */}
      {agreement.pickupType !== 'walk_in' && (
        <div className="bg-white rounded-lg border border-slate-200 mb-4">
          <button
            type="button"
            onClick={() => navigate(`/rentals/${id}/log`)}
            className="w-full p-4 flex items-center gap-3 text-left hover:bg-slate-50 transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
              <ClipboardList className="w-5 h-5 text-amber-700" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-slate-900">Site Log</p>
              <p className="text-xs text-slate-500">
                {(() => {
                  const n = agreement.linkedTickets?.length ?? 0
                  return n > 0
                    ? `${n} ticket${n === 1 ? '' : 's'} — Deploy + field tickets`
                    : 'Tap to view the Deploy and field tickets'
                })()}
              </p>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-400 shrink-0" />
          </button>
        </div>
      )}

      {/* Notes */}
      {agreement.notes && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-medium text-slate-700 mb-1">Notes</h3>
          <p className="text-sm text-slate-600">{agreement.notes}</p>
        </div>
      )}

      {/* Linked Invoices — "yep it's been billed for this month" at a glance */}
      {linkedInvoices.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-1.5">
            <DollarSign className="w-4 h-4" />
            Linked Invoices ({linkedInvoices.length})
            {agreement.isFullyBilled && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium uppercase ml-1">
                Fully billed
              </span>
            )}
          </h3>
          <div className="space-y-1.5">
            {linkedInvoices.map(inv => (
              <button
                key={inv.id}
                type="button"
                onClick={() => navigate(`/billing/${inv.id}`)}
                className="w-full text-left border border-slate-200 rounded-lg p-2.5 hover:bg-slate-50 transition-colors flex items-center justify-between gap-2"
              >
                <span className="text-sm font-medium text-slate-900">{inv.invoiceNumber}</span>
                <span className="text-xs text-slate-500">
                  {inv.periodStart && inv.periodEnd
                    ? `${formatCalendarDateNumeric(inv.periodStart)} – ${formatCalendarDateNumeric(inv.periodEnd)}`
                    : '—'}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium uppercase">
                  {inv.status}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Linked Service Tickets — surfaces tech notes captured against this rental */}
      {agreement.linkedTickets && agreement.linkedTickets.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-1.5">
            <ClipboardList className="w-4 h-4" />
            Linked Tickets ({agreement.linkedTickets.length})
          </h3>
          <div className="space-y-2">
            {agreement.linkedTickets.map(t => {
              const hasNotes = !!(t.dispatchNotes || t.workDescription || t.internalNotes)
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => navigate(`/tickets/${t.id}`)}
                  className="w-full text-left border border-slate-200 rounded-lg p-3 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-medium text-slate-900">
                      {t.ticketNumber}
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium uppercase">
                      {t.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                    <span>{formatCalendarDateNumeric(t.serviceDate)}</span>
                    {t.assignedTechName && <span>• {t.assignedTechName}</span>}
                    {t.serviceSubtype && <span>• {t.serviceSubtype}</span>}
                  </div>
                  {t.workDescription && (
                    <p className="text-xs text-slate-700 whitespace-pre-wrap mt-1">
                      <span className="font-medium text-slate-500">Work: </span>
                      {t.workDescription}
                    </p>
                  )}
                  {t.dispatchNotes && (
                    <p className="text-xs text-slate-700 whitespace-pre-wrap mt-1">
                      <span className="font-medium text-slate-500">Dispatch: </span>
                      {t.dispatchNotes}
                    </p>
                  )}
                  {t.internalNotes && (
                    <p className="text-xs text-slate-700 whitespace-pre-wrap mt-1">
                      <span className="font-medium text-slate-500">Internal: </span>
                      {t.internalNotes}
                    </p>
                  )}
                  {!hasNotes && (
                    <p className="text-xs text-slate-400 italic mt-1">No notes recorded</p>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {finalBillReady && <div role="status" className="mt-6 rounded-lg border border-green-300 bg-green-50 p-4">
        <p className="font-semibold">Rental closed — ready for final billing</p>
        <p className="mt-1 text-sm">The remaining charges through {formatCalendarDateNumeric(returnDate)} need one final invoice.</p>
        {hasPermission(user?.role, 'page:billing') && <button type="button" onClick={() => navigate('/billing?tab=rentals')} className="mt-2 text-sm font-medium text-blue-700 underline">Review final bill</button>}
      </div>}
      {agreement.status === 'active' && <label className="mt-6 block text-sm font-medium">Return / close date
        <input type="date" value={returnDate} min={agreement.startDate.slice(0, 10)} max={new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())}
          onInput={event => setReturnDate(event.currentTarget.value)} onChange={event => setReturnDate(event.target.value)} required className="ml-3 rounded border p-2" />
      </label>}
      {/* Actions */}
      {agreement.status === 'active' && deployedVisitCount > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => navigate(`/rentals/return?rentalId=${id}&returnDate=${returnDate}`)}
            disabled={completing || !returnDate}
            className="w-full flex items-center justify-center gap-2 py-3 bg-slate-800 text-white rounded-lg font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            <CheckCircle2 className="w-5 h-5" />
            {completing ? 'Completing...' : `Return All & Complete (${deployedVisitCount} items)`}
          </button>
        </div>
      )}

      {/* All items returned but agreement still active — offer to close */}
      {agreement.status === 'active' && deployedVisitCount === 0 && visitEquipment.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={async () => {
              setCompleting(true)
              try { await completeAgreement(); await loadAgreement(id!) }
              catch (err) { setError(err instanceof Error ? err.message : 'Failed to close rental') }
              finally { setCompleting(false) }
            }}
            disabled={completing || !returnDate}
            className="w-full flex items-center justify-center gap-2 py-3 bg-green-700 text-white rounded-lg font-medium hover:bg-green-600 transition-colors disabled:opacity-50"
          >
            <CheckCircle2 className="w-5 h-5" />
            {completing ? 'Completing...' : 'Complete Agreement'}
          </button>
        </div>
      )}

      {/* Return Inspection Modal */}
      {returningItem && (
        <div>
        <label className="fixed top-3 left-1/2 z-[60] -translate-x-1/2 rounded bg-white p-2 shadow text-sm">Return date <input type="date" required value={returnDate} onInput={event => setReturnDate(event.currentTarget.value)} onChange={event => setReturnDate(event.target.value)} /></label>
        <RentalInspectionEditor
          key={returningItem.id}
          equipmentName={returningItem.productName || 'Equipment'}
          serialNumber={returningItem.serialNumber || ''}
          onComplete={(data: InspectionData) => handleReturnItem(returningItem, data)}
          onCancel={() => {
            setReturningItem(null)
          }}
        />
        </div>
      )}
    </div>
  )
}
