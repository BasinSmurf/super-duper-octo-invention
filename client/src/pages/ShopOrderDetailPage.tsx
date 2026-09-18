import { ShopChargeBreakdown, type ShopChargePreview } from '@/components/ShopChargeBreakdown'
import { ShopServicePicker, type ShopServiceCharge } from '@/components/ShopServicePicker'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Elements } from '@stripe/react-stripe-js'
import { type Stripe } from '@stripe/stripe-js'
import { getStripe } from '@/lib/stripe'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { CREDIT_HOLD_MESSAGE } from '@/lib/creditHold'
import { useCompanyPriceLevels, useDivisionContractRates, priceLine } from '@/lib/priceLevels'
import { ContractPricingBanner, ContractPriceBadge } from '@/components/ContractPriceBadge'
import { usePermissions } from '@/contexts/PermissionsContext'
import { useAuth } from '@/contexts/AuthContext'
import { ConfirmDestructiveDialog } from '@/components/ConfirmDestructiveDialog'
import { EquipmentQaLauncherButton } from '@/components/EquipmentQaLauncherButton'
import { PaymentForm } from '@/components/PaymentForm'
import { QuantityInput } from '@/components/QuantityInput'
import { WORK_TYPE_DIVISION } from '@/lib/divisions'
import type { OfflineShopWorkOrder, OfflineShopWorkOrderItem, ShopContactMethod, ShopContactLogEntry, ContactParty } from '@/lib/db-types'
import {
  ArrowLeft,
  Loader2,
  Package,
  Calendar,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  ClipboardCheck,
  AlertTriangle,
  Truck,
  Clock,
  Pencil,
  Save,
  X,
  Plus,
  Trash2,
  Search,
  FileCheck,
  DollarSign,
  CreditCard,
  Banknote,
  ShieldAlert,
  Printer,
  FileDown,
} from 'lucide-react'
import { SignaturePad } from '@/components/SignaturePad'
import { ShopUnitEntry, buildShopItemPayload, type IntakeItem } from '@/components/ShopUnitEntry'
import { ShopLabelPrintDialog, collectLabelUnits, type LabelUnit } from '@/components/ShopLabelPrintDialog'
import {
  EquipmentInspectionEditor,
  qaChecklistComplete,
  type EquipmentInspectionCategory,
} from '@/components/EquipmentInspectionEditor'
import { UnitAttachments } from '@/components/UnitAttachments'
import { BatchQaPanel } from '@/components/BatchQaPanel'
import { ContactLogCard } from '@/components/ContactLogCard'
import { PayAtDropPanel } from '@/components/PayAtDropPanel'
import { VendorReceiveDialog, type ReceiveSubmission } from '@/components/VendorReceiveDialog'
import {
  UnitCloseState,
  IdentityPrompt,
  type CloseState,
  type IdentityCandidate,
} from '@/components/UnitCloseState'
import type { OfflineEquipmentInspection } from '@/lib/db-types'
import { TAX_JURISDICTIONS, DEFAULT_CC_FEE_PCT } from '@/lib/taxJurisdictions'
import { formatCalendarDateNumeric } from '@/lib/dates'

// Labels follow the ShopWork-refactor workflow vocabulary (inspection-as-spine);
// the underlying ShopItemStatus enum is unchanged (display-layer relabel only).
const ITEM_STATUS: Record<string, { label: string; color: string }> = {
  received: { label: 'Received', color: 'bg-blue-100 text-blue-700' },
  diagnosing: { label: 'Inspecting', color: 'bg-purple-100 text-purple-700' },
  awaiting_parts: { label: 'Awaiting Parts', color: 'bg-amber-100 text-amber-700' },
  awaiting_approval: { label: 'Awaiting Approval', color: 'bg-orange-100 text-orange-700' },
  in_work: { label: 'In Repair', color: 'bg-green-100 text-green-700' },
  warranty_out: { label: 'Warranty Out', color: 'bg-red-100 text-red-700' },
  outside_service: { label: 'At Vendor', color: 'bg-red-100 text-red-700' },
  qc_testing: { label: 'Re-Test', color: 'bg-cyan-100 text-cyan-700' },
  on_hold: { label: 'On Hold', color: 'bg-orange-100 text-orange-700' },
  shop_complete: { label: 'Ready for Pickup', color: 'bg-emerald-100 text-emerald-700' },
  returned: { label: 'Returned', color: 'bg-slate-100 text-slate-500' },
  condemned: { label: 'Condemned', color: 'bg-red-200 text-red-900' },
}

const CATEGORY_LABELS: Record<string, string> = {
  fire_extinguisher: 'Fire Extinguisher',
  area_monitor: 'Area Monitor',
  personal_monitor: 'Personal Monitor',
  fall_arrest: 'Fall Arrest',
  scba: 'SCBA',
  ue_cylinder: 'UE Cylinder',
  other: 'Other',
}

// Personal-monitor storage bins (mirror of ShopIntakePage): 1–22 + free-text.
const BIN_LABELS = Array.from({ length: 22 }, (_, i) => `Bin ${i + 1}`)

/** Read the stored bin location off an item's customData, if any. */
function binLocationOf(item: { customData?: Record<string, unknown> | null }): string | null {
  const v = item.customData && typeof item.customData === 'object' ? item.customData.binLocation : null
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

const SERVICE_LABELS: Record<string, string> = {
  repair: 'Repair',
  recharge: 'Recharge',
  inspection: 'Inspection',
  test: 'Test',
  calibrate: 'Calibrate',
  bump_test: 'Bump Test',
  warranty_repair: 'Warranty',
  ue_testing: 'UE Testing',
  sensor_replace: 'Sensor Replace',
  general: 'General',
}

const CATALOG_CATEGORY_LABELS: Record<string, string> = {
  sensor: 'Sensors',
  calibration_gas: 'Cal Gas',
  accessory: 'Accessories',
  consumable: 'Consumables',
  labor: 'Labor',
  misc: 'Misc',
}

// Shop equipment category → equipment-inspection category (mirrors
// server/src/services/inspectionChecklist.ts). 'other' has no QA gate.
const SHOP_TO_INSPECTION_CATEGORY: Record<string, EquipmentInspectionCategory> = {
  fire_extinguisher: 'fire_extinguisher',
  area_monitor: 'gas_detection',
  personal_monitor: 'gas_detection',
  fall_arrest: 'fall_arrest',
  scba: 'scba',
  ue_cylinder: 'ue_cylinder',
  other: 'other',
}

function inspectionCategoryFor(equipmentCategory: string): EquipmentInspectionCategory {
  return SHOP_TO_INSPECTION_CATEGORY[equipmentCategory] ?? 'other'
}

function isGatedCategory(equipmentCategory: string): boolean {
  return inspectionCategoryFor(equipmentCategory) !== 'other'
}

// Valid transitions for UI buttons
const ITEM_TRANSITIONS: Record<string, string[]> = {
  // 'warranty_out' + 'outside_service' both open the send-out form; both land
  // the item in 'outside_service' (the warranty_out button just pre-checks the
  // isWarranty flag). Status is unified; the two buttons preserve the reason.
  received: ['diagnosing', 'in_work', 'awaiting_approval', 'warranty_out', 'outside_service', 'on_hold'],
  diagnosing: ['in_work', 'awaiting_parts', 'awaiting_approval', 'warranty_out', 'outside_service', 'condemned', 'shop_complete', 'on_hold'],
  awaiting_parts: ['in_work', 'diagnosing', 'awaiting_approval', 'on_hold'],
  awaiting_approval: ['in_work', 'returned', 'on_hold'],
  in_work: ['qc_testing', 'shop_complete', 'awaiting_parts', 'awaiting_approval', 'warranty_out', 'outside_service', 'condemned', 'on_hold'],
  warranty_out: ['received'],
  outside_service: ['received'],
  qc_testing: ['shop_complete', 'in_work', 'outside_service', 'condemned', 'on_hold'],
  shop_complete: ['returned'],
  on_hold: ['received', 'diagnosing', 'in_work', 'awaiting_parts', 'awaiting_approval', 'outside_service', 'qc_testing', 'condemned'],
  // condemned + returned are terminal — no outbound transitions.
}

// WI-02 -- the only two reasons a human picks. "Waiting parts", "waiting
// customer approval" and "external vendor" are NOT here on purpose: each is
// already its own status, and the board derives the pill from that. Offering
// them here as well would let a unit claim one reason while sitting in the
// status for another.
// ── WI-07: intake → inspection pass-through ─────────────────────────────────
//
// SCBA constituents are stored as CHILD shop items (parentItemId), one per
// part, with equipmentDescription "SCBA regulator" / "SCBA mask" / etc. -- the
// shape shopWoCreate.ts writes at intake. Reading them back here is what stops
// the initial inspection asking for serials the counter already recorded.

const CONSTITUENT_LABEL: Record<string, string> = {
  case: 'Case',
  regulator: 'Regulator',
  mask: 'Mask',
  harness: 'Harness',
  bottle: 'Bottle',
}

/** "SCBA regulator" → "regulator". */
function constituentType(equipmentDescription: string | null | undefined): string | null {
  const m = /^SCBA\s+(.+)$/i.exec((equipmentDescription ?? '').trim())
  return m ? m[1].toLowerCase() : null
}

/**
 * `items` deliberately EXCLUDES sub-components (they are not separately
 * workable units), so the constituents live in `childItems`. Reading the wrong
 * list here is a silent empty result, not an error — hence the explicit type.
 */
type ChildItem = { id: string; serialNumber: string; parentId: string; equipmentDescription: string | null }

function childrenOf(item: { id: string }, children: ChildItem[]): ChildItem[] {
  return children.filter(c => c.parentId === item.id)
}

function intakeConstituentsFor(
  item: { id: string; equipmentCategory: string },
  children: ChildItem[],
): Array<{ id: string; label: string; serialNumber: string }> | undefined {
  if (item.equipmentCategory !== 'scba') return undefined
  const kids = childrenOf(item, children)
  if (kids.length === 0) return undefined
  return kids.map(k => {
    const type = constituentType(k.equipmentDescription)
    return {
      id: k.id,
      label: (type && CONSTITUENT_LABEL[type]) || k.equipmentDescription || 'Component',
      serialNumber: k.serialNumber,
    }
  })
}

function seeded(value: unknown): unknown {
  if (Array.isArray(value)) return value.length > 0 ? value : undefined
  if (typeof value === 'string') return value.trim() ? value : undefined
  return value ?? undefined
}

function customDataOf(item: { customData?: Record<string, unknown> | null }): Record<string, unknown> {
  return item.customData && typeof item.customData === 'object' ? item.customData : {}
}

/**
 * Values that go straight into the inspection form's own fields.
 *
 * Intake already captured the stable identity/details for the unit, so QA opens
 * with those values instead of asking the tech to re-key them. SCBA constituents
 * that do not have dedicated form fields are still shown by IntakeConstituents.
 *
 * Hydro / Posi-Check are deliberately NOT seeded: intake does not capture them
 * (no date field exists there), so there is nothing to pass through. Confirmed
 * with Max 2026-08-28 rather than inventing a capture point for them.
 */
function seedDataForItem(
  item: {
    equipmentCategory: string
    fexBrand?: string | null
    fexSize?: string | null
    fexType?: string | null
    id: string
    customData?: Record<string, unknown> | null
  },
  children: ChildItem[],
): Record<string, unknown> | undefined {
  const custom = customDataOf(item)
  const compact = (data: Record<string, unknown>) => {
    const entries = Object.entries(data).filter(([, value]) => value !== undefined)
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }

  if (item.equipmentCategory === 'fire_extinguisher') {
    return compact({
      brand: seeded(item.fexBrand),
      size: seeded(item.fexSize),
      type: seeded(item.fexType),
    })
  }
  if (item.equipmentCategory === 'area_monitor' || item.equipmentCategory === 'personal_monitor') {
    return compact({
      make: seeded(custom.monitorBrand),
      model: seeded(custom.monitorModel),
      sensors: seeded(custom.monitorGasTypes),
      binLocation: seeded(custom.binLocation),
    })
  }
  if (item.equipmentCategory === 'fall_arrest') {
    return compact({
      brand: seeded(custom.fallArrestBrand),
      model: seeded(custom.fallArrestModel),
    })
  }
  if (item.equipmentCategory === 'other') {
    return compact({
      description: seeded(custom.otherDescription),
    })
  }
  if (item.equipmentCategory === 'scba') {
    const regulator = childrenOf(item, children)
      .find(k => constituentType(k.equipmentDescription) === 'regulator')
    return compact({
      regulatorSerial: seeded(regulator?.serialNumber),
    })
  }
  return undefined
}

function inspectionDescriptionForItem(
  item: {
    equipmentDescription?: string | null
    equipmentCategory: string
    fexBrand?: string | null
    fexSize?: string | null
    fexType?: string | null
    customData?: Record<string, unknown> | null
  },
): string | undefined {
  if (item.equipmentDescription) return item.equipmentDescription
  const custom = customDataOf(item)
  if (item.equipmentCategory === 'fire_extinguisher') {
    return [item.fexBrand, item.fexSize, item.fexType].filter(Boolean).join(' ') || undefined
  }
  if (item.equipmentCategory === 'area_monitor' || item.equipmentCategory === 'personal_monitor') {
    return [custom.monitorBrand, custom.monitorModel].filter(v => typeof v === 'string' && v.trim()).join(' ') || undefined
  }
  if (item.equipmentCategory === 'fall_arrest') {
    return [custom.fallArrestBrand, custom.fallArrestModel].filter(v => typeof v === 'string' && v.trim()).join(' ') || undefined
  }
  return typeof custom.otherDescription === 'string' && custom.otherDescription.trim()
    ? custom.otherDescription
    : undefined
}

// Mirrors services/condemnEvidence.ts. The server refuses the transition
// regardless; this is so the tech reads it before clicking, next to the panel
// that fixes it.
const CONDEMN_EVIDENCE_MESSAGE =
  'A unit cannot be condemned without evidence. Attach at least one photo or '
  + 'report to this unit first — the attachment is what answers "why was this '
  + 'scrapped?" when the customer asks.'

const SETTABLE_HOLD_REASONS: Array<{ value: string; label: string }> = [
  { value: 'waiting_internal', label: 'Waiting internal' },
  { value: 'other', label: 'Other' },
]

interface StatusLogEntry {
  id: string
  fromStatus: string | null
  toStatus: string
  changedBy?: { name: string } | null
  notes: string | null
  location: string | null
  createdAt: string
}

interface CatalogPart {
  id: string
  partNumber: string
  name: string
  category: string
  catalogCategory: string | null
  productType: string
  unitOfMeasure: string | null
  defaultSellPrice: number | null
  /** QB ListID — what the customer's contract pricebook matches on. */
  qbItemListId?: string | null
}

interface UsedPart {
  productId?: string
  partNumber: string
  name: string
  quantity: number
  unitCost?: number | string
  /** Set when the customer's pricebook, not the catalog, set unitCost. */
  priceLevelName?: string | null
  /** Catalog list price the contract price replaced. */
  listPrice?: number | null
}

// Per-unit billing chunk, held as strings in the edit form (parsed on save).
interface BillingMiscEdit { description: string; amount: string }
interface ItemBillingEdit {
  services: ShopServiceCharge[]
  laborHours: string
  laborRate: string
  misc: BillingMiscEdit[]
  vendorCost: string
  vendorMode: 'passthrough' | 'catalog_service'
  vendorServiceProductId: string
  vendorFreight: string
  vendorMarkupPct: string
  vendorAttachmentKey: string | null
  vendorAttachmentName: string | null
  rollupEnabled: boolean
  rollupRate: string
}

function emptyBillingEdit(): ItemBillingEdit {
  return {
    laborHours: '', laborRate: '', misc: [], services: [],
    vendorCost: '', vendorFreight: '', vendorMarkupPct: '',
    vendorMode: 'passthrough', vendorServiceProductId: '',
    vendorAttachmentKey: null, vendorAttachmentName: null,
    rollupEnabled: false, rollupRate: '',
  }
}

// Hydrate the edit form from the stored item.billing JSON.
function billingEditFrom(raw: unknown): ItemBillingEdit {
  const b = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {}
  const s = (v: unknown) => (v == null ? '' : String(v))
  return {
    services: Array.isArray(b.services) ? b.services : [],
    laborHours: s(b.labor?.hours),
    laborRate: s(b.labor?.rate),
    misc: Array.isArray(b.misc) ? b.misc.map((m: any) => ({ description: s(m?.description), amount: s(m?.amount) })) : [],
    vendorCost: s(b.vendor?.cost),
    vendorMode: b.vendor?.mode === 'catalog_service' ? 'catalog_service' : 'passthrough',
    vendorServiceProductId: s(b.vendor?.serviceProductId),
    vendorFreight: s(b.vendor?.freight),
    vendorMarkupPct: s(b.vendor?.markupPct),
    vendorAttachmentKey: b.vendor?.attachmentKey ?? null,
    vendorAttachmentName: b.vendor?.attachmentName ?? null,
    rollupEnabled: !!b.rollup?.enabled,
    rollupRate: s(b.rollup?.rate),
  }
}

// Collapse the edit form back to the stored shape (null when nothing entered).
function billingToPayload(e: ItemBillingEdit): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  out.services = e.services
  const n = (v: string) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0 }
  if (e.laborHours.trim() || e.laborRate.trim()) out.labor = { hours: n(e.laborHours), rate: n(e.laborRate) }
  const misc = e.misc.filter(m => m.description.trim() || m.amount.trim()).map(m => ({ description: m.description.trim(), amount: n(m.amount) }))
  if (misc.length) out.misc = misc
  if (e.vendorCost.trim() || e.vendorMode === 'catalog_service') {
    out.vendor = {
      mode: e.vendorMode,
      ...(e.vendorMode === 'catalog_service' ? { serviceProductId: e.vendorServiceProductId } : {}),
      cost: n(e.vendorCost), freight: n(e.vendorFreight), markupPct: n(e.vendorMarkupPct),
      ...(e.vendorAttachmentKey ? { attachmentKey: e.vendorAttachmentKey, attachmentName: e.vendorAttachmentName } : {}),
    }
  }
  if (e.rollupEnabled) out.rollup = { enabled: true, ...(e.rollupRate.trim() ? { rate: n(e.rollupRate) } : {}) }
  return Object.keys(out).length ? out : null
}

interface ItemEdits {
  diagnosisNotes: string
  workNotes: string
  estimatedCost: string
  partsUsed: UsedPart[]
  billing: ItemBillingEdit
  serviceType: string
  equipmentCategory: string
}

const bnum = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const round2 = (n: number): number => Math.round(n * 100) / 100
const hasMoney = (v: unknown): boolean => v != null && String(v).trim() !== '' && Number.isFinite(Number(v))

// Mirrors the server TYPE_LOCKED gate on PUT /shop-orders/:id/items/:itemId.
const TYPE_EDIT_LOCKED_STATUSES = new Set(['qc_testing', 'shop_complete', 'returned'])

interface TransferSite { id: string; name: string; shortCode: string }
interface TransferEvent {
  id: string
  fromSite: TransferSite
  toSite: TransferSite
  transferredAt: string
  receivedAt: string | null
  transferredBy: { name: string } | null
  transportedBy: { name: string } | null
  receivedBy: { name: string } | null
  notes: string | null
  itemIds: string[]
}
interface TransferItemState {
  id: string
  itemNumber: number
  serialNumber: string
  equipmentDescription: string | null
  equipmentCategory: string
  siteId: string
  inTransitToSiteId: string | null
  transferEventId: string | null
}
interface TransferInfo {
  transfers: TransferEvent[]
  items: TransferItemState[]
  intakeSiteId: string
}

interface ContactLogResponse { contactEntries?: ShopContactLogEntry[] }

export function ShopOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { can } = usePermissions()
  const { user } = useAuth()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [order, setOrder] = useState<OfflineShopWorkOrder | null>(null)
  const [items, setItems] = useState<OfflineShopWorkOrderItem[]>([])
  // SCBA sub-components, kept out of the main item list but selectable in the
  // reprint dialog — their labels carry "PART OF <parent serial>".
  // equipmentDescription rides along because it is what NAMES the part ("SCBA
  // regulator"); WI-07's pass-through reads it to label and match constituents.
  const [childItems, setChildItems] = useState<{ id: string; serialNumber: string; parentId: string; parentSerial: string; equipmentDescription: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Batch select/clear (Wave 5 — intake fan-out at scale)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkConfirm, setBulkConfirm] = useState<'clear' | 'return' | null>(null)
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false)
  // WI-06 — batch QA over the checkbox selection.
  const [qaOpen, setQaOpen] = useState(false)
  // WI-09 — the vendor receive step, intercepted from the status move.
  const [receiveItem, setReceiveItem] = useState<string | null>(null)
  const [receiving, setReceiving] = useState(false)
  const [bulkStatusVal, setBulkStatusVal] = useState('in_work')
  const [bulkNote, setBulkNote] = useState('')
  // WI-02: On Hold cannot be entered without a reason, so the button opens this
  // prompt rather than firing a PATCH the server would (correctly) reject.
  // Per-unit attachment counts, reported up by UnitAttachments. Drives the
  // condemn gate's UI half — the server enforces it regardless (WI-04), this
  // just means the tech is told before they click rather than after.
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
  // WI-05 close state, computed server-side off the deadline so it is never stale.
  const [closeStates, setCloseStates] = useState<Record<string, CloseState>>({})
  const [identityCandidates, setIdentityCandidates] = useState<IdentityCandidate[]>([])
  const [holdPromptItemId, setHoldPromptItemId] = useState<string | null>(null)
  const [holdReasonVal, setHoldReasonVal] = useState('waiting_internal')
  const [holdNoteVal, setHoldNoteVal] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [statusChanging, setStatusChanging] = useState<string | null>(null)
  const [itemHistory, setItemHistory] = useState<Record<string, StatusLogEntry[]>>({})

  // QA inspection gate
  const [itemInspections, setItemInspections] = useState<Record<string, OfflineEquipmentInspection[]>>({})
  const [qaEditorItem, setQaEditorItem] = useState<OfflineShopWorkOrderItem | null>(null)
  // When set, after a QA inspection is saved we retry moving this item to shop_complete.
  const [pendingCompleteItemId, setPendingCompleteItemId] = useState<string | null>(null)

  // Edit mode
  const [editingItem, setEditingItem] = useState<string | null>(null)
  const [edits, setEdits] = useState<ItemEdits>({ diagnosisNotes: '', workNotes: '', estimatedCost: '', partsUsed: [], billing: emptyBillingEdit(), serviceType: '', equipmentCategory: '' })
  // Uploading the outside-vendor invoice attachment for the item being edited.
  const [vendorUploading, setVendorUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  // Quick bin-location edit (personal monitors) — independent of full edit mode.
  const [binSaving, setBinSaving] = useState<string | null>(null)
  // Bins held by OTHER active items across all shop WOs, keyed by bin label —
  // drives the "in use" disabling in the bin picker.
  const [occupiedBins, setOccupiedBins] = useState<Map<string, { workOrderNumber: string; itemId: string }>>(new Map())

  // Parts catalog
  const [catalog, setCatalog] = useState<CatalogPart[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [catalogCategories, setCatalogCategories] = useState<string[]>([])
  const [partCategoryFilter, setPartCategoryFilter] = useState('') // '' = all catalog categories
  const [partSearch, setPartSearch] = useState('')
  const [showPartPicker, setShowPartPicker] = useState(false)

  // WO-level billing extras (mileage/trip + order-level misc). Billed once by
  // the sweep; once stamped it's read-only here.
  const [woMileageMiles, setWoMileageMiles] = useState('')
  const [woMileageRate, setWoMileageRate] = useState('')
  const [woTripFlat, setWoTripFlat] = useState('')
  const [woMisc, setWoMisc] = useState<BillingMiscEdit[]>([])
  const [woBillingSaving, setWoBillingSaving] = useState(false)
  const [woBillingMsg, setWoBillingMsg] = useState('')
  const [woExtrasBilled, setWoExtrasBilled] = useState(false)

  // WI-10 contact log. The per-card form state moved into ContactLogCard —
  // two cards need two independent drafts, and hoisting them here would have
  // meant one note box writing into the other.

  // Release / pickup form
  const [showRelease, setShowRelease] = useState(false)
  const [pickupName, setPickupName] = useState('')
  const [pickupSignature, setPickupSignature] = useState<string | null>(null)
  const [pickupNotes, setPickupNotes] = useState('')
  const [releasing, setReleasing] = useState(false)
  const [releasePayMethod, setReleasePayMethod] = useState<'account' | 'card' | 'cash'>('account')
  // Cash/Card-only customer — defaults the release to card and surfaces the form.
  const [companyCashCcOnly, setCompanyCashCcOnly] = useState(false)
  // AR credit hold on this WO's customer — blocks releasing the gear back.
  const [companyCreditHold, setCompanyCreditHold] = useState(false)
  // The customer's QuickBooks contract pricebook. Shop work is D6, so its
  // labor and mileage rates come from the D6 parts — pre-filled below rather
  // than left blank for the invoice to quietly correct later.
  const { levels: priceLevels, level: priceLevel } = useCompanyPriceLevels(order?.companyId ?? null)
  const contractRates = useDivisionContractRates(priceLevels, WORK_TYPE_DIVISION.repair ?? 6)
  // True once the mileage rate box holds a real number — either loaded from the
  // saved order or seeded from the contract. Guards the seed below from
  // overwriting a rate someone deliberately cleared.
  const woMileageRateSeeded = useRef(false)
  // Bumped whenever units change — the pay-at-drop total is DERIVED from the
  // order's billable units, so it moves when they do.
  const [payAtDropKey, setPayAtDropKey] = useState(0)
  // Money already taken at the counter, net of any card surcharge. Read from
  // the same server derivation the panel and the invoice use, so the release
  // form cannot disagree with them about what is still owed.
  const [counterCollected, setCounterCollected] = useState(0)
  // Lightspeed settles outside ServicePRO, so there is a payment but no amount
  // to net off. Tracked separately because the release form must warn rather
  // than quietly charge the job again.
  const [counterViaLightspeed, setCounterViaLightspeed] = useState(false)

  // WI-10. Customer chasing appears once the gear is Ready for Pickup — the
  // card's original trigger, preserved exactly. Vendor chasing appears while
  // anything on the order is actually out at a vendor, which is when there is
  // somebody to chase; showing it on every job would be a card nobody fills in.
  const contactEntries = (order?.contactEntries ?? []) as ShopContactLogEntry[]
  const showCustomerLog = order?.status === 'complete'
  const showVendorLog = items.some(i => i.status === 'outside_service' || i.status === 'warranty_out')
  // Removing an entry is a supervisor action; everyone else gets no affordance.
  const canDeleteContact = can('shop_orders:delete')
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null)
  const [releasePaymentDone, setReleasePaymentDone] = useState(false)
  const [releaseTaxJurisdiction, setReleaseTaxJurisdiction] = useState('williston')
  const [releaseCcFeePct, setReleaseCcFeePct] = useState(DEFAULT_CC_FEE_PCT)
  const [chargePreview, setChargePreview] = useState<ShopChargePreview | null>(null)
  const [chargePreviewError, setChargePreviewError] = useState('')

  // Send-out form (warranty / outside service)
  const [sendOutItem, setSendOutItem] = useState<string | null>(null)
  const [sendOutType, setSendOutType] = useState<'warranty' | 'outside'>('warranty')
  const [sendOutTo, setSendOutTo] = useState('')
  const [sendOutMethod, setSendOutMethod] = useState('')
  const [sendOutTracking, setSendOutTracking] = useState('')
  const [sendOutVendor, setSendOutVendor] = useState('')
  const [sendOutNotes, setSendOutNotes] = useState('')
  const [sendOutDate, setSendOutDate] = useState('') // blank → server uses now; backdatable
  const [sendingOut, setSendingOut] = useState(false)

  // Invoice generation
  const [generatingInvoice, setGeneratingInvoice] = useState(false)
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(null)

  // Force close (supervisor)
  const [showForceClose, setShowForceClose] = useState(false)
  const [forceCloseReason, setForceCloseReason] = useState('')
  const [forceClosing, setForceClosing] = useState(false)

  // Reprint label
  // Add units after intake — "hey, can I add this to that order?"
  const [showAddUnits, setShowAddUnits] = useState(false)
  const [addUnitDrafts, setAddUnitDrafts] = useState<IntakeItem[]>([])
  const [addingUnits, setAddingUnits] = useState(false)
  const [addUnitsError, setAddUnitsError] = useState('')
  const [addUnitsPrintUnits, setAddUnitsPrintUnits] = useState<LabelUnit[] | null>(null)

  const [showReprint, setShowReprint] = useState(false)
  const [reprintItemId, setReprintItemId] = useState('') // '' = whole work order
  const [reprintCopies, setReprintCopies] = useState('1')
  const [reprintReason, setReprintReason] = useState('damaged')
  const [reprinting, setReprinting] = useState(false)
  const [reprintMsg, setReprintMsg] = useState('')

  // Force-claim — assign a Received item to a tech from the web UI
  const [techs, setTechs] = useState<Array<{ id: string; name: string }>>([])
  const [claimingItem, setClaimingItem] = useState<string | null>(null)

  // Inter-site transfer
  const [transferInfo, setTransferInfo] = useState<TransferInfo | null>(null)
  const [transferSites, setTransferSites] = useState<TransferSite[]>([])
  const [transferDest, setTransferDest] = useState('')
  const [transferNotes, setTransferNotes] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferMsg, setTransferMsg] = useState<string | null>(null)
  // Per-item transfer: when off, the whole WO moves; when on, only checked items.
  const [transferSelectMode, setTransferSelectMode] = useState(false)
  const [transferSelected, setTransferSelected] = useState<Set<string>>(new Set())
  // "Transported by" — any active employee, chosen via a look-ahead.
  const [activeEmployees, setActiveEmployees] = useState<Array<{ id: string; name: string }>>([])
  const [transportedById, setTransportedById] = useState('')
  const [transportedQuery, setTransportedQuery] = useState('')
  const [transportedOpen, setTransportedOpen] = useState(false)

  useEffect(() => {
    if (id) loadOrder(id)
  }, [id])

  useEffect(() => {
    api.get<{ data: Array<{ id: string; name: string }> }>('/claim/techs')
      .then(d => setTechs(d.data))
      .catch(() => setTechs([]))
    // Any active employee can be the transporter (driver / another tech), not
    // just shop-floor roles — so this uses the full active-user list.
    api.get<{ data: Array<{ id: string; name: string }> }>('/users/active')
      .then(d => setActiveEmployees(d.data))
      .catch(() => setActiveEmployees([]))
  }, [])

  async function loadTransfers() {
    if (!id) return
    try {
      const [info, siteRes] = await Promise.all([
        api.get<TransferInfo>(`/shop-transfers?workOrderId=${id}`),
        api.get<{ data: TransferSite[] }>('/sites?active=true'),
      ])
      setTransferInfo(info)
      setTransferSites(siteRes.data)
    } catch {
      setTransferInfo(null)
    }
  }

  useEffect(() => { loadTransfers() }, [id])

  async function loadOccupiedBins() {
    try {
      const res = await api.get<{ data: Array<{ bin: string; workOrderNumber: string; itemId: string }> }>('/shop-orders/occupied-bins')
      setOccupiedBins(new Map(res.data.map(d => [d.bin, { workOrderNumber: d.workOrderNumber, itemId: d.itemId }])))
    } catch {
      setOccupiedBins(new Map())
    }
  }

  useEffect(() => { loadOccupiedBins() }, [id])

  // What the counter already took, so the release form can net it off.
  //
  // Read from the server's own derivation rather than recomputed here: the
  // panel, the release form and the generated invoice must agree to the cent
  // about what is still owed, and three implementations of that sum is three
  // chances to disagree. Re-read on payAtDropKey so taking a payment in the
  // panel updates the pickup total without a page reload.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    void api.get<{ collected?: number; paidAtDropVia?: string | null; lightspeedTxnNumber?: string | null }>(
      `/shop-orders/${id}/billing-route`,
    )
      .then(r => {
        if (cancelled) return
        setCounterCollected(r.collected ?? 0)
        setCounterViaLightspeed(r.paidAtDropVia === 'lightspeed' && !!r.lightspeedTxnNumber)
      })
      // A failed read must not invent a credit. Zero means "bill the job",
      // which is the safe direction to be wrong in: the customer is asked for
      // money they may have paid and can say so, rather than walking out
      // without being charged.
      .catch(() => { if (!cancelled) { setCounterCollected(0); setCounterViaLightspeed(false) } })
    return () => { cancelled = true }
  }, [id, payAtDropKey])

  // Lazy-load Stripe when user selects card payment at release
  useEffect(() => {
    if (releasePayMethod === 'card' && !stripePromise) {
      setStripePromise(getStripe())
    }
  }, [releasePayMethod])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setChargePreview(null)
    setChargePreviewError('')
    api.get<ShopChargePreview>(`/shop-orders/${id}/charge-preview`).then(r => {
      if (!cancelled) setChargePreview(r)
    }).catch(() => { if (!cancelled) setChargePreviewError('Unable to load charges. Reconnect and reload before closing or taking payment.') })
    return () => { cancelled = true }
  }, [id, items, order?.billingExtras, payAtDropKey])

  const releaseTaxRate = TAX_JURISDICTIONS.find(j => j.id === releaseTaxJurisdiction)?.rate || 0
  const releaseSubtotal = chargePreview?.subtotal ?? 0
  const releaseTaxableSubtotal = chargePreview?.taxableSubtotal ?? 0
  const releaseTax = releaseTaxableSubtotal * releaseTaxRate
  // Net off whatever was collected at drop-off. Without this the counter takes
  // the money twice: the deposit was charged when the customer handed the gear
  // over, and this form was still totalling the whole job at pickup.
  const releaseGross = round2(releaseSubtotal + releaseTax)
  const releaseCredit = Math.min(counterCollected, releaseGross)
  const releaseBalance = round2(releaseGross - releaseCredit)
  // The surcharge follows the balance, not the job. Charging it on the gross
  // would bill a fee on money the customer already paid a fee on.
  const releaseCcFee = releasePayMethod === 'card' ? releaseBalance * (releaseCcFeePct / 100) : 0
  const releaseTotal = round2(releaseBalance + releaseCcFee)

  // Seed the WO's mileage rate from the customer's D6 contract rate, once,
  // when the order has no rate of its own. Same reasoning as the labor rate:
  // on a contract customer the number is already decided, and an empty box is
  // how a wrong one gets typed.
  useEffect(() => {
    if (woMileageRateSeeded.current) return
    if (woExtrasBilled) return
    const contract = contractRates.mileage
    if (!contract?.priceLevelName || contract.rate == null) return
    setWoMileageRate(String(contract.rate))
    woMileageRateSeeded.current = true
  }, [contractRates.mileage, woExtrasBilled])

  const loadCatalog = useCallback(async () => {
    if (catalogLoaded) return
    try {
      const result = await api.get<{ data: CatalogPart[]; categories?: string[] }>('/shop-orders/parts-catalog')
      if (result?.data) {
        setCatalog(result.data)
        setCatalogCategories(result.categories || [])
        setCatalogLoaded(true)
      }
    } catch {
      // offline — no catalog
    }
  }, [catalogLoaded])

  // Populate the WO-level billing-extras form from the stored JSON, and lock it
  // when the sweep has already billed it (billedTicketId stamped).
  function hydrateWoExtras(raw: unknown) {
    const b = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {}
    const s = (v: unknown) => (v == null ? '' : String(v))
    setWoMileageMiles(s(b.mileage?.miles))
    setWoMileageRate(s(b.mileage?.rate))
    woMileageRateSeeded.current = !!s(b.mileage?.rate)
    setWoTripFlat(s(b.mileage?.flat))
    setWoMisc(Array.isArray(b.misc) ? b.misc.map((m: any) => ({ description: s(m?.description), amount: s(m?.amount) })) : [])
    setWoExtrasBilled(!!b.billedTicketId)
  }

  async function loadOrder(orderId: string) {
    try {
      // Dexie first
      const local = await db.shopWorkOrders.get(orderId)
      const localItems = await db.shopWorkOrderItems
        .where('workOrderId')
        .equals(orderId)
        .toArray()

      if (local) {
        setOrder(local)
        hydrateWoExtras(local.billingExtras)
        setItems(localItems.filter(i => !i.parentItemId).sort((a, b) => a.itemNumber - b.itemNumber))
        setChildItems(
          localItems
            .filter(i => i.parentItemId)
            .sort((a, b) => a.itemNumber - b.itemNumber)
            .map(c => ({
              id: c.id,
              serialNumber: c.serialNumber,
              parentId: c.parentItemId!,
              parentSerial: localItems.find(p => p.id === c.parentItemId)?.serialNumber ?? '',
              equipmentDescription: c.equipmentDescription ?? null,
            })),
        )
        setLoading(false)
      }

      // API for fresh data
      try {
        const apiData = await api.get<any>(`/shop-orders/${orderId}`)
        if (apiData?.id) {
          const wo: OfflineShopWorkOrder = {
            id: apiData.id,
            workOrderNumber: apiData.workOrderNumber,
            billingWaiver: apiData.customData?.billingWaiver ?? null,
            status: apiData.status,
            companyId: apiData.companyId,
            companyName: apiData.company?.name || '',
            isInternal: apiData.isInternal ?? false,
            poNumber: apiData.poNumber || null,
            afeNumber: apiData.afeNumber || null,
            intakeDate: apiData.intakeDate,
            intakeNotes: apiData.intakeNotes || null,
            intakeById: apiData.intakeById || null,
            intakeByName: apiData.intakeBy?.name || null,
            // Basin Site + optional Pad pointers — pass through from API.
            intakeSiteId: apiData.intakeSiteId ?? '',
            sourceLocationId: apiData.sourceLocationId ?? null,
            returnLocationId: apiData.returnLocationId ?? null,
            promisedDate: apiData.promisedDate || null,
            priority: apiData.priority ?? 5,
            completedDate: apiData.completedDate || null,
            returnedDate: apiData.returnedDate || null,
            dropOffContactName: apiData.dropOffContactName || null,
            dropOffContactPhone: apiData.dropOffContactPhone || null,
            dropOffContactEmail: apiData.dropOffContactEmail || null,
            dropOffContactPreferred: apiData.dropOffContactPreferred || null,
            pickupContactName: apiData.pickupContactName || null,
            pickupContactPhone: apiData.pickupContactPhone || null,
            pickupContactEmail: apiData.pickupContactEmail || null,
            pickupContactPreferred: apiData.pickupContactPreferred || null,
            // WI-10: entries come from their own table now. contactLog is the
            // retired JSONB shape, still carried so an offline cache written by
            // the previous release keeps parsing.
            contactLog: apiData.contactLog || null,
            contactEntries: apiData.contactEntries || [],
            pickupSignedByName: apiData.pickupSignedByName || null,
            pickupSignature: apiData.pickupSignature || null,
            pickupSignedAt: apiData.pickupSignedAt || null,
            pickupNotes: apiData.pickupNotes || null,
            totalItems: apiData.totalItems ?? 0,
            completedItems: apiData.completedItems ?? 0,
            primaryCategory: apiData.primaryCategory || null,
            notes: apiData.notes || null,
            billingExtras: apiData.billingExtras ?? null,
            createdAt: apiData.createdAt,
            updatedAt: apiData.updatedAt,
          }
          setOrder(wo)
          hydrateWoExtras(wo.billingExtras)

          // Cash/Card-only customer: default the release to card so staff
          // collect payment at pickup instead of billing on account.
          if (apiData.company?.cashCcOnly) {
            setCompanyCashCcOnly(true)
            setReleasePayMethod(prev => (prev === 'account' ? 'card' : prev))
          }
          setCompanyCreditHold(!!apiData.company?.creditHold)

          const parsedItems: OfflineShopWorkOrderItem[] = (apiData.items || []).map((item: any) => ({
            id: item.id,
            workOrderId: item.workOrderId,
            itemNumber: item.itemNumber,
            serializedEquipmentId: item.serializedEquipmentId || null,
            serialNumber: item.serialNumber,
            equipmentCategory: item.equipmentCategory,
            productId: item.productId || null,
            equipmentDescription: item.equipmentDescription || null,
            fexBrand: item.fexBrand || null,
            fexSize: item.fexSize || null,
            fexType: item.fexType || null,
            serviceType: item.serviceType,
            reportedIssue: item.reportedIssue || null,
            status: item.status,
            diagnosisNotes: item.diagnosisNotes || null,
            diagnosedById: item.diagnosedById || null,
            diagnosedAt: item.diagnosedAt || null,
            estimatedCost: item.estimatedCost != null ? Number(item.estimatedCost) : null,
            quoteSentAt: item.quoteSentAt || null,
            quoteApprovedAt: item.quoteApprovedAt || null,
            quoteDeclinedAt: item.quoteDeclinedAt || null,
            assignedToId: item.assignedToId || null,
            workNotes: item.workNotes || null,
            workCompletedAt: item.workCompletedAt || null,
            isWarranty: item.isWarranty ?? false,
            warrantyVendor: item.warrantyVendor || null,
            sentOutDate: item.sentOutDate || null,
            sentOutMethod: item.sentOutMethod || null,
            sentOutTracking: item.sentOutTracking || null,
            sentOutTo: item.sentOutTo || null,
            receivedBackDate: item.receivedBackDate || null,
            receivedBackNotes: item.receivedBackNotes || null,
            qcTestedById: item.qcTestedById || null,
            qcResult: item.qcResult || null,
            qcNotes: item.qcNotes || null,
            qcCompletedAt: item.qcCompletedAt || null,
            returnedAt: item.returnedAt || null,
            returnMethod: item.returnMethod || null,
            billedAt: item.billedAt || null,
            billedTicketId: item.billedTicketId || null,
            partsUsed: item.partsUsed || null,
            billing: item.billing ?? null,
            customData: item.customData ?? null,
            parentItemId: item.parentItemId || null,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          }))
          setItems(parsedItems.filter(i => !i.parentItemId).sort((a, b) => a.itemNumber - b.itemNumber))
          // API returns top-level items with children nested — flatten the
          // components for the reprint dialog.
          setCloseStates(apiData.closeStates || {})
          setIdentityCandidates(apiData.identityCandidates || [])
          setChildItems(
            (apiData.items || []).flatMap((it: any) =>
              (it.childComponents || []).map((c: any) => ({
                id: c.id,
                serialNumber: c.serialNumber,
                parentId: it.id,
                parentSerial: it.serialNumber,
                equipmentDescription: c.equipmentDescription ?? null,
              })),
            ),
          )
        }
      } catch {
        // Offline
      }
    } catch {
      setError('Could not load work order')
    }
    // The pay-at-drop total is derived from the order's billable units, so it
    // has to be re-read whenever those change — which is exactly whenever the
    // order reloads.
    setPayAtDropKey(k => k + 1)
    setLoading(false)
  }

  function openSendOutForm(itemId: string, type: 'warranty' | 'outside') {
    setSendOutItem(itemId)
    setSendOutType(type)
    setSendOutTo('')
    setSendOutMethod('basin_truck')
    setSendOutTracking('')
    setSendOutVendor('')
    setSendOutNotes('')
  }

  /**
   * WI-09 — record the receive.
   *
   * Goes through the ordinary status route, not the dedicated receive-back
   * endpoint, because that is the path the rest of this page uses and the
   * server gates BOTH identically. One door, one guard.
   */
  async function submitReceive(payload: ReceiveSubmission) {
    if (!id || !receiveItem) return
    setReceiving(true)
    setError('')
    try {
      await api.patch(`/shop-orders/${id}/items/${receiveItem}/status`, {
        status: 'received',
        ...payload,
      })
      setReceiveItem(null)
      await loadOrder(id)
    } catch (err) {
      // Rethrown so the dialog can show it inline and keep what was typed —
      // losing a keyed invoice total to a failed request is how people stop
      // keying invoice totals.
      throw err instanceof Error ? err : new Error('Failed to record the receive')
    } finally {
      setReceiving(false)
    }
  }

  async function submitSendOut() {
    if (!id || !sendOutItem) return
    setSendingOut(true)
    try {
      await api.post(`/shop-orders/${id}/items/${sendOutItem}/send-out`, {
        sentOutTo: sendOutTo || null,
        sentOutMethod: sendOutMethod || null,
        sentOutTracking: sendOutTracking || null,
        isWarranty: sendOutType === 'warranty',
        warrantyVendor: sendOutType === 'warranty' ? sendOutVendor : null,
        sentOutDate: sendOutDate || undefined,
        notes: sendOutNotes || null,
      })

      // Decoupled: status is always 'outside_service'; warranty is the isWarranty flag.
      const isW = sendOutType === 'warranty'
      await db.shopWorkOrderItems.update(sendOutItem, { status: 'outside_service', isWarranty: isW })
      setItems(prev => prev.map(i => i.id === sendOutItem ? { ...i, status: 'outside_service', isWarranty: isW } : i))

      // Re-fetch WO header
      try {
        const woData = await api.get<any>(`/shop-orders/${id}`)
        if (woData?.id && order) {
          setOrder({ ...order, status: woData.status, completedItems: woData.completedItems ?? order.completedItems })
          await db.shopWorkOrders.update(id, { status: woData.status, completedItems: woData.completedItems ?? order.completedItems })
        }
      } catch { /* offline */ }

      setSendOutItem(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send out')
    }
    setSendingOut(false)
  }

  /** Both contact-log endpoints return the whole work order; this is the only
   *  part either handler reads. */

  /**
   * WI-10 — append an entry. Same endpoint as before; `party` is the new field
   * and the server defaults it to 'customer' when absent, so an un-updated
   * client is still making a valid request.
   */
  const addContactEntry = useCallback(async (input: {
    party: ContactParty
    method: ShopContactMethod
    note: string
    contactedAt: string
    followUpAt: string | null
  }) => {
    if (!id) return
    const updated = await api.post<ContactLogResponse>(`/shop-orders/${id}/contact-log`, input)
    setOrder(prev => prev ? { ...prev, contactEntries: updated.contactEntries ?? [] } : prev)
  }, [id])

  /** WI-10 — supervisor soft-delete. The reason is required by the server and
   *  by the database; this just carries it. */
  const deleteContactEntry = useCallback(async (entryId: string, reason: string) => {
    if (!id) return
    const updated = await api.delete<ContactLogResponse>(`/shop-orders/${id}/contact-log/${entryId}`, { reason })
    setOrder(prev => prev ? { ...prev, contactEntries: updated.contactEntries ?? [] } : prev)
  }, [id])

  async function submitRelease() {
    if (!id || !pickupName || !chargePreview) return
    setReleasing(true)
    try {
      await api.post<any>(`/shop-orders/${id}/release`, {
        pickupSignedByName: pickupName,
        pickupSignature,
        pickupNotes: pickupNotes || null,
      })

      // Update local state
      if (order) {
        const updated = {
          ...order,
          status: 'closed',
          returnedDate: new Date().toISOString(),
        }
        setOrder(updated)
        await db.shopWorkOrders.update(id, { status: 'closed', returnedDate: new Date().toISOString() })
      }

      // Mark all items as returned locally
      setItems(prev => prev.map(i =>
        i.status === 'shop_complete' ? { ...i, status: 'returned' } : i
      ))

      setShowRelease(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to release equipment')
    }
    setReleasing(false)
  }

  async function submitForceClose() {
    if (!id || !forceCloseReason.trim() || !chargePreview) return
    setForceClosing(true)
    try {
      await api.post<any>(`/shop-orders/${id}/force-close`, {
        reason: forceCloseReason.trim(),
      })

      // Update local state
      if (order) {
        const updated = { ...order, status: 'closed', returnedDate: new Date().toISOString() }
        setOrder(updated)
        await db.shopWorkOrders.update(id, { status: 'closed', returnedDate: new Date().toISOString() })
      }

      setItems(prev => prev.map(i => ({ ...i, status: 'returned' })))
      setShowForceClose(false)
      setForceCloseReason('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to force-close')
    }
    setForceClosing(false)
  }

  function toggleSelect(itemId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId)
      return next
    })
  }
  function exitSelect() {
    setSelectMode(false)
    setSelectedIds(new Set())
    setBulkConfirm(null)
    setBulkStatusOpen(false)
    setQaOpen(false)
    setBulkNote('')
    setHoldNoteVal('')
  }

  /**
   * WI-07 — correct a constituent serial mistyped at intake.
   *
   * Writes to the CHILD UNIT record, not to the inspection: the serial is that
   * unit's identity, so fixing it only inside an inspection form would leave
   * the wrong value on the shelf label and in VaultPRO. The server audits the
   * prior value.
   */
  const correctConstituentSerial = useCallback(async (childItemId: string, serialNumber: string) => {
    if (!id) return
    await api.put(`/shop-orders/${id}/items/${childItemId}`, { serialNumber })
    await loadOrder(id)
  }, [id])

  /** WI-05 — Platform Admin reopens a hard-closed unit for a fresh 48 hours. */
  const unlockUnit = useCallback(async (itemId: string, reason: string) => {
    if (!id) return
    await api.post(`/shop-orders/${id}/items/${itemId}/unlock`, { reason })
    await loadOrder(id)
  }, [id])

  /** WI-05 — the tech's answer to "is this the same unit?". */
  const resolveUnitIdentity = useCallback(async (itemId: string, sameUnit: boolean) => {
    if (!id) return
    await api.post(`/shop-orders/${id}/items/${itemId}/resolve-identity`, { sameUnit })
    await loadOrder(id)
  }, [id])

  // Bulk status move + shared note for the selection (e.g. In Repair + "changed O2 sensor").
  async function runBulkStatus() {
    if (!id || selectedIds.size === 0 || !bulkStatusVal) return
    setBulkBusy(true)
    setError('')
    try {
      await api.post(`/shop-orders/${id}/bulk-status`, {
        itemIds: [...selectedIds],
        status: bulkStatusVal,
        note: bulkNote.trim() || undefined,
        // Only meaningful for on_hold; the server ignores it otherwise and
        // rejects the whole batch if it is missing when required.
        ...(bulkStatusVal === 'on_hold'
          ? { holdReason: holdReasonVal, holdNote: holdNoteVal.trim() || undefined }
          : {}),
      })
      exitSelect()
      await loadOrder(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch status change failed')
    } finally {
      setBulkBusy(false)
    }
  }

  // Batch clear (visual pass) or batch return for the checkbox selection.
  async function runBulk(kind: 'clear' | 'return') {
    if (!id || selectedIds.size === 0) return
    setBulkBusy(true)
    setError('')
    try {
      const path = kind === 'clear' ? 'bulk-clear' : 'bulk-return'
      const body: Record<string, unknown> = { itemIds: [...selectedIds] }
      if (kind === 'clear') body.attestedBy = order?.intakeByName || null
      await api.post(`/shop-orders/${id}/${path}`, body)
      exitSelect()
      await loadOrder(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Batch ${kind} failed`)
    } finally {
      setBulkBusy(false)
    }
  }

  async function generateInvoice() {
    if (!id || !order) return
    setGeneratingInvoice(true)
    try {
      const result = await api.post<any>('/invoices/generate/from-shop-wo', {
        shopWorkOrderId: id,
      })
      if (result?.invoiceNumber) {
        setInvoiceNumber(result.invoiceNumber)
        setWoExtrasBilled(true)
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to generate invoice')
    }
    setGeneratingInvoice(false)
  }

  async function submitReprint() {
    setReprinting(true)
    setReprintMsg('')
    try {
      const body: Record<string, unknown> = {
        copies: parseInt(reprintCopies, 10) || 1,
        reprintReason,
      }
      if (reprintItemId) body.itemId = reprintItemId
      await api.post(`/shop-orders/${id}/reprint`, body)
      setReprintMsg('Label queued for printing')
      setTimeout(() => { setShowReprint(false); setReprintMsg('') }, 1500)
    } catch (err) {
      setReprintMsg(err instanceof Error ? err.message : 'Reprint failed')
    } finally {
      setReprinting(false)
    }
  }

  async function submitAddUnits() {
    if (!id || addUnitDrafts.length === 0) return
    setAddingUnits(true)
    setAddUnitsError('')
    try {
      const updated = await api.post<any>(`/shop-orders/${id}/items`, {
        items: addUnitDrafts.map(buildShopItemPayload),
      })
      setShowAddUnits(false)
      setAddUnitDrafts([])
      // Fresh gear needs labels — hand off to the print-confirm dialog, which
      // reloads the order when the operator prints or skips. Only the units
      // that weren't on the WO before this add get listed.
      const known = new Set([...items.map(i => i.id), ...childItems.map(c => c.id)])
      setAddUnitsPrintUnits(collectLabelUnits(updated).filter(u => !known.has(u.itemId)))
      void loadOccupiedBins()
    } catch (err) {
      setAddUnitsError(err instanceof Error ? err.message : 'Failed to add units')
    } finally {
      setAddingUnits(false)
    }
  }

  async function claimItemFor(itemId: string, techUserId: string) {
    setClaimingItem(itemId)
    setError('')
    try {
      await api.post(`/claim/item/${itemId}`, { techUserId })
      if (id) await loadOrder(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Claim failed')
    } finally {
      setClaimingItem(null)
    }
  }

  async function initiateTransfer() {
    if (!id || !transferDest) { setTransferMsg('Pick a destination shop'); return }
    const itemIds = transferSelectMode ? [...transferSelected] : undefined
    if (transferSelectMode && itemIds!.length === 0) {
      setTransferMsg('Select at least one item to transfer')
      return
    }
    setTransferBusy(true)
    setTransferMsg(null)
    try {
      await api.post('/shop-transfers', {
        workOrderId: id,
        toSiteId: transferDest,
        notes: transferNotes.trim() || undefined,
        itemIds,
        transportedById: transportedById || undefined,
      })
      setTransferDest('')
      setTransferNotes('')
      setTransferSelected(new Set())
      setTransferSelectMode(false)
      setTransportedById('')
      setTransportedQuery('')
      await loadTransfers()
      await loadOrder(id)
    } catch (err) {
      setTransferMsg(err instanceof Error ? err.message : 'Transfer failed')
    } finally {
      setTransferBusy(false)
    }
  }

  async function receiveTransfer(eventId: string) {
    if (!id) return
    setTransferBusy(true)
    setTransferMsg(null)
    try {
      await api.post(`/shop-transfers/${eventId}/receive`)
      await loadTransfers()
      await loadOrder(id)
      // Prompt a fresh label — the original likely degraded in transit.
      setReprintItemId('')
      setReprintReason('transfer_arrival')
      setReprintMsg('')
      setShowReprint(true)
    } catch (err) {
      setTransferMsg(err instanceof Error ? err.message : 'Receive failed')
    } finally {
      setTransferBusy(false)
    }
  }

  async function changeItemStatus(
    itemId: string,
    newStatus: string,
    hold?: { holdReason: string; holdNote?: string },
  ) {
    if (!id) return

    // Intercept warranty/outside service — show form instead
    if (newStatus === 'warranty_out') {
      openSendOutForm(itemId, 'warranty')
      return
    }
    if (newStatus === 'outside_service') {
      openSendOutForm(itemId, 'outside')
      return
    }

    // WI-09 — coming back from a vendor is a receive, not a status flip. Same
    // interception the send-out uses, for the same reason: the moment carries
    // information that cannot be reconstructed afterwards, and the person who
    // has it is holding the invoice right now.
    if (newStatus === 'received') {
      const item = items.find(i => i.id === itemId)
      if (item && (item.status === 'outside_service' || item.status === 'warranty_out')) {
        setReceiveItem(itemId)
        return
      }
    }

    // QA gate: block "Ready for Pickup" until the equipment inspection is complete.
    if (newStatus === 'shop_complete') {
      const item = items.find(i => i.id === itemId)
      if (item && !item.parentItemId && isGatedCategory(item.equipmentCategory)) {
        const list = await loadItemInspections(itemId)
        if (!inspectionsSatisfyQa(item, list)) {
          // Open the QA inspection form; retry the move once it's saved complete.
          setPendingCompleteItemId(itemId)
          openQaEditor(item)
          return
        }
      }
    }

    setStatusChanging(itemId)
    try {
      await api.patch(`/shop-orders/${id}/items/${itemId}/status`, {
        status: newStatus,
        notes: `Status changed to ${newStatus.replace(/_/g, ' ')}`,
        ...(hold ?? {}),
      })

      await db.shopWorkOrderItems.update(itemId, { status: newStatus })
      setItems(prev => prev.map(i => i.id === itemId ? { ...i, status: newStatus } : i))

      // Re-fetch WO header to get server-computed status + completedItems
      try {
        const woData = await api.get<any>(`/shop-orders/${id}`)
        if (woData?.id && order) {
          const updatedOrder = {
            ...order,
            status: woData.status,
            completedItems: woData.completedItems ?? order.completedItems,
            completedDate: woData.completedDate || order.completedDate,
            returnedDate: woData.returnedDate || order.returnedDate,
          }
          setOrder(updatedOrder)
          // Also update Dexie so list page picks it up
          await db.shopWorkOrders.update(id, {
            status: woData.status,
            completedItems: woData.completedItems ?? order.completedItems,
          })
        }
      } catch {
        // Offline — compute locally
        const updatedItems = items.map(i => i.id === itemId ? { ...i, status: newStatus } : i)
        const completedCount = updatedItems.filter(i =>
          i.status === 'shop_complete' || i.status === 'returned' || i.status === 'condemned'
        ).length
        if (order) {
          setOrder({ ...order, completedItems: completedCount })
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change status')
    }
    setStatusChanging(null)
  }

  async function loadItemHistory(itemId: string) {
    if (itemHistory[itemId]) return
    try {
      const result = await api.get<{ data: StatusLogEntry[] }>(`/shop-orders/${id}/items/${itemId}/history`)
      setItemHistory(prev => ({ ...prev, [itemId]: result.data || [] }))
    } catch {
      // Offline
    }
  }

  // Returns the latest inspections for the item, fetching if not cached.
  async function loadItemInspections(itemId: string): Promise<OfflineEquipmentInspection[]> {
    try {
      const result = await api.get<{ inspections: OfflineEquipmentInspection[] }>(
        `/equipment-inspections?shopItemId=${itemId}`,
      )
      const list = result.inspections || []
      setItemInspections(prev => ({ ...prev, [itemId]: list }))
      return list
    } catch {
      // Offline — fall back to whatever Dexie has mirrored.
      const list = await db.equipmentInspections.where('shopItemId').equals(itemId).toArray()
      setItemInspections(prev => ({ ...prev, [itemId]: list }))
      return list
    }
  }

  // True when at least one inspection has a complete required QA checklist.
  function inspectionsSatisfyQa(item: OfflineShopWorkOrderItem, list: OfflineEquipmentInspection[]): boolean {
    if (!isGatedCategory(item.equipmentCategory)) return true
    const cat = inspectionCategoryFor(item.equipmentCategory)
    return list.some(insp => {
      if (insp.outcome === 'condemn' || insp.outcome === 'cannot_service') return true
      const qa = (insp.data as Record<string, unknown> | undefined)?.qaChecklist as Record<string, unknown> | undefined
      return qaChecklistComplete(cat, qa, insp.serviceActions)
    })
  }

  function openQaEditor(item: OfflineShopWorkOrderItem) {
    // Bench-start: putting it on the bench IS the inspection starting. Advance a
    // freshly-Received item to Inspecting (diagnosing) so that when the inspection
    // locks, its outcome can route the unit (Condemned / In Repair / At Vendor /
    // Ready) — those transitions are only legal from Inspecting onward.
    if (item.status === 'received') {
      changeItemStatus(item.id, 'diagnosing')
    }
    setQaEditorItem(item)
    loadItemInspections(item.id)
  }

  // Called by the inspection editor after a save. Merge the record into the
  // cache, and if it completes the QA checklist for an item that was on its way
  // to "Ready for Pickup", retry that transition automatically.
  function handleQaSaved(record: OfflineEquipmentInspection) {
    const itemId = record.shopItemId
    if (!itemId) return

    setItemInspections(prev => {
      const existing = prev[itemId] || []
      return { ...prev, [itemId]: [record, ...existing.filter(i => i.id !== record.id)] }
    })

    // A LOCKED inspection auto-routes the item server-side (pass → Ready,
    // fail/requires-parts → In Repair, FACTORY_RETURN → At Vendor, condemn →
    // Condemned). Reload to reflect the new status + WO rollup.
    if (record.lockedAt && id) {
      loadOrder(id)
      return
    }

    const item = items.find(i => i.id === itemId)
    if (item && pendingCompleteItemId === itemId) {
      const cat = inspectionCategoryFor(item.equipmentCategory)
      const qa = (record.data as Record<string, unknown> | undefined)?.qaChecklist as Record<string, unknown> | undefined
      const waived = record.outcome === 'condemn' || record.outcome === 'cannot_service'
      if (waived || qaChecklistComplete(cat, qa, record.serviceActions)) {
        setPendingCompleteItemId(null)
        changeItemStatus(itemId, 'shop_complete')
        return
      }
    }
    if (id) void loadOrder(id) // QA may have changed the linked service charges.
  }

  function toggleExpand(itemId: string) {
    if (editingItem) return // Don't collapse while editing
    if (expandedItem === itemId) {
      setExpandedItem(null)
    } else {
      setExpandedItem(itemId)
      loadItemHistory(itemId)
      if (!itemInspections[itemId]) loadItemInspections(itemId)
    }
  }

  function startEditing(item: OfflineShopWorkOrderItem) {
    loadCatalog()
    const existingParts: UsedPart[] = Array.isArray(item.partsUsed) ? (item.partsUsed as any[]).map(p => ({
      productId: p.productId || undefined,
      partNumber: p.partNumber || '',
      name: p.name || p.description || '',
      quantity: p.quantity || 1,
      unitCost: p.unitCost,
    })) : []

    const billing = billingEditFrom(item.billing)
    // Seed the labor rate from the customer's D6 contract rate when the unit
    // has none yet. Blank means "someone will type a number later" — and on a
    // contract customer that number is already decided, so leaving the box
    // empty just invites a wrong one.
    if (!billing.laborRate.trim() && contractRates.labor?.priceLevelName && contractRates.labor.rate != null) {
      billing.laborRate = String(contractRates.labor.rate)
    }
    setEdits({
      diagnosisNotes: item.diagnosisNotes || '',
      workNotes: item.workNotes || '',
      estimatedCost: item.estimatedCost != null ? String(item.estimatedCost) : '',
      partsUsed: existingParts,
      billing,
      serviceType: item.serviceType || '',
      equipmentCategory: item.equipmentCategory || '',
    })
    setEditingItem(item.id)
    setShowPartPicker(false)
    setPartSearch('')
    setPartCategoryFilter('')
  }

  function cancelEditing() {
    setEditingItem(null)
    setShowPartPicker(false)
    setPartSearch('')
  }

  function addPartFromCatalog(part: CatalogPart) {
    // Check if already in list
    const exists = edits.partsUsed.find(p => p.partNumber === part.partNumber)
    if (exists) {
      // Increment quantity
      setEdits(prev => ({
        ...prev,
        partsUsed: prev.partsUsed.map(p =>
          p.partNumber === part.partNumber ? { ...p, quantity: p.quantity + 1 } : p
        ),
      }))
    } else {
      // Price it the way the invoice will — the customer's pricebook first.
      const pricing = priceLine(priceLevels, part)
      setEdits(prev => ({
        ...prev,
        partsUsed: [...prev.partsUsed, {
          productId: part.id,
          partNumber: part.partNumber,
          name: part.name,
          quantity: 1,
          unitCost: pricing.rate ?? undefined,
          priceLevelName: pricing.priceLevelName,
          listPrice: pricing.listRate,
        }],
      }))
    }
    setShowPartPicker(false)
    setPartSearch('')
  }

  function addCustomPart() {
    setEdits(prev => ({
      ...prev,
      partsUsed: [...prev.partsUsed, {
        partNumber: '',
        name: '',
        quantity: 1,
      }],
    }))
  }

  function updatePart(index: number, field: keyof UsedPart, value: string | number) {
    setEdits(prev => ({
      ...prev,
      partsUsed: prev.partsUsed.map((p, i) => i === index ? { ...p, [field]: value } : p),
    }))
  }

  function cleanPartsUsed(parts: UsedPart[]) {
    return parts
      .filter(p => p.name || p.partNumber)
      .map(p => {
        const cleaned: Record<string, unknown> = {
          ...(p.productId ? { productId: p.productId } : {}),
          partNumber: p.partNumber,
          name: p.name,
          quantity: bnum(p.quantity) || 1,
        }
        if (hasMoney(p.unitCost)) cleaned.unitCost = round2(bnum(p.unitCost))
        return cleaned
      })
  }

  function removePart(index: number) {
    setEdits(prev => ({
      ...prev,
      partsUsed: prev.partsUsed.filter((_, i) => i !== index),
    }))
  }

  // Persist a bin location to a personal-monitor item, merging into existing
  // customData so monitor brand/model/gas survive. Empty value clears the bin.
  async function saveBinLocation(itemId: string, value: string) {
    if (!id) return
    setBinSaving(itemId)
    try {
      const cur = items.find(i => i.id === itemId)
      const prevCustom = cur?.customData && typeof cur.customData === 'object' ? cur.customData : {}
      const merged = { ...prevCustom, binLocation: value.trim() || null }
      await api.put(`/shop-orders/${id}/items/${itemId}`, { customData: merged })
      setItems(prev => prev.map(i => i.id === itemId ? { ...i, customData: merged } : i))
      await db.shopWorkOrderItems.update(itemId, { customData: merged })
      void loadOccupiedBins()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save bin location')
    } finally {
      setBinSaving(null)
    }
  }

  async function saveEdits(itemId: string) {
    if (!id) return
    setSaving(true)
    try {
      const currentItem = items.find(i => i.id === itemId)
      const typeLocked = currentItem && TYPE_EDIT_LOCKED_STATUSES.has(currentItem.status)

      const billingPayload = billingToPayload(edits.billing)
      const payload: any = {
        diagnosisNotes: edits.diagnosisNotes || null,
        workNotes: edits.workNotes || null,
        estimatedCost: edits.estimatedCost ? parseFloat(edits.estimatedCost) : null,
        partsUsed: edits.partsUsed.length > 0 ? cleanPartsUsed(edits.partsUsed) : null,
        billing: billingPayload,
      }
      // Only send the type fields when actually editable + actually changed.
      if (!typeLocked) {
        if (edits.serviceType && edits.serviceType !== currentItem?.serviceType) {
          payload.serviceType = edits.serviceType
        }
        if (edits.equipmentCategory && edits.equipmentCategory !== currentItem?.equipmentCategory) {
          payload.equipmentCategory = edits.equipmentCategory
        }
      }

      await api.put(`/shop-orders/${id}/items/${itemId}`, payload)

      // Update local state
      setItems(prev => prev.map(i => i.id === itemId ? {
        ...i,
        diagnosisNotes: payload.diagnosisNotes,
        workNotes: payload.workNotes,
        estimatedCost: payload.estimatedCost,
        partsUsed: payload.partsUsed,
        billing: payload.billing,
        ...(payload.serviceType ? { serviceType: payload.serviceType } : {}),
        ...(payload.equipmentCategory ? { equipmentCategory: payload.equipmentCategory } : {}),
      } : i))

      // Update Dexie
      await db.shopWorkOrderItems.update(itemId, {
        diagnosisNotes: payload.diagnosisNotes,
        workNotes: payload.workNotes,
        estimatedCost: payload.estimatedCost,
        partsUsed: payload.partsUsed,
        billing: payload.billing,
        ...(payload.serviceType ? { serviceType: payload.serviceType } : {}),
        ...(payload.equipmentCategory ? { equipmentCategory: payload.equipmentCategory } : {}),
      })

      setEditingItem(null)
      setShowPartPicker(false)
      await loadOrder(id) // Refresh the draft QA actions linked by the server.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes')
    }
    setSaving(false)
  }

  // Upload the outside-vendor invoice for the item being edited. Stores the file
  // via the generic file endpoint and pins its key onto the billing.vendor block.
  async function uploadVendorInvoice(itemId: string, file: File) {
    setVendorUploading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('entityType', 'shop-item')
      form.append('entityId', itemId)
      form.append('subPath', file.name)
      const token = localStorage.getItem('sundog_token')
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      })
      if (!res.ok) throw new Error('Upload failed')
      const out = await res.json() as { key: string; fileName: string }
      setEdits(prev => ({
        ...prev,
        billing: { ...prev.billing, vendorAttachmentKey: out.key, vendorAttachmentName: out.fileName },
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vendor invoice upload failed')
    } finally {
      setVendorUploading(false)
    }
  }

  // Persist the WO-level billing extras (mileage/trip + order misc). No-ops the
  // form when already billed by the sweep.
  async function saveWoExtras() {
    if (!id || woExtrasBilled) return
    setWoBillingSaving(true)
    setWoBillingMsg('')
    setError('')
    try {
      const n = (v: string) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0 }
      const mileage =
        n(woMileageMiles) > 0 && n(woMileageRate) > 0 ? { miles: n(woMileageMiles), rate: n(woMileageRate) }
        : n(woTripFlat) > 0 ? { flat: n(woTripFlat) }
        : null
      const misc = woMisc.filter(m => m.description.trim() || m.amount.trim()).map(m => ({ description: m.description.trim(), amount: n(m.amount) }))
      const billingExtras: Record<string, unknown> = {}
      if (mileage) billingExtras.mileage = mileage
      if (misc.length) billingExtras.misc = misc

      await api.put(`/shop-orders/${id}`, { billingExtras })
      const merged = { ...billingExtras }
      setOrder(prev => prev ? { ...prev, billingExtras: merged } : prev)
      try { await db.shopWorkOrders.update(id, { billingExtras: merged }) } catch { /* offline */ }
      setPayAtDropKey(k => k + 1)
      setWoBillingMsg('Saved. Bills with the invoice when the WO closes.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save WO billing')
    } finally {
      setWoBillingSaving(false)
    }
  }

  // Filtered catalog for picker — free-text search AND the QB catalog-category
  // dropdown ('' = all). Category filtering is what lets a D6 ticket pull the
  // "shop > D6" parts.
  const filteredCatalog = catalog.filter(p => {
    if (p.productType === 'service') return false
    if (partCategoryFilter && p.catalogCategory !== partCategoryFilter) return false
    if (!partSearch.trim()) return true
    const q = partSearch.toLowerCase()
    return p.name.toLowerCase().includes(q) || p.partNumber.toLowerCase().includes(q)
  })

  // Group by category for display
  const catalogByCategory = filteredCatalog.reduce<Record<string, CatalogPart[]>>((acc, p) => {
    if (!acc[p.category]) acc[p.category] = []
    acc[p.category].push(p)
    return acc
  }, {})

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="text-center py-20 text-slate-400">
        <p className="font-medium">{error || 'Work order not found'}</p>
        <button onClick={() => navigate('/shop')} className="mt-3 text-blue-600 text-sm font-medium">
          Back to Shop
        </button>
      </div>
    )
  }

  const progress = order.totalItems > 0 ? Math.round((order.completedItems / order.totalItems) * 100) : 0

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/shop')} className="p-2 -ml-2 text-slate-600 hover:text-slate-900">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-900">{order.workOrderNumber}</h1>
          {order.billingWaiver && <p className="mt-1 text-sm text-amber-800">Closed without billing · {order.billingWaiver.reason} · {formatCalendarDateNumeric(order.billingWaiver.waivedAt)}</p>}
          <p className="text-sm text-slate-500">
            {order.companyName}
            {order.isInternal && <span className="ml-1 text-blue-600 font-medium">(Internal)</span>}
          </p>
        </div>
        <button
          onClick={async () => {
            try {
              const token = localStorage.getItem('sundog_token')
              const res = await fetch(`/api/shop-orders/${id}/pdf`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              })
              if (!res.ok) throw new Error('PDF export failed')
              const blob = await res.blob()
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `work-order-${order.workOrderNumber || id}.pdf`
              a.click()
              URL.revokeObjectURL(url)
            } catch (e: any) {
              setError(e.message || 'PDF export failed')
            }
          }}
          className="p-2 text-slate-500 hover:text-blue-600"
          title="Export work order as PDF"
        >
          <FileDown className="w-5 h-5" />
        </button>
        <button
          onClick={() => { setShowReprint(true); setReprintMsg(''); setReprintItemId('') }}
          className="p-2 text-slate-500 hover:text-blue-600"
          title="Reprint label"
        >
          <Printer className="w-5 h-5" />
        </button>
        <span className={cn(
          'text-xs font-medium px-2.5 py-1 rounded-full',
          order.status === 'intake' ? 'bg-blue-100 text-blue-700' :
          order.status === 'in_progress' ? 'bg-green-100 text-green-700' :
          order.status === 'hold' ? 'bg-amber-100 text-amber-700' :
          order.status === 'complete' ? 'bg-emerald-100 text-emerald-700' :
          'bg-slate-100 text-slate-500',
        )}>
          {order.status === 'intake' ? 'New' :
           order.status === 'in_progress' ? 'Active' :
           order.status === 'hold' ? 'On Hold' :
           order.status === 'complete' ? 'Ready for Pickup' :
           order.status === 'closed' ? 'Done' :
           order.status.replace(/_/g, ' ')}
        </span>
      </div>

      {/* Contract pricing — stated once, up top, so it's known before anyone
          starts keying rates further down the page. */}
      {!order.isInternal && <ContractPricingBanner level={priceLevel} className="mb-4" />}

      {/* Credit hold — equipment can't leave the shop until AR clears it.
          Shown on any open WO, not just Ready for Pickup, so a hand doesn't
          walk a unit all the way to Returned before finding out. */}
      {companyCreditHold && order.status !== 'closed' && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border-2 border-red-600 bg-red-600 px-4 py-3 text-sm font-semibold text-white">
          <ShieldAlert className="w-5 h-5 mt-0.5 shrink-0" />
          <span>{CREDIT_HOLD_MESSAGE}</span>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline text-xs">dismiss</button>
        </div>
      )}

      {/* Reprint label modal */}
      {showReprint && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setShowReprint(false)}
        >
          <div className="bg-white rounded-lg p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-slate-900 mb-3">Reprint Label</h3>
            <label className="text-xs font-medium text-slate-500 block mb-1">Label</label>
            <select
              value={reprintItemId}
              onChange={e => setReprintItemId(e.target.value)}
              className="w-full mb-3 px-2 py-1.5 text-sm border border-slate-300 rounded"
            >
              <option value="">Whole work order</option>
              {items.flatMap(it => [
                <option key={it.id} value={it.id}>Item · S/N {it.serialNumber}</option>,
                ...childItems
                  .filter(c => c.parentId === it.id)
                  .map(c => (
                    <option key={c.id} value={c.id}>
                      {'  '}↳ S/N {c.serialNumber} · part of {c.parentSerial}
                    </option>
                  )),
              ])}
            </select>
            <div className="flex gap-3 mb-3">
              <div className="flex-1">
                <label className="text-xs font-medium text-slate-500 block mb-1">Reason</label>
                <select
                  value={reprintReason}
                  onChange={e => setReprintReason(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
                >
                  <option value="damaged">Damaged</option>
                  <option value="brakleen">Brakleen</option>
                  <option value="lost">Lost</option>
                  <option value="transfer_arrival">Transfer arrival</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="w-20">
                <label className="text-xs font-medium text-slate-500 block mb-1">Copies</label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={reprintCopies}
                  onChange={e => setReprintCopies(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
                />
              </div>
            </div>
            {reprintMsg && <p className="text-sm mb-3 text-slate-600">{reprintMsg}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowReprint(false)}
                className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900"
              >
                Cancel
              </button>
              <button
                onClick={submitReprint}
                disabled={reprinting}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {reprinting ? 'Queuing...' : 'Reprint'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add units modal — same entry surface as intake, appends to this WO */}
      {showAddUnits && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-slate-50 rounded-lg p-5 w-full max-w-2xl my-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold text-slate-900">Add units to {order.workOrderNumber}</h3>
              <button
                onClick={() => { setShowAddUnits(false); setAddUnitDrafts([]) }}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {order.status === 'complete' && (
              <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                This order is Ready for Pickup — adding units will reopen it until the new gear is serviced.
              </div>
            )}

            <ShopUnitEntry
              items={addUnitDrafts}
              onChange={setAddUnitDrafts}
              defaultCategory={order.primaryCategory}
              occupiedBins={occupiedBins}
            />

            {addUnitsError && (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {addUnitsError}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowAddUnits(false); setAddUnitDrafts([]) }}
                className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900"
              >
                Cancel
              </button>
              <button
                onClick={submitAddUnits}
                disabled={addingUnits || addUnitDrafts.length === 0}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-700 text-white rounded-lg font-medium hover:bg-blue-600 disabled:opacity-40"
              >
                {addingUnits ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Adding…</>
                ) : (
                  <>Add {addUnitDrafts.length} unit{addUnitDrafts.length !== 1 ? 's' : ''}</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Label print prompt for freshly added units */}
      {addUnitsPrintUnits !== null && id && (
        <ShopLabelPrintDialog
          woId={id}
          units={addUnitsPrintUnits}
          defaultPacketCopies={0}
          title="Print labels for the new units?"
          onDone={() => {
            setAddUnitsPrintUnits(null)
            loadOrder(id)
          }}
        />
      )}

      {/* Info Card */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            <div>
              <p className="text-slate-500 text-xs">Intake Date</p>
              <p className="font-medium">{formatCalendarDateNumeric(order.intakeDate)}</p>
            </div>
          </div>
          {order.promisedDate && (
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-400" />
              <div>
                <p className="text-slate-500 text-xs">Promised</p>
                <p className="font-medium">{formatCalendarDateNumeric(order.promisedDate)}</p>
              </div>
            </div>
          )}
          {order.poNumber && (
            <div>
              <p className="text-slate-500 text-xs">PO</p>
              <p className="font-medium">{order.poNumber}</p>
            </div>
          )}
          {order.afeNumber && (
            <div>
              <p className="text-slate-500 text-xs">AFE</p>
              <p className="font-medium">{order.afeNumber}</p>
            </div>
          )}
          {order.primaryCategory && (
            <div>
              <p className="text-slate-500 text-xs">Category</p>
              <p className="font-medium">{CATEGORY_LABELS[order.primaryCategory] || order.primaryCategory}</p>
            </div>
          )}
          {order.intakeByName && (
            <div>
              <p className="text-slate-500 text-xs">Received by</p>
              <p className="font-medium">{order.intakeByName}</p>
            </div>
          )}
        </div>

        {/* Progress */}
        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
            <span>Progress</span>
            <span>{order.completedItems} / {order.totalItems} items ({progress}%)</span>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      {/* Inter-site transfer */}
      {transferInfo && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Truck className="w-4 h-4 text-slate-500" />
            <h3 className="text-sm font-semibold text-slate-700">Shop Transfer</h3>
          </div>

          {transferMsg && (
            <div className="mb-3 p-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{transferMsg}</div>
          )}

          {(() => {
            const tItems = transferInfo.items
            const eligible = tItems.filter(i => !i.inTransitToSiteId)
            const openEvents = transferInfo.transfers.filter(t => !t.receivedAt)
            const siteName = (sid: string | null) =>
              transferSites.find(s => s.id === sid)?.name || '—'
            // Where items physically sit right now (in-transit items haven't moved yet).
            const presence = new Map<string, number>()
            for (const it of tItems) presence.set(it.siteId, (presence.get(it.siteId) ?? 0) + 1)
            const toggle = (itemId: string) =>
              setTransferSelected(prev => {
                const next = new Set(prev)
                if (next.has(itemId)) next.delete(itemId)
                else next.add(itemId)
                return next
              })
            return (
              <>
                <div className="text-sm text-slate-600 mb-3">
                  {presence.size <= 1 ? (
                    <>Currently at <span className="font-medium">{siteName([...presence.keys()][0] ?? null)}</span></>
                  ) : (
                    <span>
                      Items at{' '}
                      {[...presence.entries()].map(([sid, n], i) => (
                        <span key={sid}>
                          {i > 0 && ', '}
                          <span className="font-medium">{siteName(sid)}</span> ({n})
                        </span>
                      ))}
                    </span>
                  )}
                </div>

                {openEvents.map(ev => (
                  <div key={ev.id} className="mb-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
                    <p className="text-sm font-medium text-amber-900">
                      {ev.itemIds.length} item{ev.itemIds.length === 1 ? '' : 's'} in transit to {ev.toSite.name}
                    </p>
                    <p className="text-xs text-amber-700 mb-2">Items move to the destination once received there.</p>
                    <button
                      onClick={() => receiveTransfer(ev.id)}
                      disabled={transferBusy}
                      className="px-4 py-1.5 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
                    >
                      {transferBusy ? 'Receiving…' : 'Receive Here'}
                    </button>
                  </div>
                ))}

                {eligible.length > 0 && (
                  <div className="mt-1">
                    <div className="flex flex-wrap items-end gap-2">
                      <div>
                        <label className="text-[10px] font-medium text-slate-500 block mb-1">Transfer to</label>
                        <select
                          value={transferDest}
                          onChange={e => setTransferDest(e.target.value)}
                          className="px-2 py-1.5 text-sm border border-slate-300 rounded"
                        >
                          <option value="">Select shop…</option>
                          {transferSites.map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="relative">
                        <label className="text-[10px] font-medium text-slate-500 block mb-1">Transported by</label>
                        <input
                          type="text"
                          value={transportedQuery}
                          onChange={e => {
                            setTransportedQuery(e.target.value)
                            setTransportedById('')   // typing clears a prior pick
                            setTransportedOpen(true)
                          }}
                          onFocus={() => setTransportedOpen(true)}
                          onBlur={() => setTimeout(() => setTransportedOpen(false), 150)}
                          placeholder="Search employee… (optional)"
                          className="w-44 px-2 py-1.5 text-sm border border-slate-300 rounded"
                        />
                        {transportedOpen && transportedQuery.trim() && (() => {
                          const q = transportedQuery.trim().toLowerCase()
                          const matches = activeEmployees
                            .filter(e => e.name?.toLowerCase().includes(q))
                            .slice(0, 50)
                          return (
                            <div className="absolute z-30 top-full left-0 mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                              {matches.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-slate-400">No matching employee</div>
                              ) : matches.map(e => (
                                <button
                                  key={e.id}
                                  type="button"
                                  onMouseDown={ev => ev.preventDefault()}
                                  onClick={() => {
                                    setTransportedById(e.id)
                                    setTransportedQuery(e.name)
                                    setTransportedOpen(false)
                                  }}
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50"
                                >
                                  {e.name}
                                </button>
                              ))}
                            </div>
                          )
                        })()}
                      </div>
                      <input
                        type="text"
                        value={transferNotes}
                        onChange={e => setTransferNotes(e.target.value)}
                        placeholder="Notes (optional)"
                        className="flex-1 min-w-[140px] px-2 py-1.5 text-sm border border-slate-300 rounded"
                      />
                      <button
                        onClick={initiateTransfer}
                        disabled={transferBusy || !transferDest}
                        className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                      >
                        {transferBusy ? 'Sending…' : 'Initiate Transfer'}
                      </button>
                    </div>

                    {eligible.length > 1 && (
                      <div className="mt-2">
                        <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={transferSelectMode}
                            onChange={e => {
                              setTransferSelectMode(e.target.checked)
                              if (!e.target.checked) setTransferSelected(new Set())
                            }}
                          />
                          Select items to transfer{' '}
                          <span className="text-slate-400">
                            ({transferSelectMode ? `${transferSelected.size} chosen` : `whole order — all ${eligible.length}`})
                          </span>
                        </label>

                        {transferSelectMode && (
                          <div className="mt-2 border border-slate-200 rounded-lg divide-y divide-slate-100">
                            {eligible.map(it => (
                              <label key={it.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50">
                                <input
                                  type="checkbox"
                                  checked={transferSelected.has(it.id)}
                                  onChange={() => toggle(it.id)}
                                />
                                <span className="font-mono text-xs text-slate-400">#{it.itemNumber}</span>
                                <span className="flex-1 truncate">
                                  {it.serialNumber || it.equipmentDescription || it.equipmentCategory}
                                </span>
                                {presence.size > 1 && (
                                  <span className="text-[10px] text-slate-400">{siteName(it.siteId)}</span>
                                )}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {transferInfo.transfers.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
                    {transferInfo.transfers.map(t => (
                      <div key={t.id} className="text-xs text-slate-500 flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono">{t.fromSite.shortCode}</span>
                        <span>→</span>
                        <span className="font-mono">{t.toSite.shortCode}</span>
                        <span>· {t.itemIds.length} pc</span>
                        <span>· {t.transferredAt.slice(0, 10)}</span>
                        {t.transportedBy?.name && (
                          <span>· by {t.transportedBy.name}</span>
                        )}
                        {t.receivedAt
                          ? <span className="text-emerald-600">received {t.receivedAt.slice(0, 10)}</span>
                          : <span className="text-amber-600 font-medium">in transit</span>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )
          })()}
        </div>
      )}

      {/* Contacts */}
      {(order.dropOffContactName || order.pickupContactName) && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Contacts</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            {order.dropOffContactName && (
              <ContactReadout
                heading="Drop-off"
                name={order.dropOffContactName}
                phone={order.dropOffContactPhone}
                email={order.dropOffContactEmail}
                preferred={order.dropOffContactPreferred}
              />
            )}
            {order.pickupContactName && (
              <ContactReadout
                heading="Pickup / Ready"
                name={order.pickupContactName}
                phone={order.pickupContactPhone}
                email={order.pickupContactEmail}
                preferred={order.pickupContactPreferred}
                highlightWhen={order.status === 'complete'}
              />
            )}
          </div>
        </div>
      )}

      {/* WI-08 — pay at drop. Surfaced from intake onward, not only at release:
          a calibration is paid when the customer hands the unit over, and
          catching them again at pickup is the thing that was not working.
          Hidden on a closed order — the money question is settled by then. */}
      {order.status !== 'closed' && (
        <PayAtDropPanel
          workOrderId={id!}
          workOrderNumber={order.workOrderNumber}
          companyId={order.companyId}
          refreshKey={payAtDropKey}
          // Bump the key as well as reloading the order. Nothing incremented it
          // before, so the counter-collected figure the release form nets off
          // would have stayed stale until a page reload — and the total the
          // customer is asked for at handoff is the last thing that should lag.
          onChanged={() => { setPayAtDropKey(k => k + 1); if (id) void loadOrder(id) }}
        />
      )}

      {/* WI-10 — the communication log. Two cards, one component, one table.
          Customer chasing shows once the gear is Ready for Pickup (its original
          trigger); vendor chasing shows while anything is actually out at a
          vendor, which is when there is somebody to chase. */}
      {(showCustomerLog || showVendorLog) && (
        <div className="grid gap-4 mb-4 lg:grid-cols-2">
          {showCustomerLog && (
            <ContactLogCard
              party="customer"
              entries={contactEntries}
              onAdd={addContactEntry}
              onDelete={canDeleteContact ? deleteContactEntry : undefined}
            />
          )}
          {showVendorLog && (
            <ContactLogCard
              party="vendor"
              entries={contactEntries}
              onAdd={addContactEntry}
              onDelete={canDeleteContact ? deleteContactEntry : undefined}
            />
          )}
        </div>
      )}

      {/* Intake Notes */}
      {order.intakeNotes && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-medium text-slate-700 mb-1">Intake Notes</h3>
          <p className="text-sm text-slate-600">{order.intakeNotes}</p>
        </div>
      )}

      {/* Items */}
      <div className="bg-white rounded-lg border border-slate-200 mb-4">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900 flex items-center gap-2">
            <Package className="w-4 h-4" />
            Equipment ({items.length})
          </h2>
          {selectMode ? (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <span className="text-xs text-slate-500">{selectedIds.size} selected</span>
              <button type="button" onClick={() => { setBulkStatusOpen(v => !v); setBulkConfirm(null) }} disabled={selectedIds.size === 0 || bulkBusy}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-700 text-white hover:bg-violet-600 disabled:opacity-40">Set status</button>
              {/* WI-06 — the real QA: a checklist, pass/fail, exceptions per unit.
                  Distinct from "Clear", which is a single visual-pass
                  attestation that bypasses the checklist by design. */}
              <button type="button" onClick={() => { setQaOpen(v => !v); setBulkStatusOpen(false); setBulkConfirm(null) }} disabled={selectedIds.size === 0 || bulkBusy}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-700 text-white hover:bg-cyan-600 disabled:opacity-40">QA</button>
              <button type="button" onClick={() => { setBulkConfirm('clear'); setBulkStatusOpen(false) }} disabled={selectedIds.size === 0 || bulkBusy}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-700 text-white hover:bg-blue-600 disabled:opacity-40">Clear</button>
              <button type="button" onClick={() => { setBulkConfirm('return'); setBulkStatusOpen(false) }}
                disabled={selectedIds.size === 0 || bulkBusy || companyCreditHold}
                title={companyCreditHold ? CREDIT_HOLD_MESSAGE : undefined}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-40">Return</button>
              <button type="button" onClick={exitSelect} disabled={bulkBusy}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {can('shop_orders:edit') && order.status !== 'closed' && (
                <button type="button" onClick={() => { setShowAddUnits(true); setAddUnitsError('') }}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-700 text-white hover:bg-blue-600">
                  <Plus className="w-3.5 h-3.5" /> Add units
                </button>
              )}
              {items.length > 0 && (
                <button type="button" onClick={() => setSelectMode(true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-50">Select units</button>
              )}
            </div>
          )}
        </div>

        {/* Batch QA (WI-06) */}
        {qaOpen && selectedIds.size > 0 && (
          <BatchQaPanel
            key={[...selectedIds].sort().join(',')}
            workOrderId={id!}
            itemIds={[...selectedIds]}
            onClose={() => setQaOpen(false)}
            onDone={async () => { exitSelect(); if (id) await loadOrder(id) }}
          />
        )}

        {/* Batch status + shared note */}
        {bulkStatusOpen && (
          <div className="px-4 py-3 bg-violet-50 border-b border-violet-200 flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-[10px] font-medium text-violet-700 uppercase tracking-wide mb-1">Set {selectedIds.size} unit(s) to</label>
              <select value={bulkStatusVal} onChange={e => setBulkStatusVal(e.target.value)}
                className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
                <option value="diagnosing">Inspecting</option>
                <option value="in_work">In Repair</option>
                <option value="qc_testing">Re-Test</option>
                <option value="awaiting_parts">Awaiting Parts</option>
                <option value="awaiting_approval">Awaiting Approval</option>
                <option value="outside_service">At Vendor</option>
                <option value="on_hold">On Hold</option>
              </select>
            </div>
            {/* Reason is required to batch-park units, same rule as one at a time. */}
            {bulkStatusVal === 'on_hold' && (
              <div>
                <label className="block text-[10px] font-medium text-violet-700 uppercase tracking-wide mb-1">Hold reason</label>
                <select value={holdReasonVal} onChange={e => setHoldReasonVal(e.target.value)}
                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
                  {SETTABLE_HOLD_REASONS.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex-1 min-w-[180px]">
              <label className="block text-[10px] font-medium text-violet-700 uppercase tracking-wide mb-1">Note (applied to all)</label>
              <input value={bulkNote} onChange={e => setBulkNote(e.target.value)} placeholder='e.g. changed O2 sensor'
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" />
            </div>
            <button type="button" onClick={runBulkStatus} disabled={bulkBusy}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-violet-700 text-white hover:bg-violet-600 disabled:opacity-40">
              {bulkBusy ? '…' : 'Apply'}
            </button>
            <button type="button" onClick={() => setBulkStatusOpen(false)} disabled={bulkBusy}
              className="px-3 py-2 rounded-lg text-xs font-medium border border-slate-300 text-slate-600 hover:bg-white">Cancel</button>
          </div>
        )}

        {/* Batch action confirm */}
        {bulkConfirm && (
          <div className="px-4 py-3 bg-blue-50 border-b border-blue-200 flex items-center justify-between gap-3">
            <p className="text-xs text-blue-900">
              {bulkConfirm === 'clear'
                ? `Visually inspected these ${selectedIds.size} unit(s) — all pass? They'll move to Ready for Pickup (visual-only). The work bills when the whole order is released.`
                : `Release ${selectedIds.size} ready unit(s) (mark Returned)?`}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={() => { setBulkConfirm(null); runBulk(bulkConfirm) }} disabled={bulkBusy}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-700 text-white hover:bg-blue-600 disabled:opacity-40">
                {bulkBusy ? '…' : bulkConfirm === 'clear' ? 'Confirm clear' : 'Confirm return'}
              </button>
              <button type="button" onClick={() => setBulkConfirm(null)} disabled={bulkBusy}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-slate-600 hover:bg-white">Back</button>
            </div>
          </div>
        )}

        <div className="divide-y divide-slate-100">
          {items.map(item => {
            const isExpanded = expandedItem === item.id
            const isEditing = editingItem === item.id
            const transitions = ITEM_TRANSITIONS[item.status] || []
            const history = itemHistory[item.id] || []

            return (
              <div key={item.id}>
                <div className="flex items-stretch">
                {selectMode && (
                  <label className="flex items-center pl-4 cursor-pointer" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={() => toggleSelect(item.id)}
                      className="w-4 h-4 rounded border-slate-300 text-blue-700"
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={() => toggleExpand(item.id)}
                  className="flex-1 p-4 text-left hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-mono text-sm font-medium text-slate-900">{item.serialNumber}</span>
                        <span className="text-[10px] font-medium text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                          #{item.itemNumber}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>{CATEGORY_LABELS[item.equipmentCategory] || item.equipmentCategory}</span>
                        <span>&middot;</span>
                        <span>{SERVICE_LABELS[item.serviceType] || item.serviceType}</span>
                      </div>
                      {item.equipmentCategory === 'fire_extinguisher' && (item.fexBrand || item.fexSize || item.fexType) && (
                        <div className="flex items-center gap-1.5 text-[10px] text-orange-600 mt-0.5">
                          {item.fexBrand && <span>{item.fexBrand}</span>}
                          {item.fexBrand && (item.fexSize || item.fexType) && <span>·</span>}
                          {item.fexSize && <span>{item.fexSize}</span>}
                          {item.fexSize && item.fexType && <span>·</span>}
                          {item.fexType && <span>{item.fexType}</span>}
                        </div>
                      )}
                      {item.equipmentCategory === 'personal_monitor' && binLocationOf(item) && (
                        <div className="flex items-center gap-1 text-[10px] font-medium text-teal-600 mt-0.5">
                          <Package className="w-3 h-3" />
                          <span>{binLocationOf(item)}</span>
                        </div>
                      )}
                      {item.reportedIssue && (
                        <p className="text-xs text-slate-400 mt-1 truncate">{item.reportedIssue}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {item.isWarranty && (
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-amber-100 text-amber-800" title="Warranty repair — not billed to customer">
                          Warranty
                        </span>
                      )}
                      <span className={cn(
                        'text-[10px] font-medium px-2 py-0.5 rounded-full',
                        (ITEM_STATUS[item.status] || { color: 'bg-slate-100 text-slate-600' }).color,
                      )}>
                        {(ITEM_STATUS[item.status] || { label: item.status.replace(/_/g, ' ') }).label}
                      </span>
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                    </div>
                  </div>
                </button>
                {/* Optional Equipment Q&A sidecar — renders nothing unless configured AND healthy */}
                {!selectMode && (
                  <div className="flex items-center pr-4">
                    <EquipmentQaLauncherButton
                      serialNumber={item.serialNumber}
                      equipmentCategory={item.equipmentCategory}
                      equipmentDescription={item.equipmentDescription}
                      fexBrand={item.fexBrand}
                      fexSize={item.fexSize}
                      fexType={item.fexType}
                    />
                  </div>
                )}
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-4 pb-4 space-y-3">
                    {/* Bin location — quick edit, personal monitors only */}
                    {item.equipmentCategory === 'personal_monitor' && (
                      <BinLocationControl
                        value={binLocationOf(item)}
                        saving={binSaving === item.id}
                        onSave={v => saveBinLocation(item.id, v)}
                        occupiedBins={occupiedBins}
                        currentItemId={item.id}
                      />
                    )}

                    {/* Status transition buttons */}
                    {transitions.length > 0 && !isEditing && (
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-1.5">Move to:</p>
                        <div className="flex flex-wrap gap-1.5">
                          {transitions.map(t => {
                            // 'returned' = the unit going back to the customer,
                            // which is exactly what a credit hold withholds.
                            // Every other transition stays workable.
                            const heldBack = companyCreditHold && t === 'returned'
                            // WI-04: condemning needs evidence. Disable with the
                            // reason in the tooltip rather than letting the click
                            // fail — the attachment panel is right above.
                            const needsEvidence =
                              t === 'condemned'
                              && !item.parentItemId
                              && (attachmentCounts[item.id] ?? 0) === 0
                            return (
                              <button
                                key={t}
                                type="button"
                                onClick={() => {
                                  if (t === 'condemned' && needsEvidence) return
                                  if (t === 'on_hold') {
                                    setHoldReasonVal('waiting_internal')
                                    setHoldNoteVal('')
                                    setHoldPromptItemId(item.id)
                                  } else {
                                    changeItemStatus(item.id, t)
                                  }
                                }}
                                disabled={statusChanging === item.id || heldBack || needsEvidence}
                                title={
                                  heldBack ? CREDIT_HOLD_MESSAGE
                                  : needsEvidence ? CONDEMN_EVIDENCE_MESSAGE
                                  : undefined
                                }
                                className={cn(
                                  'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                                  'bg-white border-slate-200 text-slate-700 hover:border-blue-300 hover:bg-blue-50',
                                  statusChanging === item.id && 'opacity-50',
                                  (heldBack || needsEvidence) && 'opacity-40 cursor-not-allowed hover:border-slate-200 hover:bg-white',
                                )}
                              >
                                {statusChanging === item.id ? '...' : (ITEM_STATUS[t]?.label || t.replace(/_/g, ' '))}
                              </button>
                            )
                          })}
                        </div>

                        {/* WI-02 reason prompt. Not validation theatre: the
                            server refuses the transition without a reason, so
                            this is the form that makes the move possible. */}
                        {holdPromptItemId === item.id && (
                          <div className="mt-2 p-3 rounded-lg border border-orange-200 bg-orange-50 space-y-2">
                            <p className="text-xs font-semibold text-orange-800">
                              Why is this unit on hold?
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {SETTABLE_HOLD_REASONS.map(r => (
                                <button
                                  key={r.value}
                                  type="button"
                                  onClick={() => setHoldReasonVal(r.value)}
                                  className={cn(
                                    'px-3 py-1.5 rounded-lg text-xs font-medium border',
                                    holdReasonVal === r.value
                                      ? 'bg-orange-600 border-orange-600 text-white'
                                      : 'bg-white border-orange-200 text-orange-800 hover:bg-orange-100',
                                  )}
                                >
                                  {r.label}
                                </button>
                              ))}
                            </div>
                            <p className="text-[11px] text-orange-700">
                              Waiting on parts, customer approval, or an outside vendor?
                              Use those statuses instead — the board reads the reason
                              off the status.
                            </p>
                            <input
                              value={holdNoteVal}
                              onChange={e => setHoldNoteVal(e.target.value)}
                              maxLength={200}
                              placeholder="Optional detail, e.g. waiting on Dickinson to ship the spare"
                              className="w-full px-3 py-2 border border-orange-200 rounded-lg text-sm bg-white"
                            />
                            <div className="flex gap-2">
                              <button
                                type="button"
                                disabled={statusChanging === item.id}
                                onClick={() => {
                                  setHoldPromptItemId(null)
                                  changeItemStatus(item.id, 'on_hold', {
                                    holdReason: holdReasonVal,
                                    holdNote: holdNoteVal.trim() || undefined,
                                  })
                                }}
                                className="px-4 py-2 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-500 disabled:opacity-40"
                              >
                                Put on hold
                              </button>
                              <button
                                type="button"
                                onClick={() => setHoldPromptItemId(null)}
                                className="px-3 py-2 rounded-lg text-xs font-medium border border-slate-300 text-slate-600 hover:bg-white"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* WI-05: where this unit sits in its close window, and the
                        admin reopen when it is final. */}
                    {closeStates[item.id] && closeStates[item.id].state !== 'open' && (
                      <UnitCloseState
                        close={closeStates[item.id]}
                        onUnlock={
                          user?.role === 'platform_admin'
                            ? (reason) => unlockUnit(item.id, reason)
                            : undefined
                        }
                      />
                    )}

                    {/* WI-05: the one question worth interrupting for. */}
                    {identityCandidates
                      .filter(c => c.itemId === item.id)
                      .map(c => (
                        <IdentityPrompt
                          key={c.itemId}
                          candidate={c}
                          onResolve={(same) => resolveUnitIdentity(item.id, same)}
                        />
                      ))}

                    {/* WI-04: per-unit evidence. Sits directly above the QA
                        block because condemning is gated on it — the tech should
                        not have to go looking for where to attach the photo the
                        error message just asked for. */}
                    <UnitAttachments
                      shopItemId={item.id}
                      serialNumber={item.serialNumber}
                      onCountChange={n => setAttachmentCounts(prev =>
                        prev[item.id] === n ? prev : { ...prev, [item.id]: n },
                      )}
                    />

                    {/* QA inspection — required before "Ready for Pickup" */}
                    {!item.parentItemId && isGatedCategory(item.equipmentCategory) && !isEditing && (
                      (() => {
                        const insps = itemInspections[item.id] || []
                        const qaDone = inspectionsSatisfyQa(item, insps)
                        const hasAny = insps.length > 0
                        return (
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              type="button"
                              onClick={() => openQaEditor(item)}
                              className={cn(
                                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                                qaDone
                                  ? 'bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100'
                                  : 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100',
                              )}
                            >
                              <ClipboardCheck className="w-3.5 h-3.5" />
                              {hasAny ? 'Inspection' : 'Start Inspection'}
                            </button>
                            <span className={cn(
                              'text-[10px] font-medium px-2 py-0.5 rounded-full',
                              qaDone ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800',
                            )}>
                              {qaDone ? 'QA complete' : 'QA required for pickup'}
                            </span>
                          </div>
                        )
                      })()
                    )}

                    {/* Force-claim — assign a Received item to a tech */}
                    {item.status === 'received' && !isEditing && techs.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-1.5">Claim for:</p>
                        <div className="flex flex-wrap gap-1.5">
                          {techs.map(t => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => claimItemFor(item.id, t.id)}
                              disabled={claimingItem === item.id}
                              className={cn(
                                'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                                'bg-white border-slate-200 text-slate-700 hover:border-blue-300 hover:bg-blue-50',
                                claimingItem === item.id && 'opacity-50',
                              )}
                            >
                              {claimingItem === item.id ? '...' : t.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* WI-09 — vendor receive (intercepted from the status move) */}
                    {receiveItem === item.id && (
                      <VendorReceiveDialog
                        itemId={item.id}
                        serialNumber={item.serialNumber}
                        wasWarranty={!!item.isWarranty}
                        busy={receiving}
                        onCancel={() => setReceiveItem(null)}
                        onSubmit={submitReceive}
                      />
                    )}

                    {/* Send-out form (warranty / outside service) */}
                    {sendOutItem === item.id && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-3">
                        <div className="flex items-center gap-2 mb-1">
                          <Truck className="w-4 h-4 text-red-600" />
                          <h4 className="text-sm font-semibold text-red-800">
                            {sendOutType === 'warranty' ? 'Send Out for Warranty' : 'Send to Outside Service'}
                          </h4>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">
                            {sendOutType === 'warranty' ? 'Warranty Vendor' : 'Service Provider'}
                          </label>
                          <input
                            type="text"
                            value={sendOutType === 'warranty' ? sendOutVendor : sendOutTo}
                            onChange={e => sendOutType === 'warranty' ? setSendOutVendor(e.target.value) : setSendOutTo(e.target.value)}
                            placeholder={sendOutType === 'warranty' ? 'e.g. MSA, BW Technologies, RKI...' : 'e.g. Dräger Service Center...'}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-red-400 focus:border-red-400 outline-none"
                          />
                        </div>

                        {sendOutType === 'warranty' && (
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Ship To (address/location)</label>
                            <input
                              type="text"
                              value={sendOutTo}
                              onChange={e => setSendOutTo(e.target.value)}
                              placeholder="Vendor address or service center name"
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-red-400 focus:border-red-400 outline-none"
                            />
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Ship Method</label>
                            <select
                              value={sendOutMethod}
                              onChange={e => setSendOutMethod(e.target.value)}
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-red-400 focus:border-red-400 outline-none"
                            >
                              <option value="basin_truck">Basin Truck</option>
                              <option value="customer_drop_off">Customer Drop-off</option>
                              <option value="ups">UPS</option>
                              <option value="fedex">FedEx</option>
                              <option value="other_carrier">Other</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Tracking #</label>
                            <input
                              type="text"
                              value={sendOutTracking}
                              onChange={e => setSendOutTracking(e.target.value)}
                              placeholder="Optional"
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-red-400 focus:border-red-400 outline-none"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Shipped date <span className="font-normal text-slate-400">(defaults to today; backdate if it already left)</span></label>
                          <input
                            type="date"
                            value={sendOutDate}
                            max={(() => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` })()}
                            onChange={e => setSendOutDate(e.target.value)}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-red-400 focus:border-red-400 outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
                          <textarea
                            value={sendOutNotes}
                            onChange={e => setSendOutNotes(e.target.value)}
                            rows={2}
                            placeholder="Reason for sending out, what needs to be done, etc."
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-red-400 focus:border-red-400 outline-none"
                          />
                        </div>

                        <div className="flex gap-2 pt-1">
                          <button
                            type="button"
                            onClick={submitSendOut}
                            disabled={sendingOut}
                            className="flex items-center gap-1.5 px-4 py-2 bg-red-700 text-white rounded-lg text-xs font-medium hover:bg-red-600 disabled:opacity-50"
                          >
                            {sendingOut ? <Loader2 className="w-3 h-3 animate-spin" /> : <Truck className="w-3 h-3" />}
                            {sendingOut ? 'Sending...' : 'Confirm Send-Out'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setSendOutItem(null)}
                            className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Edit / View toggle */}
                    {!isEditing ? (
                      <>
                        {/* Read-only view */}
                        {item.diagnosisNotes && (
                          <div>
                            <p className="text-xs font-medium text-slate-500">Diagnosis</p>
                            <p className="text-sm text-slate-700">{item.diagnosisNotes}</p>
                          </div>
                        )}
                        {item.workNotes && (
                          <div>
                            <p className="text-xs font-medium text-slate-500">Work Performed</p>
                            <p className="text-sm text-slate-700">{item.workNotes}</p>
                          </div>
                        )}
                        {item.estimatedCost != null && (
                          <div>
                            <p className="text-xs font-medium text-slate-500">Estimated Cost</p>
                            <p className="text-sm font-medium text-slate-900">${Number(item.estimatedCost).toFixed(2)}</p>
                          </div>
                        )}

                        {/* Parts used (read-only) */}
                        {item.partsUsed && Array.isArray(item.partsUsed) && item.partsUsed.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-slate-500 mb-1">Parts & Labor</p>
                            <div className="space-y-1">
                              {(item.partsUsed as any[]).map((part: any, idx: number) => (
                                <div key={idx} className="flex items-center justify-between text-xs bg-slate-50 rounded p-2">
                                  <div>
                                    <span className="text-slate-700 font-medium">{part.name || part.partNumber || 'Part'}</span>
                                    {part.partNumber && <span className="text-slate-400 ml-1.5 font-mono text-[10px]">{part.partNumber}</span>}
                                  </div>
                                  <span className="text-slate-500 font-medium">
                                    x{part.quantity || 1}
                                    {hasMoney(part.unitCost) && <span className="ml-1 text-slate-400">(${bnum(part.unitCost).toFixed(2)} ea)</span>}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Edit button — gated by shop_orders:edit (Dispatch and above) */}
                        {can('shop_orders:edit') && (
                          <button
                            type="button"
                            onClick={() => startEditing(item)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
                          >
                            <Pencil className="w-3 h-3" />
                            Edit Work Details
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {/* ============ EDIT MODE ============ */}
                        <div className="bg-slate-50 rounded-lg p-3 space-y-3 border border-slate-200">
                          {/* Equipment Category + Service Type — locked once in QA */}
                          {!TYPE_EDIT_LOCKED_STATUSES.has(item.status) && (
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Equipment</label>
                                <select
                                  value={edits.equipmentCategory}
                                  onChange={e => setEdits(prev => ({ ...prev, equipmentCategory: e.target.value }))}
                                  className="w-full px-2 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                >
                                  {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                                    <option key={k} value={k}>{v}</option>
                                  ))}
                                </select>
                                {edits.equipmentCategory !== item.equipmentCategory && (
                                  <p className="mt-1 text-[11px] text-amber-700">
                                    Changing equipment wipes existing sub-components.
                                  </p>
                                )}
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">Service Type</label>
                                <select
                                  value={edits.serviceType}
                                  onChange={e => setEdits(prev => ({ ...prev, serviceType: e.target.value }))}
                                  className="w-full px-2 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                                >
                                  {Object.entries(SERVICE_LABELS).map(([k, v]) => (
                                    <option key={k} value={k}>{v}</option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          )}

                          {/* Diagnosis */}
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Diagnosis</label>
                            <textarea
                              value={edits.diagnosisNotes}
                              onChange={e => setEdits(prev => ({ ...prev, diagnosisNotes: e.target.value }))}
                              rows={2}
                              placeholder="What's wrong with it? e.g. Needs new VOC sensor, cracked housing..."
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                            />
                          </div>

                          {/* Work Notes */}
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Work Performed</label>
                            <textarea
                              value={edits.workNotes}
                              onChange={e => setEdits(prev => ({ ...prev, workNotes: e.target.value }))}
                              rows={2}
                              placeholder="What did you do? e.g. Replaced VOC sensor, bumped, calibrated..."
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                            />
                          </div>

                          {/* Estimated Cost */}
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Estimated Cost</label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                              <input
                                type="number"
                                step="0.01"
                                value={edits.estimatedCost}
                                onChange={e => setEdits(prev => ({ ...prev, estimatedCost: e.target.value }))}
                                placeholder="0.00"
                                className="w-full pl-7 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                              />
                            </div>
                          </div>

                          {/* Parts & Labor */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <label className="text-xs font-medium text-slate-600">Parts & Labor</label>
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => { setShowPartPicker(!showPartPicker); setPartSearch('') }}
                                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-blue-700 bg-blue-50 rounded hover:bg-blue-100"
                                >
                                  <Search className="w-3 h-3" />
                                  From Catalog
                                </button>
                                <button
                                  type="button"
                                  onClick={addCustomPart}
                                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-slate-600 bg-slate-100 rounded hover:bg-slate-200"
                                >
                                  <Plus className="w-3 h-3" />
                                  Custom
                                </button>
                              </div>
                            </div>

                            {/* Part picker dropdown */}
                            {showPartPicker && (
                              <div className="mb-2 border border-blue-200 rounded-lg bg-white overflow-hidden">
                                <div className="p-2 border-b border-slate-100 space-y-1.5">
                                  {catalogCategories.length > 0 && (
                                    <select
                                      value={partCategoryFilter}
                                      onChange={e => setPartCategoryFilter(e.target.value)}
                                      className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-500 outline-none"
                                    >
                                      <option value="">All categories</option>
                                      {catalogCategories.map(c => (
                                        <option key={c} value={c}>{c}</option>
                                      ))}
                                    </select>
                                  )}
                                  <input
                                    type="text"
                                    value={partSearch}
                                    onChange={e => setPartSearch(e.target.value)}
                                    placeholder="Search parts..."
                                    className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none"
                                    autoFocus
                                  />
                                </div>
                                <div className="max-h-48 overflow-y-auto">
                                  {Object.entries(catalogByCategory).map(([cat, parts]) => (
                                    <div key={cat}>
                                      <div className="px-2 py-1 bg-slate-50 text-[10px] font-bold text-slate-500 uppercase tracking-wide sticky top-0">
                                        {CATALOG_CATEGORY_LABELS[cat] || cat}
                                      </div>
                                      {parts.map(p => (
                                        <button
                                          key={p.id}
                                          type="button"
                                          disabled={p.defaultSellPrice == null}
                                          title={p.defaultSellPrice == null ? 'Catalog item has no unit price' : undefined}
                                          onClick={() => addPartFromCatalog(p)}
                                          className="w-full px-2 py-1.5 text-left hover:bg-blue-50 flex items-center justify-between disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
                                        >
                                          <div>
                                            <span className="text-xs font-medium text-slate-800">{p.name}</span>
                                            <span className="text-[10px] text-slate-400 ml-1.5 font-mono">{p.partNumber}</span>
                                          </div>
                                          {(() => {
                                            // Quote what THIS customer pays,
                                            // in the picker — seeing list here
                                            // and a contract price on the line
                                            // right after reads as a bug.
                                            const pricing = priceLine(priceLevels, p)
                                            if (pricing.rate == null) return <span className="text-[10px] text-amber-600">Unpriced</span>
                                            return pricing.priceLevelName ? (
                                              <span className="text-[10px] text-violet-700 font-medium">
                                                ${pricing.rate.toFixed(2)}
                                                {pricing.listRate != null && Math.abs(pricing.listRate - pricing.rate) > 0.005 && (
                                                  <s className="text-slate-400 font-normal ml-1">${pricing.listRate.toFixed(2)}</s>
                                                )}
                                              </span>
                                            ) : (
                                              <span className="text-[10px] text-slate-400">${pricing.rate.toFixed(2)}</span>
                                            )
                                          })()}
                                        </button>
                                      ))}
                                    </div>
                                  ))}
                                  {filteredCatalog.length === 0 && (
                                    <p className="p-3 text-xs text-slate-400 text-center">No parts found</p>
                                  )}
                                </div>
                              </div>
                            )}

                            {/* Parts list */}
                            {edits.partsUsed.length > 0 && (
                              <div className="space-y-1.5">
                                {edits.partsUsed.map((part, idx) => (
                                  <div key={idx} className="flex items-center gap-2 bg-white border border-slate-200 rounded p-2">
                                    <div className="flex-1 min-w-0">
                                      {part.productId ? (
                                        <p className="text-xs font-medium text-slate-800 truncate">{part.name}</p>
                                      ) : (
                                        <input
                                          type="text"
                                          value={part.name}
                                          onChange={e => updatePart(idx, 'name', e.target.value)}
                                          placeholder="Part/labor description"
                                          className="w-full text-xs font-medium text-slate-800 border-0 border-b border-dashed border-slate-300 pb-0.5 focus:border-blue-500 outline-none bg-transparent"
                                        />
                                      )}
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        {part.partNumber && (
                                          <span className="text-[10px] text-slate-400 font-mono">{part.partNumber}</span>
                                        )}
                                        {hasMoney(part.unitCost) && (
                                          <span className="text-[10px] text-slate-500">${bnum(part.unitCost).toFixed(2)} ea</span>
                                        )}
                                        <ContractPriceBadge
                                          priceLevelName={part.priceLevelName}
                                          listRate={part.listPrice}
                                          contractRate={part.priceLevelName && hasMoney(part.unitCost) ? bnum(part.unitCost) : null}
                                          currentRate={hasMoney(part.unitCost) ? bnum(part.unitCost) : null}
                                        />
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <label className="text-[10px] text-slate-400">qty</label>
                                      <QuantityInput
                                        min={1}
                                        value={part.quantity}
                                        onChange={qty => updatePart(idx, 'quantity', qty)}
                                        className="w-12 px-1.5 py-0.5 border border-slate-200 rounded text-xs text-center"
                                      />
                                      <label className="text-[10px] text-slate-400">ea</label>
                                      <div className="relative w-20">
                                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">$</span>
                                        <input
                                          type="number"
                                          step="0.01"
                                          min="0"
                                          inputMode="decimal"
                                          value={part.unitCost ?? ''}
                                          onChange={e => updatePart(idx, 'unitCost', e.target.value)}
                                          placeholder="0.00"
                                          className="w-full pl-4 pr-1.5 py-0.5 border border-slate-200 rounded text-xs text-right outline-none focus:ring-1 focus:ring-blue-500"
                                        />
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => removePart(idx)}
                                        className="p-0.5 text-slate-300 hover:text-red-500"
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Billing chunk — how we charge for this unit */}
                          <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/60 space-y-3">
                            <div className="flex items-center gap-1.5">
                              <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
                              <span className="text-xs font-semibold text-slate-700">Billing</span>
                            </div>

                            {/* This customer isn't on list pricing — say so
                                where the rates are actually typed. */}
                            <ContractPricingBanner level={priceLevel} />

                            <ShopServicePicker category={inspectionCategoryFor(item.equipmentCategory)} value={edits.billing.services} onChange={services => setEdits(prev => ({ ...prev, billing: { ...prev.billing, services, rollupEnabled: services.length ? false : prev.billing.rollupEnabled } }))} />

                            {/* Roll-up toggle — inspection/visual "N units × rate" */}
                            <label className="flex items-center gap-2 text-xs text-slate-600">
                              <input
                                type="checkbox"
                                checked={edits.billing.rollupEnabled}
                                onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, rollupEnabled: e.target.checked } }))}
                                className="rounded border-slate-300"
                              />
                              Bill as inspection/visual roll-up (groups with like units: <em>N × rate</em>)
                            </label>
                            {edits.billing.rollupEnabled ? (
                              <div>
                                <label className="block text-[10px] font-medium text-slate-500 mb-1">Roll-up rate / unit (blank = catalog default)</label>
                                <div className="relative w-36">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                                  <input
                                    type="number" step="0.01" inputMode="decimal"
                                    value={edits.billing.rollupRate}
                                    onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, rollupRate: e.target.value } }))}
                                    placeholder="0.00"
                                    className="w-full pl-5 pr-2 py-1.5 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500"
                                  />
                                </div>
                              </div>
                            ) : (
                              <>
                                {/* Labor time */}
                                <div>
                                  <label className="block text-[10px] font-medium text-slate-500 mb-1">Labor time</label>
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="number" step="0.25" inputMode="decimal"
                                      value={edits.billing.laborHours}
                                      onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, laborHours: e.target.value } }))}
                                      placeholder="hrs"
                                      className="w-20 px-2 py-1.5 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                    <span className="text-xs text-slate-400">hrs ×</span>
                                    <div className="relative w-24">
                                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                                      <input
                                        type="number" step="0.01" inputMode="decimal"
                                        value={edits.billing.laborRate}
                                        onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, laborRate: e.target.value } }))}
                                        placeholder="rate"
                                        className="w-full pl-5 pr-2 py-1.5 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500"
                                      />
                                    </div>
                                    <span className="text-xs text-slate-500 ml-auto">
                                      {(() => {
                                        const h = parseFloat(edits.billing.laborHours), r = parseFloat(edits.billing.laborRate)
                                        return Number.isFinite(h) && Number.isFinite(r) ? `= $${(h * r).toFixed(2)}` : ''
                                      })()}
                                    </span>
                                  </div>
                                  {contractRates.labor?.priceLevelName && contractRates.labor.rate != null && (
                                    <div className="mt-1">
                                      <ContractPriceBadge
                                        priceLevelName={contractRates.labor.priceLevelName}
                                        listRate={contractRates.labor.listRate}
                                        contractRate={contractRates.labor.rate}
                                        currentRate={edits.billing.laborRate.trim() ? parseFloat(edits.billing.laborRate) : contractRates.labor.rate}
                                      />
                                    </div>
                                  )}
                                </div>

                                {/* Outside vendor passthrough + invoice attachment */}
                                <div>
                                  <label className="block text-[10px] font-medium text-slate-500 mb-1">Outside vendor billing</label>
                                  <select aria-label="Vendor billing method" value={edits.billing.vendorMode} className="w-full border rounded p-2 text-xs mb-2" onChange={e => {
                                    const mode = e.target.value as 'passthrough' | 'catalog_service'
                                    setEdits(prev => ({ ...prev, billing: { ...prev.billing, vendorMode: mode,
                                      services: mode === 'passthrough' && prev.billing.vendorMode === 'catalog_service'
                                        ? prev.billing.services.filter(s => s.productId !== prev.billing.vendorServiceProductId) : prev.billing.services,
                                      vendorServiceProductId: mode === 'passthrough' ? '' : prev.billing.vendorServiceProductId,
                                    } }))
                                  }}>
                                    <option value="passthrough">Pass through vendor cost + markup / freight</option>
                                    <option value="catalog_service">Bill our catalog service at our selling price</option>
                                  </select>
                                  {edits.billing.vendorMode === 'catalog_service' && <div className="space-y-2 mb-2">
                                    <select aria-label="Service covering vendor work" value={edits.billing.vendorServiceProductId} className="w-full border rounded p-2 text-xs" onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, vendorServiceProductId: e.target.value } }))}>
                                      <option value="">Choose a service added above…</option>
                                      {edits.billing.services.map(s => <option key={s.productId} value={s.productId}>{s.partNumber} — {s.name} — ${(s.quantity * s.rate).toFixed(2)}</option>)}
                                    </select>
                                    <p className="text-xs text-slate-500">Add the service under “Services performed” and set its customer price there. Vendor cost stays internal; only that service is charged. Freight and markup below are not added in this mode. Switching back to pass-through removes the linked service charge.</p>
                                  </div>}
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <div className="relative w-24">
                                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                                      <input
                                        type="number" step="0.01" inputMode="decimal"
                                        value={edits.billing.vendorCost}
                                        onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, vendorCost: e.target.value } }))}
                                        placeholder="cost"
                                        className="w-full pl-5 pr-2 py-1.5 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500"
                                      />
                                    </div>
                                    <div className="relative w-24">
                                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                                      <input
                                        type="number" step="0.01" inputMode="decimal"
                                        value={edits.billing.vendorFreight}
                                        disabled={edits.billing.vendorMode === 'catalog_service'}
                                        onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, vendorFreight: e.target.value } }))}
                                        placeholder="freight"
                                        className="w-full pl-5 pr-2 py-1.5 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500"
                                      />
                                    </div>
                                    <div className="relative w-20">
                                      <input
                                        type="number" step="1" inputMode="decimal"
                                        value={edits.billing.vendorMarkupPct}
                                        disabled={edits.billing.vendorMode === 'catalog_service'}
                                        onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, vendorMarkupPct: e.target.value } }))}
                                        placeholder="markup"
                                        className="w-full pl-2 pr-5 py-1.5 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500"
                                      />
                                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">%</span>
                                    </div>
                                  </div>
                                  <div className="mt-1.5 flex items-center gap-2">
                                    {edits.billing.vendorAttachmentKey ? (
                                      <span className="flex items-center gap-1 text-[11px] text-emerald-700">
                                        <FileCheck className="w-3.5 h-3.5" />
                                        {edits.billing.vendorAttachmentName || 'Invoice attached'}
                                        <button
                                          type="button"
                                          onClick={() => setEdits(prev => ({ ...prev, billing: { ...prev.billing, vendorAttachmentKey: null, vendorAttachmentName: null } }))}
                                          className="text-slate-400 hover:text-red-500 ml-1"
                                        >
                                          <X className="w-3 h-3" />
                                        </button>
                                      </span>
                                    ) : (
                                      <label className={cn(
                                        'flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded cursor-pointer',
                                        vendorUploading ? 'bg-slate-100 text-slate-400' : 'text-blue-700 bg-blue-50 hover:bg-blue-100',
                                      )}>
                                        {vendorUploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDown className="w-3 h-3" />}
                                        {vendorUploading ? 'Uploading…' : 'Attach vendor invoice'}
                                        <input
                                          type="file"
                                          accept="image/*,application/pdf"
                                          disabled={vendorUploading}
                                          onChange={e => { const f = e.target.files?.[0]; if (f) uploadVendorInvoice(item.id, f); e.currentTarget.value = '' }}
                                          className="hidden"
                                        />
                                      </label>
                                    )}
                                  </div>
                                </div>
                              </>
                            )}

                            {/* Per-unit misc charges */}
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <label className="text-[10px] font-medium text-slate-500">Misc charges</label>
                                <button
                                  type="button"
                                  onClick={() => setEdits(prev => ({ ...prev, billing: { ...prev.billing, misc: [...prev.billing.misc, { description: '', amount: '' }] } }))}
                                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-slate-600 bg-slate-100 rounded hover:bg-slate-200"
                                >
                                  <Plus className="w-3 h-3" /> Add
                                </button>
                              </div>
                              {edits.billing.misc.map((m, mi) => (
                                <div key={mi} className="flex items-center gap-2 mb-1.5">
                                  <input
                                    type="text"
                                    value={m.description}
                                    onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, misc: prev.billing.misc.map((x, i) => i === mi ? { ...x, description: e.target.value } : x) } }))}
                                    placeholder="Description (e.g. shop supplies)"
                                    className="flex-1 px-2 py-1.5 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500"
                                  />
                                  <div className="relative w-24">
                                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                                    <input
                                      type="number" step="0.01" inputMode="decimal"
                                      value={m.amount}
                                      onChange={e => setEdits(prev => ({ ...prev, billing: { ...prev.billing, misc: prev.billing.misc.map((x, i) => i === mi ? { ...x, amount: e.target.value } : x) } }))}
                                      placeholder="0.00"
                                      className="w-full pl-5 pr-2 py-1.5 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setEdits(prev => ({ ...prev, billing: { ...prev.billing, misc: prev.billing.misc.filter((_, i) => i !== mi) } }))}
                                    className="p-0.5 text-slate-300 hover:text-red-500"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Save / Cancel */}
                          <div className="flex gap-2 pt-2">
                            <button
                              type="button"
                              onClick={() => saveEdits(item.id)}
                              disabled={saving}
                              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-700 text-white rounded-lg text-xs font-medium hover:bg-emerald-600 disabled:opacity-50"
                            >
                              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                              {saving ? 'Saving...' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditing}
                              className="flex items-center gap-1.5 px-4 py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50"
                            >
                              <X className="w-3 h-3" />
                              Cancel
                            </button>
                          </div>
                        </div>
                      </>
                    )}

                    {/* Warranty info (always visible) */}
                    {!isEditing && (item.isWarranty || item.sentOutTo) && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          {item.isWarranty ? (
                            <AlertTriangle className="w-4 h-4 text-red-600" />
                          ) : (
                            <Truck className="w-4 h-4 text-red-600" />
                          )}
                          <span className="text-xs font-semibold text-red-800">
                            {item.isWarranty ? 'Warranty' : 'Outside Service'}
                          </span>
                        </div>
                        {item.sentOutTo && <p className="text-xs text-red-700">Sent to: {item.sentOutTo}</p>}
                        {item.sentOutDate && <p className="text-xs text-red-700">Date: {new Date(item.sentOutDate).toLocaleDateString()}</p>}
                        {item.sentOutTracking && <p className="text-xs text-red-700">Tracking: {item.sentOutTracking}</p>}
                        {item.sentOutMethod && <p className="text-xs text-red-700">Via: {item.sentOutMethod.replace(/_/g, ' ')}</p>}
                        {item.receivedBackDate && (
                          <p className="text-xs text-green-700 mt-1 flex items-center gap-1">
                            <RotateCcw className="w-3 h-3" />
                            Received back {formatCalendarDateNumeric(item.receivedBackDate)}
                          </p>
                        )}
                      </div>
                    )}

                    {/* QC (always visible) */}
                    {!isEditing && item.qcResult && (
                      <div className="flex items-center gap-2">
                        <ClipboardCheck className="w-4 h-4 text-cyan-600" />
                        <span className={cn(
                          'text-xs font-medium',
                          item.qcResult === 'pass' ? 'text-green-700' : 'text-red-700',
                        )}>
                          QC: {item.qcResult.toUpperCase()}
                        </span>
                        {item.qcNotes && <span className="text-xs text-slate-500">— {item.qcNotes}</span>}
                      </div>
                    )}

                    {/* Status history */}
                    {!isEditing && history.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-slate-500 mb-1.5">Status History</p>
                        <div className="space-y-1.5">
                          {history.map(h => (
                            <div key={h.id} className="flex items-start gap-2 text-xs">
                              <div className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-1.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <span className="font-medium text-slate-700">
                                  {h.fromStatus ? `${ITEM_STATUS[h.fromStatus]?.label || h.fromStatus.replace(/_/g, ' ')} → ` : ''}
                                  {ITEM_STATUS[h.toStatus]?.label || h.toStatus.replace(/_/g, ' ')}
                                </span>
                                {h.changedBy?.name && (
                                  <span className="text-slate-400 ml-1">by {h.changedBy.name}</span>
                                )}
                                <span className="text-slate-400 ml-1">
                                  {new Date(h.createdAt).toLocaleDateString()} {new Date(h.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                                {h.notes && <p className="text-slate-500 mt-0.5">{h.notes}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Notes */}
      {order.notes && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
          <h3 className="text-sm font-medium text-slate-700 mb-1">Notes</h3>
          <p className="text-sm text-slate-600">{order.notes}</p>
        </div>
      )}

      <ShopChargeBreakdown preview={chargePreview} error={chargePreviewError} />

      {/* Order charges (mileage / misc) — WO-level billing extras. Bills once,
          alongside the per-unit lines, when the WO closes and generates its one
          invoice (WO-direct billing — no mid-job sweep). Hidden for internal WOs. */}
      {!order.isInternal && (() => {
        return (
          <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4 space-y-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-slate-600">Order charges (mileage / misc)</p>
                {woExtrasBilled && (
                  <span className="text-[10px] font-medium text-slate-400">billed — locked</span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="text-slate-500">Mileage</span>
                <input
                  type="number" step="1" inputMode="decimal" disabled={woExtrasBilled}
                  value={woMileageMiles}
                  onChange={e => setWoMileageMiles(e.target.value)}
                  placeholder="miles"
                  className="w-20 px-2 py-1.5 border border-slate-300 rounded outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100"
                />
                <span className="text-slate-400">×</span>
                <div className="relative w-24">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                  <input
                    type="number" step="0.01" inputMode="decimal" disabled={woExtrasBilled}
                    value={woMileageRate}
                    onChange={e => setWoMileageRate(e.target.value)}
                    placeholder="rate"
                    className="w-full pl-5 pr-2 py-1.5 border border-slate-300 rounded outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100"
                  />
                </div>
                {contractRates.mileage?.priceLevelName && contractRates.mileage.rate != null && (
                  <ContractPriceBadge
                    priceLevelName={contractRates.mileage.priceLevelName}
                    listRate={contractRates.mileage.listRate}
                    contractRate={contractRates.mileage.rate}
                    currentRate={woMileageRate.trim() ? parseFloat(woMileageRate) : contractRates.mileage.rate}
                  />
                )}
                <span className="text-slate-400">or flat</span>
                <div className="relative w-24">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                  <input
                    type="number" step="0.01" inputMode="decimal" disabled={woExtrasBilled}
                    value={woTripFlat}
                    onChange={e => setWoTripFlat(e.target.value)}
                    placeholder="trip"
                    className="w-full pl-5 pr-2 py-1.5 border border-slate-300 rounded outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100"
                  />
                </div>
              </div>
              {woMisc.map((m, mi) => (
                <div key={mi} className="flex items-center gap-2 text-xs">
                  <input
                    type="text" disabled={woExtrasBilled}
                    value={m.description}
                    onChange={e => setWoMisc(prev => prev.map((x, i) => i === mi ? { ...x, description: e.target.value } : x))}
                    placeholder="Misc description"
                    className="flex-1 px-2 py-1.5 border border-slate-300 rounded outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100"
                  />
                  <div className="relative w-24">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                    <input
                      type="number" step="0.01" inputMode="decimal" disabled={woExtrasBilled}
                      value={m.amount}
                      onChange={e => setWoMisc(prev => prev.map((x, i) => i === mi ? { ...x, amount: e.target.value } : x))}
                      placeholder="0.00"
                      className="w-full pl-5 pr-2 py-1.5 border border-slate-300 rounded outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100"
                    />
                  </div>
                  <button type="button" disabled={woExtrasBilled} onClick={() => setWoMisc(prev => prev.filter((_, i) => i !== mi))} className="p-0.5 text-slate-300 hover:text-red-500 disabled:opacity-30">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {!woExtrasBilled && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setWoMisc(prev => [...prev, { description: '', amount: '' }])}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-slate-600 bg-slate-100 rounded hover:bg-slate-200"
                  >
                    <Plus className="w-3 h-3" /> Misc
                  </button>
                  <button
                    type="button"
                    onClick={saveWoExtras}
                    disabled={woBillingSaving}
                    className="flex items-center gap-1 px-3 py-1 text-[11px] font-medium text-white bg-emerald-700 rounded hover:bg-emerald-600 disabled:opacity-50"
                  >
                    {woBillingSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                    Save order charges
                  </button>
                  {woBillingMsg && <span className="text-[10px] text-emerald-700">{woBillingMsg}</span>}
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Release / Pickup Button — inert while the customer is on credit hold.
          Left visible-but-disabled rather than hidden so it's obvious the
          release is being withheld, not missing. */}
      {order.status === 'complete' && !showRelease && (
        <button
          type="button"
          onClick={() => setShowRelease(true)}
          disabled={companyCreditHold}
          title={companyCreditHold ? CREDIT_HOLD_MESSAGE : undefined}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-700 text-white rounded-lg text-sm font-semibold hover:bg-emerald-600 transition-colors mb-4 disabled:bg-slate-300 disabled:text-slate-500 disabled:hover:bg-slate-300 disabled:cursor-not-allowed"
        >
          <FileCheck className="w-5 h-5" />
          {companyCreditHold ? 'Release blocked — credit hold' : 'Release Equipment for Pickup'}
        </button>
      )}

      {/* Force Close button — gated by shop_orders:force_close, non-closed WOs */}
      {can('shop_orders:force_close') && order.status !== 'closed' && !showRelease && !showForceClose && (
        <button
          type="button"
          onClick={() => setShowForceClose(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-700 text-white rounded-lg text-sm font-semibold hover:bg-red-600 transition-colors mb-4"
        >
          <ShieldAlert className="w-5 h-5" />
          Force Close (ready for billing)
        </button>
      )}

      {/* Permanent delete — gated by shop_orders:delete */}
      {can('shop_orders:delete') && !showRelease && !showForceClose && (
        <button
          type="button"
          onClick={() => setDeleteOpen(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-red-300 text-red-700 rounded-lg text-sm font-semibold hover:bg-red-50 transition-colors mb-4"
        >
          <Trash2 className="w-5 h-5" />
          Delete Work Order (permanent)
        </button>
      )}

      <ConfirmDestructiveDialog
        open={deleteOpen}
        mode="delete"
        title={`Delete ${order.workOrderNumber}`}
        message="Permanently removes this work order, its items, status history and transfers. Financial records (invoices/payments) are detached, not deleted."
        showOverride
        overrideLabel="Override: delete even if it has payments or a linked invoice (those are detached for manual cleanup)."
        busy={deleteBusy}
        onConfirm={async ({ reason, override }) => {
          setDeleteBusy(true)
          try {
            const res = await api.delete<{ warnings?: string[] }>(`/shop-orders/${id}`, { reason, override })
            try { await db.shopWorkOrders.delete(id as string) } catch { /* offline cache */ }
            if (res?.warnings?.length) alert(res.warnings.join('\n'))
            navigate('/shop')
          } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete work order')
            setDeleteBusy(false)
          }
        }}
        onClose={() => setDeleteOpen(false)}
      />

      {/* Force Close form */}
      {showForceClose && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-red-700" />
            <h3 className="text-base font-semibold text-red-900">Force Close Work Order</h3>
          </div>
          <p className="text-xs text-red-800">
            This will mark ALL items as returned and close the work order regardless of current status. This action is logged.
          </p>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Reason (required)</label>
            <textarea
              value={forceCloseReason}
              onChange={e => setForceCloseReason(e.target.value)}
              rows={2}
              placeholder="Why is this being force-closed?"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={submitForceClose}
              disabled={!chargePreview || forceClosing || !forceCloseReason.trim()}
              className="flex items-center gap-1.5 px-5 py-2.5 bg-red-700 text-white rounded-lg text-sm font-medium hover:bg-red-600 disabled:opacity-50"
            >
              {forceClosing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
              {forceClosing ? 'Closing...' : 'Confirm Force Close'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForceClose(false); setForceCloseReason('') }}
              className="px-5 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Already released info */}
      {order.status === 'closed' && order.returnedDate && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <FileCheck className="w-4 h-4 text-slate-500" />
            <h3 className="text-sm font-semibold text-slate-700">Equipment Released</h3>
          </div>
          <div className="text-xs text-slate-500 space-y-1">
            {order.pickupSignedByName && <p>Picked up by: <span className="font-medium text-slate-700">{order.pickupSignedByName}</span></p>}
            <p>Released: {formatCalendarDateNumeric(order.returnedDate)}</p>
            {order.pickupNotes && <p>Notes: {order.pickupNotes}</p>}
          </div>
          {order.pickupSignature && (
            <div className="mt-2 border border-slate-200 rounded bg-white overflow-hidden">
              <img src={order.pickupSignature} alt="Pickup signature" className="w-full h-16 object-contain" />
            </div>
          )}
        </div>
      )}

      {/* Generate Invoice Button — WO-direct billing. Once the WO is closed the
          whole order bills as one invoice (pricing / Tier 1 / tax applied). */}
      {order.status === 'closed' && !order.isInternal && !invoiceNumber && (
        <button
          type="button"
          onClick={generateInvoice}
          disabled={generatingInvoice}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-800 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors mb-4 disabled:opacity-50"
        >
          {generatingInvoice ? <Loader2 className="w-5 h-5 animate-spin" /> : <DollarSign className="w-5 h-5" />}
          {generatingInvoice ? 'Generating Invoice...' : 'Generate Invoice'}
        </button>
      )}

      {/* Invoice Generated Success */}
      {invoiceNumber && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-semibold text-blue-800">Invoice Generated</h3>
          </div>
          <p className="text-xs text-blue-700">
            <span className="font-medium">{invoiceNumber}</span> created as draft.
          </p>
          <button
            type="button"
            onClick={() => navigate('/billing')}
            className="mt-2 text-xs font-medium text-blue-700 hover:text-blue-900 underline"
          >
            Go to Billing →
          </button>
        </div>
      )}

      {/* Release Form */}
      {showRelease && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 mb-4 space-y-4">
          <div className="flex items-center gap-2">
            <FileCheck className="w-5 h-5 text-emerald-700" />
            <h3 className="text-base font-semibold text-emerald-900">Release Equipment</h3>
          </div>

          <p className="text-xs text-emerald-800">
            All completed items will be marked as returned. Customer acknowledges receipt of equipment.
          </p>

          {/* Tax Jurisdiction + CC Fee */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Tax Jurisdiction</label>
              <select
                value={releaseTaxJurisdiction}
                onChange={e => setReleaseTaxJurisdiction(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
              >
                {TAX_JURISDICTIONS.map(j => (
                  <option key={j.id} value={j.id}>{j.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Convenience Fee %</label>
              <input
                type="number"
                step="0.5"
                min="0"
                max="10"
                value={releaseCcFeePct}
                onChange={e => setReleaseCcFeePct(parseFloat(e.target.value) || 0)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>

          <ShopChargeBreakdown preview={chargePreview} error={chargePreviewError} />

          {/* Totals breakdown */}
          {chargePreview && (
            <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-1 text-sm">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span>
                <span>${releaseSubtotal.toFixed(2)}</span>
              </div>
              {releaseTaxRate > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>Tax ({(releaseTaxRate * 100).toFixed(releaseTaxRate * 100 % 1 === 0 ? 0 : 2)}% on ${releaseTaxableSubtotal.toFixed(2)})</span>
                  <span>${releaseTax.toFixed(2)}</span>
                </div>
              )}
              {releaseCredit > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <span>Paid at drop-off</span>
                  <span>&minus;${releaseCredit.toFixed(2)}</span>
                </div>
              )}
              {releasePayMethod === 'card' && releaseCcFee > 0 && (
                <div className="flex justify-between text-slate-600">
                  <span>Convenience fee ({releaseCcFeePct}%)</span>
                  <span>${releaseCcFee.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-slate-800 pt-1 border-t border-slate-200">
                <span>{releaseCredit > 0 ? 'Balance due' : 'Total'}</span>
                <span>${releaseTotal.toFixed(2)}</span>
              </div>
              {releaseCredit > 0 && releaseTotal <= 0 && (
                <p className="text-[11px] text-emerald-700 pt-1">
                  Settled at drop-off — nothing to collect at handoff.
                </p>
              )}
              {counterViaLightspeed && (
                /* Paid through the POS. ServicePRO has the reference and not
                   the amount, so it cannot net anything off — saying so beats
                   presenting a full total as if nothing had been collected. */
                <p className="text-[11px] text-amber-700 pt-1">
                  This order was rung through Lightspeed at drop-off. The amount lives in
                  Lightspeed, so nothing is deducted here — check what was already collected
                  before taking payment again.
                </p>
              )}
              {counterCollected > releaseGross && (
                /* Overpaid: the job came in under the deposit. Not netted to a
                   negative total, because this form cannot issue a refund and
                   showing one would promise something it will not do. */
                <p className="text-[11px] text-amber-700 pt-1">
                  ${(counterCollected - releaseGross).toFixed(2)} more was collected at drop-off than
                  this job came to. Refund it through Stripe or credit the account — ServicePRO
                  will not do it here.
                </p>
              )}
            </div>
          )}

          {/* Payment Method */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Payment</label>
            {companyCashCcOnly && (
              <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <CreditCard className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span><strong>Cash / Card only.</strong> Collect payment at pickup — this customer is not billed on account.</span>
              </div>
            )}
            <div className="flex gap-2">
              {([
                { key: 'account' as const, label: 'Bill to Account', icon: DollarSign },
                { key: 'card' as const, label: 'Card', icon: CreditCard },
                { key: 'cash' as const, label: 'Cash', icon: Banknote },
              ]).map(m => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => { setReleasePayMethod(m.key); setReleasePaymentDone(false) }}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium border-2 transition-colors',
                    releasePayMethod === m.key
                      ? 'border-emerald-500 bg-emerald-100 text-emerald-800'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300',
                  )}
                >
                  <m.icon className="w-4 h-4" />
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Card payment form */}
          {chargePreview && releasePayMethod === 'card' && stripePromise && !releasePaymentDone && (
            <div className="bg-white rounded-lg border border-slate-200 p-3">
              <Elements stripe={stripePromise}>
                <PaymentForm
                  amount={releaseTotal}
                  shopWorkOrderId={id}
                  companyId={order?.companyId}
                  description={`Shop WO ${order?.workOrderNumber || id}`}
                  ccFeeAmount={round2(releaseCcFee)}
                  onSuccess={() => setReleasePaymentDone(true)}
                />
              </Elements>
            </div>
          )}
          {releasePayMethod === 'card' && releasePaymentDone && (
            <p className="text-sm text-emerald-700 font-medium">Card payment successful</p>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Picked Up By (name)</label>
            <input
              type="text"
              value={pickupName}
              onChange={e => setPickupName(e.target.value)}
              placeholder="Customer representative name"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
            />
          </div>

          <SignaturePad
            value={pickupSignature}
            onChange={setPickupSignature}
            label="Customer Signature"
          />

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes (optional)</label>
            <textarea
              value={pickupNotes}
              onChange={e => setPickupNotes(e.target.value)}
              rows={2}
              placeholder="Any notes about the pickup..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={submitRelease}
              disabled={!chargePreview || releasing || !pickupName || (releasePayMethod === 'card' && !releasePaymentDone)}
              className="flex items-center gap-1.5 px-5 py-2.5 bg-emerald-700 text-white rounded-lg text-sm font-medium hover:bg-emerald-600 disabled:opacity-50"
            >
              {releasing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCheck className="w-4 h-4" />}
              {releasing ? 'Releasing...' : 'Confirm Release'}
            </button>
            <button
              type="button"
              onClick={() => setShowRelease(false)}
              className="px-5 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* QA inspection editor — drives the pre-pickup gate */}
      {qaEditorItem && (
        <EquipmentInspectionEditor
          shopItemId={qaEditorItem.id}
          shopPhase={pendingCompleteItemId === qaEditorItem.id || !['received', 'diagnosing'].includes(qaEditorItem.status) ? 'final' : 'initial'}
          serializedEquipmentId={qaEditorItem.serializedEquipmentId}
          serialNumber={qaEditorItem.serialNumber}
          category={inspectionCategoryFor(qaEditorItem.equipmentCategory)}
          equipmentDescription={inspectionDescriptionForItem(qaEditorItem)}
          seedData={seedDataForItem(qaEditorItem, childItems)}
          intakeConstituents={intakeConstituentsFor(qaEditorItem, childItems)}
          onConstituentCorrected={correctConstituentSerial}
          existing={
            (itemInspections[qaEditorItem.id] || []).find(i => !i.lockedAt) || null
          }
          onSaved={handleQaSaved}
          onClose={() => {
            setQaEditorItem(null)
            setPendingCompleteItemId(null)
          }}
        />
      )}
    </div>
  )
}

interface ContactReadoutProps {
  heading: string
  name: string
  phone: string | null
  email: string | null
  preferred: string | null
  highlightWhen?: boolean
}

function ContactReadout({ heading, name, phone, email, preferred, highlightWhen }: ContactReadoutProps) {
  return (
    <div className={cn('rounded-md p-3', highlightWhen ? 'bg-emerald-50 border border-emerald-200' : 'bg-slate-50 border border-slate-100')}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{heading}</p>
      <p className="font-medium text-slate-900">{name}</p>
      <div className="mt-1 space-y-0.5 text-xs">
        {phone && (
          <a href={`tel:${phone}`} className="block text-blue-700 hover:underline">{phone}</a>
        )}
        {email && (
          <a href={`mailto:${email}`} className="block text-blue-700 hover:underline truncate">{email}</a>
        )}
      </div>
      {preferred && (
        <p className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">Prefers {preferred}</p>
      )}
    </div>
  )
}

// Quick bin-location picker for personal monitors. Presets (Bin 1–22) save on
// select; "Other…" reveals a free-text box that commits on the Save button.
function BinLocationControl({ value, saving, onSave, occupiedBins, currentItemId }: {
  value: string | null
  saving: boolean
  onSave: (v: string) => void
  occupiedBins?: Map<string, { workOrderNumber: string; itemId: string }>
  currentItemId?: string
}) {
  const isPreset = !!value && BIN_LABELS.includes(value)
  const [sel, setSel] = useState(value ? (isPreset ? value : 'other') : '')
  const [other, setOther] = useState(isPreset ? '' : value || '')

  // Re-sync when the stored value changes (after a save or a fresh reload).
  useEffect(() => {
    const preset = !!value && BIN_LABELS.includes(value)
    setSel(value ? (preset ? value : 'other') : '')
    setOther(preset ? '' : value || '')
  }, [value])

  function handleSelect(v: string) {
    setSel(v)
    if (v !== 'other') onSave(v) // presets — and the blank "Not set" — save immediately
  }

  const otherDirty = sel === 'other' && !!other.trim() && other.trim() !== value

  return (
    <div className="rounded-lg border border-teal-200 bg-teal-50 p-3">
      <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-teal-800 mb-1.5">
        <Package className="w-3.5 h-3.5" /> Bin Location
      </label>
      <div className="flex items-center gap-2">
        <select
          value={sel}
          disabled={saving}
          onChange={e => handleSelect(e.target.value)}
          className="flex-1 px-2 py-1.5 border border-teal-300 rounded text-sm bg-white"
        >
          <option value="">Not set</option>
          {BIN_LABELS.map(b => {
            const hit = occupiedBins?.get(b)
            const takenByOther = !!hit && hit.itemId !== currentItemId
            return (
              <option key={b} value={b} disabled={takenByOther}>
                {takenByOther ? `${b} — in use (${hit!.workOrderNumber})` : b}
              </option>
            )
          })}
          <option value="other">Other…</option>
        </select>
        {saving && <Loader2 className="w-4 h-4 text-teal-500 animate-spin" />}
      </div>
      {sel === 'other' && (
        <div className="mt-1.5 flex items-center gap-2">
          <input
            type="text"
            value={other}
            disabled={saving}
            onChange={e => setOther(e.target.value)}
            placeholder="OK, where did you put it?"
            className="flex-1 px-2 py-1.5 border border-teal-300 rounded text-sm bg-white"
          />
          <button
            type="button"
            disabled={saving || !otherDirty}
            onClick={() => onSave(other)}
            className="flex items-center gap-1 px-3 py-1.5 rounded text-sm font-medium bg-teal-600 text-white disabled:opacity-40"
          >
            <Save className="w-3.5 h-3.5" /> Save
          </button>
        </div>
      )}
    </div>
  )
}
