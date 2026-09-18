import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams, useParams } from 'react-router-dom'
import { v4 as uuidv4 } from 'uuid'
import { useAuth } from '@/contexts/AuthContext'
import { cn } from '@/lib/cn'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { useDraftPersistence } from '@/hooks/useDraftPersistence'
import { getDefaultLineItems } from '@/lib/defaultLineItems'
import { CustomerSearch } from '@/components/CustomerSearch'
import { LocationPicker, type LocationSelection } from '@/components/LocationPicker'
import { MobileAssetPicker, type MobileAssetOption } from '@/components/MobileAssetPicker'
import { TrainingLocationPicker, type TrainingLocationOption } from '@/components/TrainingLocationPicker'
import { LineItemEditor, type LineItem } from '@/components/LineItemEditor'
import { PhotoCapture, type CapturedPhoto } from '@/components/PhotoCapture'
import { SignaturePad } from '@/components/SignaturePad'
import { FitTestEditor, occRecordComplete } from '@/components/FitTestEditor'
import { DeployInspectionModal } from '@/components/DeployInspectionModal'
import { resolveDeployCategory, type DeployCategory } from '@/lib/deployChecklist'
import { AirSystemInspectionEditor } from '@/components/AirSystemInspectionEditor'
import { FieldInspectionCapture } from '@/components/FieldInspectionCapture'
import { getActiveSiteId, cacheActiveSites, getCachedActiveSites } from '@/lib/site'
import { IhTestingEditor, IH_SUBTYPES } from '@/components/IhTestingEditor'
import { TrainingClassEditor, COURSE_TYPES } from '@/components/TrainingClassEditor'
import { EquipmentScanner, type ScannedEquipment } from '@/components/EquipmentScanner'
import { BillingRefsField } from '@/components/BillingRefsField'
import { LiveClock } from '@/components/LiveClock'
import { DivisionSelector, type Division } from '@/components/DivisionSelector'
import { isQbDivision, WORK_TYPE_QB_DIVISION } from '@/lib/qbDivision'
import { WORK_TYPE_DIVISION } from '@/lib/divisions'
import { GasDetectionEditor, isGasDetectionRecordComplete } from '@/components/GasDetectionEditor'
import type { WizardDraftData, FitTestDraftRecord, AirSystemDraftRecord, IhTestDraftRecord, IhTestType, GasDetectionDraftRecord, TrainingRosterDraftRecord, OfflineRentalAgreementItem, OfflineWell, RentalPic, RentalComposition, RentalBomExtraSpec, BillingRef, BillingProfileSeed, OfflineEquipmentInspection, OfflineShopWorkOrder } from '@/lib/db-types'
import { diffDeployedAgainstBaseline, netAlreadyLined, productRateFor, type RentalBomProduct } from '@/lib/rentalBom'
import { rateUnitAbbrev } from '@/lib/rentalRates'
import { selectBillingProfileSeed } from '@/lib/billingProfile'
import { CREDIT_HOLD_MESSAGE } from '@/lib/creditHold'
import { useCompanyPriceLevels, type PriceLevel } from '@/lib/priceLevels'
import { ContractPricingBanner } from '@/components/ContractPriceBadge'
import { todayKey, calendarDateKey, formatCalendarDateNumeric } from '@/lib/dates'
import { getSiteShiftWindow, restoreSiteTimesManual } from '@/lib/siteTimes'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Save,
  ClipboardList,
  ClipboardCheck,
  Clock,
  Wrench,
  ShieldCheck,
  GraduationCap,
  Settings,
  Package,
  FlaskConical,
  X,
  DollarSign,
  Wind,
  ShoppingCart,
  Caravan,
  QrCode,
  RefreshCw,
  CreditCard,
  AlertTriangle,
} from 'lucide-react'

// ============================================================
// Timestamp helpers — for the Site Times fields on wrap_up
// ============================================================

function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localInputToIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function TimestampField({ label, value, onChange }: { label: string; value: string | null; onChange: (iso: string | null) => void }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          type="datetime-local"
          value={isoToLocalInput(value)}
          onChange={e => onChange(localInputToIso(e.target.value))}
          className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
        />
        <button
          type="button"
          onClick={() => onChange(new Date().toISOString())}
          className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          Now
        </button>
      </div>
    </div>
  )
}

// Arrival/departure capture card. Rendered on every wrap-up step because
// submitTicket() gates on both timestamps regardless of work type.
function SiteTimesCard({ arrivedAt, departedAt, onArrivedChange, onDepartedChange, onUseLogTimes }: {
  arrivedAt: string | null
  departedAt: string | null
  onArrivedChange: (iso: string | null) => void
  onDepartedChange: (iso: string | null) => void
  onUseLogTimes?: () => void
}) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <h3 className="font-medium text-slate-900 mb-3 flex items-center gap-2">
        <Clock className="w-4 h-4" />
        Site Times <span className="text-red-500">*</span>
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TimestampField
          label="Arrival"
          value={arrivedAt}
          onChange={onArrivedChange}
        />
        <TimestampField
          label="Departure"
          value={departedAt}
          onChange={onDepartedChange}
        />
      </div>
      <p className="text-xs text-slate-500 mt-3">Both required before submit. Tap <span className="font-semibold">Now</span> to stamp the current time, or edit directly.</p>
      {onUseLogTimes && (
        <button type="button" onClick={onUseLogTimes} className="mt-2 text-sm font-medium text-blue-700 hover:text-blue-800">
          Use first and last log entries
        </button>
      )}
    </div>
  )
}

// ============================================================
// Work Type Configuration
// ============================================================

type WorkType = 'field_service' | 'field_inspection' | 'd3_combined' | 'fit_test' | 'ih_testing' | 'training' | 'repair' | 'rental' | 'air_fill' | 'direct_sale'

/**
 * Per-customer warnings that ride along with the customer picker on every work
 * type. Credit hold comes first and loud — it's a hard block, not an advisory,
 * so it can't read as just another yellow note.
 *
 * Contract pricing sits here too: picking the customer is the moment their
 * pricebook gets checked, so it's also the moment to say which one applies.
 */
function CustomerFlagBanners({ creditHold, cashCcOnly, priceLevel }: {
  creditHold: boolean
  cashCcOnly: boolean
  priceLevel?: PriceLevel | null
}) {
  return (
    <>
      {creditHold && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border-2 border-red-600 bg-red-600 px-3 py-2.5 text-sm font-semibold text-white">
          <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
          <span>{CREDIT_HOLD_MESSAGE}</span>
        </div>
      )}
      {cashCcOnly && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <CreditCard className="w-4 h-4 mt-0.5 shrink-0" />
          <span><strong>Cash / Card only.</strong> Collect payment at time of service — this customer is not billed on account.</span>
        </div>
      )}
      <ContractPricingBanner level={priceLevel ?? null} className="mt-2" />
    </>
  )
}

interface WorkTypeConfig {
  key: WorkType
  label: string
  description: string
  icon: LucideIcon
  ticketType: string
  serviceSubtype: string | null
  steps: string[]
  comingSoon: boolean
  redirectTo?: string
}

const WORK_TYPES: WorkTypeConfig[] = [
  {
    key: 'field_service',
    label: 'Field Service',
    description: 'Monitor, air system, bump test, calibration',
    icon: Wrench,
    ticketType: 'field_service',
    serviceSubtype: null, // chosen in step 1
    steps: ['who_where', 'line_items', 'wrap_up'],
    comingSoon: false,
  },
  {
    // Field equipment inspection promoted to its own work type (was nested
    // under Field Service > Inspection). Stays ticketType 'field_service' so
    // field-ticket billing/PDF logic still applies; serviceSubtype 'inspection'
    // gives it an "SP-" ticket number and the inspection-only flow. PASS units
    // bill visual-only + write a BlueLion record; FAIL units spawn a Shop WO
    // that auto-transits to Williston with the inspecting tech as transporter.
    key: 'field_inspection',
    label: 'Field Inspection',
    description: 'Field equipment inspection for transfer to shop as needed',
    icon: ClipboardCheck,
    ticketType: 'field_service',
    serviceSubtype: 'inspection',
    steps: ['who_where', 'line_items', 'wrap_up'],
    comingSoon: false,
  },
  {
    key: 'd3_combined',
    label: 'D3 Combined Visit',
    description: 'Air systems, IH, and gas detection in one field visit',
    icon: ClipboardList,
    ticketType: 'field_service',
    serviceSubtype: 'general',
    steps: ['d3_services', 'who_where', 'line_items', 'wrap_up'],
    comingSoon: false,
  },
  {
    key: 'air_fill',
    label: 'In-Shop Air Fill',
    description: 'Truck fills and cascades IN SHOP ONLY',
    icon: Wind,
    ticketType: 'field_service',
    serviceSubtype: 'air_fill',
    steps: ['af_customer', 'af_confirm', 'af_line_items', 'af_wrap_up'],
    comingSoon: false,
  },
  {
    // #10 Occ Health — replaces the Fit Test tile. Internal keys stay
    // 'fit_test' (ticketType training + serviceSubtype fit_test) so billing,
    // PDFs, and historical tickets keep working; the visit's services live in
    // customData.occServices + per-record flags.
    key: 'fit_test',
    label: 'Occ Health',
    description: 'Fit testing & audiometric for personnel',
    icon: ShieldCheck,
    ticketType: 'training',
    serviceSubtype: 'fit_test',
    steps: ['ft_setup', 'ft_records', 'ft_line_items', 'ft_wrap_up'],
    comingSoon: false,
  },
  {
    key: 'ih_testing',
    label: 'IH Testing',
    description: 'H₂S, O₂/VOC, Sampling',
    icon: FlaskConical,
    ticketType: 'inspection',
    serviceSubtype: null, // Set dynamically in ih_setup based on subtype selection
    steps: ['ih_setup', 'ih_records', 'ih_line_items', 'ih_wrap_up'],
    comingSoon: false,
  },
  {
    key: 'training',
    label: 'Training',
    description: 'Safety classes, certifications & card tracking',
    icon: GraduationCap,
    ticketType: 'training',
    serviceSubtype: 'safety_training',
    steps: ['tr_setup', 'tr_roster', 'tr_line_items', 'tr_wrap_up'],
    comingSoon: false,
  },
  {
    key: 'repair',
    label: 'Shop Service',
    description: 'In-shop repair and service orders',
    icon: Settings,
    ticketType: 'repair',
    serviceSubtype: null,
    steps: [],
    comingSoon: false,
    redirectTo: '/shop/intake',
  },
  {
    key: 'rental',
    label: 'Deploy',
    description: 'Hitch up a dispatched rental — add gear and head out',
    icon: Caravan,
    ticketType: 'rental',
    serviceSubtype: null,
    // Phase C: liability step is gone. rn_setup now requires picking a
    // dispatched rental contract first; the dispatcher already captured
    // customer + location + contact info on the contract itself.
    steps: ['rn_setup', 'rn_equipment', 'rn_review'],
    comingSoon: false,
  },
  {
    key: 'direct_sale',
    label: 'Direct Sale',
    description: 'Walk-in counter sales, CC / cash / check',
    icon: ShoppingCart,
    ticketType: 'sale',
    serviceSubtype: null,
    steps: [],
    comingSoon: false,
    redirectTo: '/pos',
  },
]

// Field service subtypes (fit_test removed — it's its own work type now)
const SERVICE_TYPES = [
  { value: 'gas_detection', label: 'Gas Detection' },
  { value: 'cascade_air', label: 'Cascade Air Service' },
  { value: 'on_site_services', label: 'On-Site Services' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'general', label: 'General Field Svc' },
]

// On-Site Services sub-selection. Module-level so the division-first hand-off
// (?subtype=) can validate against the same list the picker renders.
export type OnSiteSubtype = 'confined_space' | 'manned_trailer' | 'bottle_watch' | 'other'
const ON_SITE_SUBTYPES: { value: OnSiteSubtype; label: string }[] = [
  { value: 'confined_space', label: 'Confined Space' },
  { value: 'manned_trailer', label: 'Manned Trailer' },
  { value: 'bottle_watch', label: 'Bottle Watch' },
  { value: 'other', label: 'Other' },
]

// Field-inspection category (EquipmentInspectionCategory) → shop intake category
// (EquipmentCategoryShop) for the Shop WO spawned from failed field units.
const INSP_TO_SHOP_CATEGORY: Record<string, string> = {
  fire_extinguisher: 'fire_extinguisher',
  gas_detection: 'personal_monitor',
  scba: 'scba',
  fall_arrest: 'fall_arrest',
  ue_cylinder: 'ue_cylinder',
  breathing_air_system: 'other',
  first_aid_kit: 'other',
  other: 'other',
}

// Map legacy serviceSubtype values from older tickets onto the new top-level
// types so the wizard can edit them without showing an empty selection.
// Keep this in sync with SERVICE_TYPES until legacy values are fully retired.
const LEGACY_SERVICE_TYPE_MAP: Record<string, string> = {
  monitor: 'gas_detection',
  bump_test: 'gas_detection',
  calibration: 'gas_detection',
  air_system: 'cascade_air',
  air_fill: 'cascade_air',
}

/**
 * Labor-rate lines — legacy part 406 or the new per-division scheme [DIV]00002.
 * These must carry a description of the work done: the wizard gates submit on
 * it and the server gates supervisor approval on it (routes/tickets.ts).
 */
/** Prefix marking a labor note this wizard derived (vs. one a tech typed). */
const DERIVED_NOTE_PREFIX = 'Air system inspection — '

function isLaborRatePart(partNumber?: string | null): boolean {
  return partNumber === '406' || /^0[0-9]00002$/.test(partNumber ?? '')
}

function normalizeServiceType(value: string | null | undefined): string {
  if (!value) return ''
  return LEGACY_SERVICE_TYPE_MAP[value] ?? value
}

// Reverse-map (ticketType, serviceSubtype) → wizard WorkType for the
// "Use as Template" flow. Returns null for ticket shapes the wizard can't
// handle (rentals run through dispatch, sales through POS, shop through
// intake) so the seed effect leaves the wizard alone.
function deriveWorkTypeFromTicket(ticketType: string, serviceSubtype: string | null): WorkType | null {
  if (ticketType === 'training' && serviceSubtype === 'fit_test') return 'fit_test'
  if (ticketType === 'training') return 'training'
  if (ticketType === 'inspection') return 'ih_testing'
  if (ticketType === 'field_service' && serviceSubtype === 'air_fill') return 'air_fill'
  if (ticketType === 'field_service' && serviceSubtype === 'inspection') return 'field_inspection'
  if (ticketType === 'field_service') return 'field_service'
  return null
}

interface Company {
  id: string
  name: string
  companyType: string
  city: string | null
  state: string | null
  cashCcOnly?: boolean
  creditHold?: boolean
}

// ============================================================
// Wizard Component
// ============================================================

/**
 * Pricing provenance persisted with a billing line (TicketLineItem.customData).
 *
 * Stamped at add time so the ticket can answer "why is this $175?" months
 * later, on a screen that has no access to the pricebook. Null for a
 * list-priced line — an empty object would be a lie about having checked.
 */
function priceLevelCustomData(item: LineItem) {
  if (!item.priceLevelName || item.contractRate == null) return null
  return {
    priceLevel: {
      name: item.priceLevelName,
      listRate: item.listRate ?? null,
      contractRate: item.contractRate,
    },
  }
}

export function TicketWizard() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { id: editTicketId } = useParams<{ id: string }>()
  const { user } = useAuth()
  const [step, setStep] = useState(0) // 0 = type selector, 1+ = flow steps
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // ---- Edit mode detection ----
  const isEditMode = !!editTicketId

  // Work type selection
  const [workType, setWorkType] = useState<WorkType | null>(null)

  // Derived: active config + step helpers
  const activeConfig = useMemo(
    () => WORK_TYPES.find(wt => wt.key === workType) ?? null,
    [workType],
  )
  const totalSteps = activeConfig?.steps.length ?? 0
  const currentStepId = activeConfig && step >= 1 ? activeConfig.steps[step - 1] ?? null : null
  const isLastStep = step > 0 && step === totalSteps

  // Generate or restore draft ID from URL (edit mode uses ticket ID as key)
  const draftId = useMemo(() => {
    if (isEditMode) return `edit-${editTicketId}`
    return searchParams.get('draft') || uuidv4()
  }, [isEditMode, editTicketId, searchParams])

  // Set draft ID in URL if not present (skip for edit mode — identified by route).
  // Preserve other params (?type=, ?template=) so they're still readable by
  // downstream effects that run after this one.
  useEffect(() => {
    if (!isEditMode && !searchParams.get('draft')) {
      const next = new URLSearchParams(searchParams)
      next.set('draft', draftId)
      setSearchParams(next, { replace: true })
    }
  }, [isEditMode, draftId, searchParams, setSearchParams])

  // Offline ID for the ticket itself (for server-side dedup)
  const [offlineId] = useState(() => uuidv4())

  // Draft persistence
  const { draft, saveDraft: persistDraft, clearDraft, isLoaded } = useDraftPersistence(draftId)

  // ---- Edit mode: track originals for diffing ----
  const [originalLineItemIds, setOriginalLineItemIds] = useState<Set<string>>(new Set())
  const [originalFitTestIds, setOriginalFitTestIds] = useState<Set<string>>(new Set())
  const [originalAirSystemIds, setOriginalAirSystemIds] = useState<Set<string>>(new Set())
  const [originalIhTestIds, setOriginalIhTestIds] = useState<Set<string>>(new Set())
  const [originalTrainingRosterIds, setOriginalTrainingRosterIds] = useState<Set<string>>(new Set())
  const [originalStatus, setOriginalStatus] = useState('draft')
  const [editDataLoaded, setEditDataLoaded] = useState(false)

  // ---- Shared state ----
  const [customer, setCustomer] = useState<Company | null>(null)
  // Cash/Card-only flag, resolved from the offline company record (robust to
  // however `customer` was set — picker, draft restore, or clone).
  const [customerCashCcOnly, setCustomerCashCcOnly] = useState(false)
  // AR credit hold on the selected customer — blocks the submit outright.
  const [customerCreditHold, setCustomerCreditHold] = useState(false)
  // The customer's QuickBooks contract pricebook, if they're on one. Every
  // billing line the wizard fills in is priced through it, at the moment it's
  // added — not left for the invoice to silently correct days later.
  const { levels: priceLevels, level: priceLevel } = useCompanyPriceLevels(customer?.id ?? null)
  const [location, setLocation] = useState<LocationSelection>({ field: null, pad: null, wells: [] })
  // Field service: was a rig present on-site? Independent of the main
  // location — noted context for the visit, not the location itself.
  const [rigPresent, setRigPresent] = useState(false)
  const [presentRig, setPresentRig] = useState<MobileAssetOption | null>(null)
  const [selectedServiceType, setServiceType] = useState('')
  // This flow has no service picker. Derive its fixed service for fresh URLs,
  // restored drafts, and edits, including drafts saved with a blank service.
  const serviceType = workType === 'field_inspection' ? 'inspection' : selectedServiceType
  const [poNumber, setPoNumber] = useState('')
  // #3 structured billing refs (PO/AFE/Cost-Code repeater). poNumber above is
  // kept synced to the first PO row for display + back-compat.
  const [billingRefs, setBillingRefs] = useState<BillingRef[]>([])
  const [billingRefsSeeded, setBillingRefsSeeded] = useState(false)
  const [billingLabels, setBillingLabels] = useState<{ po?: string | null; afe?: string | null; costCode?: string | null }>({})
  const [billingProfilesSeed, setBillingProfilesSeed] = useState<BillingProfileSeed[]>([])
  // Internal QB Class — drives division on SalesOrder header, never on customer PDF
  const [division, setDivision] = useState<Division>(null)
  const [isDickinson, setIsDickinson] = useState(false)
  // Catalog division for the line-item picker: follow the ticket's division
  // (the job's nature) when set, else default by work type. Scopes the parts
  // catalog only — revenue class stays with `division` above.
  const pickerDivision = useMemo<number | null>(() => {
    if (division) return parseInt(division.slice(1), 10)
    return workType ? WORK_TYPE_DIVISION[workType] ?? null : null
  }, [division, workType])
  const [linkedRentalId, setLinkedRentalId] = useState<string | null>(null)
  type RentalJobOption = {
    id: string
    agreementNumber: string | null
    status: string
    startDate: string
    billingRateType: string
    companyId: string
    companyName?: string | null
    fieldId?: string | null
    fieldName?: string | null
    padId?: string | null
    padName?: string | null
    wellId?: string | null
    wellIds?: string[]
    wellNames?: string[]
    poNumber?: string | null
    afeNumber?: string | null
    locationDisplay?: string | null
    siteContactName?: string | null
    personCallingName?: string | null
    composition?: RentalComposition | null
  }
  type RentalJobRow = Omit<Partial<RentalJobOption>, 'wellIds'> & {
    id: string
    status: string
    startDate: string
    billingRateType: string
    companyId: string
    wellIds?: unknown
    company?: { name?: string | null } | null
    field?: { name?: string | null } | null
    pad?: { name?: string | null } | null
    well?: { wellName?: string | null } | null
  }
  const [activeRentals, setActiveRentals] = useState<RentalJobOption[]>([])
  const [arrivedAt, setArrivedAt] = useState<string | null>(null)
  const [serviceDate, setServiceDate] = useState(todayKey())
  const [dispatchNotes, setDispatchNotes] = useState('')
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [departedAt, setDepartedAt] = useState<string | null>(null)
  const [workNotes, setWorkNotes] = useState('')
  const [photos, setPhotos] = useState<CapturedPhoto[]>([])
  const [siteSignPhotos, setSiteSignPhotos] = useState<CapturedPhoto[]>([])
  const [signature, setSignature] = useState<string | null>(null)

  const cleanLinkedServiceProWell = !!customer?.id && location.wells.length > 0 && location.wells.every(w =>
    !!w.apiNumber?.trim() &&
    w.currentOperatorId === customer.id &&
    !w.pendingReview
  )

  const selectedLocationOwner = useMemo(() => {
    const mismatchedWell = location.wells.find(w => w.currentOperatorId && (!customer?.id || w.currentOperatorId !== customer.id))
    const ownedWell = mismatchedWell || location.wells.find(w => w.currentOperatorId)
    if (ownedWell?.currentOperatorId) {
      return {
        id: ownedWell.currentOperatorId,
        name: ownedWell.currentOperatorName || null,
        source: 'well' as const,
        locationId: ownedWell.id,
      }
    }
    if (location.pad?.currentOperatorId) {
      return {
        id: location.pad.currentOperatorId,
        name: location.pad.currentOperatorName || null,
        source: 'pad' as const,
        locationId: location.pad.id,
      }
    }
    return null
  }, [customer?.id, location.pad, location.wells])

  const fieldTicketWithSite = (workType === 'field_service' || workType === 'field_inspection' || workType === 'ih_testing' || workType === 'd3_combined') &&
    (!!location.pad || location.wells.length > 0)
  const siteSignGeotagged = siteSignPhotos.some(p => p.latitude != null && p.longitude != null)
  const customerLocationMismatch = !cleanLinkedServiceProWell && !!customer?.id && !!selectedLocationOwner?.id && selectedLocationOwner.id !== customer.id
  const locationHasPendingReview = !!location.pad?.pendingReview || location.wells.some(w => !!w.pendingReview)
  const locationLinkedToCustomer = !!customer?.id && (
    cleanLinkedServiceProWell ||
    (location.wells.length === 0 && !!location.pad?.currentOperatorId && location.pad.currentOperatorId === customer.id)
  )
  const requiresSiteSignEvidence = fieldTicketWithSite && !cleanLinkedServiceProWell && (locationHasPendingReview || !locationLinkedToCustomer || customerLocationMismatch)
  const showsSiteSignEvidence = fieldTicketWithSite

  // ---- Fit test state ----
  const [fitTestRecords, setFitTestRecords] = useState<FitTestDraftRecord[]>([])
  // #10 Occ Health: which services this visit covers + in-house/on-site + mileage
  const [occServices, setOccServices] = useState<Set<'fit_test' | 'audiometric'>>(new Set(['fit_test']))
  const [occOnSite, setOccOnSite] = useState(false)
  const [occMileage, setOccMileage] = useState('')
  // #11 daily calibration results — one set per roster, not per person
  const [occDailyCalFiles, setOccDailyCalFiles] = useState<{ id: string; fileName: string; mimeType: string; dataUrl: string }[]>([])
  const occServicesArr = (['fit_test', 'audiometric'] as const).filter(s => occServices.has(s))

  // ---- Air system inspection state ----
  const [airSystemRecords, setAirSystemRecords] = useState<AirSystemDraftRecord[]>([])

  // ---- Gas detection state (Phase B) ----
  // Note: edit-load of existing records (originalGasDetectionIds tracking +
  // diff on save) is deferred to a B2 follow-up — new tickets only for now.
  const [gasDetectionRecords, setGasDetectionRecords] = useState<GasDetectionDraftRecord[]>([])
  const [gasDetectionFixed, setGasDetectionFixed] = useState(false)
  const [gasDetectionArea, setGasDetectionArea] = useState(false)
  type D3CombinedService = 'air' | 'ih' | 'gas'
  const [d3CombinedServices, setD3CombinedServices] = useState<Set<D3CombinedService>>(new Set())
  const d3CombinedServicesArr = (['air', 'ih', 'gas'] as const).filter(s => d3CombinedServices.has(s))
  const d3HasAir = workType === 'd3_combined' && d3CombinedServices.has('air')
  const d3HasIh = workType === 'd3_combined' && d3CombinedServices.has('ih')
  const d3HasGas = workType === 'd3_combined' && d3CombinedServices.has('gas')

  // ---- Field Inspection (ShopWork Wave 4) ----
  // serviceType 'inspection': one captured EquipmentInspection per unit (held in
  // wizard state via the capture-only editor). At submit, PASS units persist as
  // locked inspections (ledger + visual-only field bill); FAIL units spawn a Shop WO.
  const [inspectionRecords, setInspectionRecords] = useState<OfflineEquipmentInspection[]>([])
  // Which shop failed units transit to. Defaults to Williston ('WIL') — ~98% go
  // there — but selectable so the rare return-elsewhere unit isn't "lost" at the
  // wrong site. Sites loaded lazily when the field-inspection flow is active.
  // Which shop failed units go back to, as a Site short code. Starts EMPTY and
  // is resolved against the real site list below — it used to be seeded with a
  // literal 'WIL', which meant that if Williston were ever renamed or
  // deactivated every field-inspection spawn would name a destination the
  // server couldn't resolve and would silently stop transiting.
  const [returnShopShortCode, setReturnShopShortCode] = useState('')
  const [shopSites, setShopSites] = useState<{ id: string; name: string; shortCode: string }[]>(
    () => getCachedActiveSites(),
  )

  // ---- On-Site Services subtype (Phase B) ----
  // Each subtype except 'other' captures a shift-style site log as an array of
  // entries (matches RentalDailyLog.entries shape exactly). Manned Trailer
  // tickets cross-write the entries into the linked rental's daily log on sync.
  type OnSiteEntry = {
    id: string
    time: string                 // HH:MM
    date?: string                // YYYY-MM-DD; legacy entries use the service date
    type: 'note' | 'h2s'
    text: string
    ppm?: number | null
    location?: string
    airDeployed?: boolean
    createdAt: string
  }
  const [onSiteSubtype, setOnSiteSubtype] = useState<OnSiteSubtype | null>(null)
  // True when the service type arrived on the URL from the division-first
  // shell. Collapses the two pickers into a one-line summary with a Change
  // escape hatch, so a mis-tap upstream is still fixable.
  const [serviceFromPath, setServiceFromPath] = useState(false)
  const [showServicePickers, setShowServicePickers] = useState(false)
  const [onSiteEntries, setOnSiteEntries] = useState<OnSiteEntry[]>([])
  // The shift window isn't a question — it's what the log already says. Every
  // entry carries the one timestamp the tech actually knows ("this happened
  // at"), and the day is bounded by the earliest and latest of them. Asking
  // for shift start/end on top of that was the same answer, typed twice.
  const onSiteShiftWindow = useMemo(() => getSiteShiftWindow(onSiteEntries, serviceDate), [onSiteEntries, serviceDate])
  // Site Times on the closing step track the log window until a human edits
  // them — the drive out often starts before the first reading and the drive
  // home after the last, so this is a starting point, not an answer.
  const [siteTimesManual, setSiteTimesManual] = useState({ arrived: false, departed: false })
  const setArrivedAtManual = useCallback((iso: string | null) => {
    setSiteTimesManual(prev => ({ ...prev, arrived: true }))
    setArrivedAt(iso)
  }, [])
  const setDepartedAtManual = useCallback((iso: string | null) => {
    setSiteTimesManual(prev => ({ ...prev, departed: true }))
    setDepartedAt(iso)
  }, [])
  const useLogSiteTimes = useCallback(() => {
    if (!onSiteShiftWindow) return
    setSiteTimesManual({ arrived: false, departed: false })
    setArrivedAt(new Date(onSiteShiftWindow.start).toISOString())
    setDepartedAt(new Date(onSiteShiftWindow.end).toISOString())
  }, [onSiteShiftWindow])
  useEffect(() => {
    if (serviceType !== 'on_site_services') return
    if (!onSiteSubtype || onSiteSubtype === 'other') return
    if (!onSiteShiftWindow) return
    const first = new Date(onSiteShiftWindow.start)
    const last = new Date(onSiteShiftWindow.end)
    if (isNaN(first.getTime()) || isNaN(last.getTime())) return
    if (!siteTimesManual.arrived) setArrivedAt(first.toISOString())
    if (!siteTimesManual.departed) setDepartedAt(last.toISOString())
  }, [serviceType, onSiteSubtype, onSiteShiftWindow, siteTimesManual])
  const [onSiteOtherDescription, setOnSiteOtherDescription] = useState('')
  // Add-entry draft state
  const [entryDraftType, setEntryDraftType] = useState<'note' | 'h2s'>('note')
  const [entryDraftTime, setEntryDraftTime] = useState('')
  const [entryDraftDate, setEntryDraftDate] = useState('')
  const [entryDraftText, setEntryDraftText] = useState('')
  // #B H2S readings can be entered as multiple PPM+Location rows at once; one
  // "Add" fans them into individual entries (each still a single reading).
  const [h2sRows, setH2sRows] = useState<{ id: string; ppm: string; location: string; note: string }[]>(
    [{ id: uuidv4(), ppm: '', location: '', note: '' }],
  )

  // ---- Cascade Air subtypes (Phase B) ----
  // Multi-select: a tech can do an inspection + fill + replace a hose all in
  // one ticket. New Install is exclusive — picking it clears the others, and
  // picking another clears New Install. The subtype panels stack on the
  // line_items step in the order they were selected.
  type CascadeAirSubtype = 'inspection' | 'new_install' | 'air_fill' | 'other_repair'
  const CASCADE_AIR_SUBTYPE_VALUES: CascadeAirSubtype[] = ['inspection', 'new_install', 'air_fill', 'other_repair']
  const [cascadeAirSubtypes, setCascadeAirSubtypes] = useState<Set<CascadeAirSubtype>>(new Set())
  const toggleCascadeAirSubtype = useCallback((s: CascadeAirSubtype) => {
    setCascadeAirSubtypes(prev => {
      const next = new Set(prev)
      if (next.has(s)) {
        next.delete(s)
        return next
      }
      if (s === 'new_install') return new Set<CascadeAirSubtype>(['new_install'])
      next.delete('new_install')
      next.add(s)
      return next
    })
  }, [])
  // On-site fill (cascade > air_fill)
  const [cascadeAirCylinderSerial, setCascadeAirCylinderSerial] = useState('')
  // Other Repair / generic-cascade-other description
  const [cascadeAirOtherDescription, setCascadeAirOtherDescription] = useState('')
  type InstallCylinder = { serialNumber: string; hydroDate: string; expiryDate: string }
  type NewInstallSystem = {
    id: string
    workPointName: string
    airSystemType: string
    reelSerialNumber: string
    standSerialNumber: string
    regulatorSerial: string
    cylinders: InstallCylinder[]
    installDescription: string
  }
  const blankCylinder = (): InstallCylinder => ({ serialNumber: '', hydroDate: '', expiryDate: '' })
  const blankNewInstallSystem = (): NewInstallSystem => ({
    id: uuidv4(),
    workPointName: '',
    airSystemType: 'tank_battery',
    reelSerialNumber: '',
    standSerialNumber: '',
    regulatorSerial: '',
    // Default to two bottles (typical cascade pair) — tech can add more or remove
    cylinders: [blankCylinder(), blankCylinder()],
    installDescription: '',
  })
  // New Install — each entry mints one WorkPoint at the ticket location on sync.
  const [newInstallSystems, setNewInstallSystems] = useState<NewInstallSystem[]>(() => [blankNewInstallSystem()])
  const updateNewInstallSystem = useCallback((id: string, patch: Partial<NewInstallSystem>) => {
    setNewInstallSystems(prev => prev.map(system => system.id === id ? { ...system, ...patch } : system))
  }, [])
  const updateNewInstallCylinder = useCallback((systemId: string, idx: number, patch: Partial<InstallCylinder>) => {
    setNewInstallSystems(prev => prev.map(system => {
      if (system.id !== systemId) return system
      const cylinders = [...system.cylinders]
      cylinders[idx] = { ...cylinders[idx], ...patch }
      return { ...system, cylinders }
    }))
  }, [])

  // ---- IH testing state ----
  const [ihTestRecords, setIhTestRecords] = useState<IhTestDraftRecord[]>([])
  // #8 IH subtypes are multi-select (O2 + H2S + Sampling on one visit).
  // Ordered by IH_SUBTYPES declaration; first selected doubles as the legacy
  // single serviceSubtype for older consumers.
  const [ihSubtypes, setIhSubtypes] = useState<Set<IhTestType>>(new Set())
  const selectedIhSubtypes = IH_SUBTYPES.map(s => s.value).filter(v => ihSubtypes.has(v))
  const ihSubtype: IhTestType | null = selectedIhSubtypes[0] ?? null
  const setIhSubtype = (v: IhTestType | null) => setIhSubtypes(v ? new Set([v]) : new Set())
  const [isCallOut, setIsCallOut] = useState(false)

  function cleanNewInstallSystems() {
    return newInstallSystems
      .map(system => ({
        workPointName: system.workPointName.trim(),
        airSystemType: system.airSystemType,
        reelSerialNumber: system.reelSerialNumber.trim() || undefined,
        standSerialNumber: system.standSerialNumber.trim() || undefined,
        regulatorSerial: system.regulatorSerial.trim() || undefined,
        cylinders: system.cylinders
          .filter(c => c.serialNumber.trim() || c.hydroDate || c.expiryDate)
          .map(c => ({
            serialNumber: c.serialNumber.trim(),
            hydroDate: c.hydroDate || undefined,
            expiryDate: c.expiryDate || undefined,
          })),
        installDescription: system.installDescription.trim() || undefined,
      }))
      .filter(system => system.workPointName)
  }

  function newInstallSystemFromPayload(ni: any): NewInstallSystem {
    const base = blankNewInstallSystem()
    const cylinders = Array.isArray(ni?.cylinders) && ni.cylinders.length > 0
      ? ni.cylinders.map((c: any) => ({
        serialNumber: c?.serialNumber || '',
        hydroDate: c?.hydroDate || '',
        expiryDate: c?.expiryDate || '',
      }))
      : Array.isArray(ni?.cylinderSerials) && ni.cylinderSerials.length > 0
        ? ni.cylinderSerials.map((s: string) => ({ serialNumber: s, hydroDate: '', expiryDate: '' }))
        : base.cylinders
    return {
      ...base,
      id: ni?.id || base.id,
      workPointName: ni?.workPointName || '',
      airSystemType: ni?.airSystemType || 'tank_battery',
      reelSerialNumber: ni?.reelSerialNumber || '',
      standSerialNumber: ni?.standSerialNumber || '',
      regulatorSerial: ni?.regulatorSerial || '',
      cylinders,
      installDescription: ni?.installDescription || ni?.description || '',
    }
  }

  // ---- Training class state ----
  const [trainingRosterRecords, setTrainingRosterRecords] = useState<TrainingRosterDraftRecord[]>([])
  const [trainingCourseName, setTrainingCourseName] = useState('')

  // Course picker options — the synced ClassPRO catalog, falling back to the
  // bundled COURSE_TYPES when the catalog hasn't hydrated yet (first login /
  // offline before first sync). "Other" (free-text) is a wizard affordance,
  // not a catalog row, so it's appended here.
  const [catalogCourses, setCatalogCourses] = useState<{ value: string; label: string; cardsOnSite: boolean }[] | null>(null)
  useEffect(() => {
    db.courses
      .filter(c => c.isActive)
      .toArray()
      .then(rows => {
        if (rows.length === 0) return
        rows.sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name))
        setCatalogCourses(rows.map(c => ({ value: c.code, label: c.name, cardsOnSite: c.cardsOnSite })))
      })
      .catch(() => { /* fall back to COURSE_TYPES */ })
  }, [])
  const courseOptions = useMemo(
    () => catalogCourses
      ? [...catalogCourses, { value: 'other', label: 'Other', cardsOnSite: false }]
      : COURSE_TYPES,
    [catalogCourses],
  )
  const [trainingCourseOther, setTrainingCourseOther] = useState('')
  const [trainingTrainerName, setTrainingTrainerName] = useState('')
  const [trainingIsOnSite, setTrainingIsOnSite] = useState(false)
  // #12 on-site training mileage (optional, for billing)
  const [trainingMileage, setTrainingMileage] = useState('')
  const [trainingLocationText, setTrainingLocationText] = useState('')
  const [trainingLocation, setTrainingLocation] = useState<TrainingLocationOption | null>(null)

  // #13 QR self-sign-in (roster step). The class must exist server-side for
  // sign-ins to land, so in create mode "open sign-in" first creates the
  // ticket as a draft and reopens the wizard in edit mode pointed at it.
  const [signinQr, setSigninQr] = useState<{ url: string; qrDataUrl: string } | null>(null)
  const [signinBusy, setSigninBusy] = useState(false)
  const [signinError, setSigninError] = useState('')
  const [signinRefreshing, setSigninRefreshing] = useState(false)
  const [signinNewCount, setSigninNewCount] = useState<number | null>(null)

  // ---- Start Job: selected dispatched rental (Phase C) ----
  const [startJobCandidates, setStartJobCandidates] = useState<RentalJobOption[]>([])
  const [startJobLoading, setStartJobLoading] = useState(false)
  const [selectedStartJobRentalId, setSelectedStartJobRentalId] = useState<string | null>(null)

  // ---- Rental state ----
  const [rentalItems, setRentalItems] = useState<OfflineRentalAgreementItem[]>([])
  const [deployShortReason, setDeployShortReason] = useState('')
  // #19/#20 Deploy QA gate: scanned gear waits here until its required
  // inspection is completed (assembly children ride under the parent's).
  const [pendingDeploy, setPendingDeploy] = useState<{
    items: OfflineRentalAgreementItem[]
    category: DeployCategory
    name: string
    serial: string
  } | null>(null)
  // #19 equipment already deployed on the selected (active) job — read-only context.
  const [existingDeployed, setExistingDeployed] = useState<{ id: string; productName: string; serialNumber: string }[]>([])
  const [rentalBillingRateType, setRentalBillingRateType] = useState('weekly')
  // Catalog slice for the package baseline diff: a scanned serial only knows its
  // productId, and the diff runs on Product.category. Also carries the rental
  // rates, so an over-baseline extra can be priced without another round-trip.
  const [deployProductsById, setDeployProductsById] = useState<Map<string, RentalBomProduct>>(new Map())
  const [rentalAfeNumber, setRentalAfeNumber] = useState('')
  // Phase C: classification flags now live on the dispatched rental contract,
  // not on the Start Job ticket. Kept here read-only for the rn_review summary
  // and any legacy ticket edit-load that wants to surface them.
  const [rentalIsManned] = useState(true)
  const [rentalIsRigJob] = useState(false)
  const [rentalMonitorsIncluded] = useState(false)
  const [showEquipmentScanner, setShowEquipmentScanner] = useState(false)
  // Rental liability / site contact
  const [rentalLiabilitySignedByName, setRentalLiabilitySignedByName] = useState('')
  const [rentalLiabilitySignature, setRentalLiabilitySignature] = useState<string | null>(null)
  const [rentalLiabilityAcknowledged, setRentalLiabilityAcknowledged] = useState(false)
  const [rentalSiteContactName, setRentalSiteContactName] = useState('')
  const [rentalSiteContactPhone, setRentalSiteContactPhone] = useState('')
  const [rentalSiteContactEmail, setRentalSiteContactEmail] = useState('')
  const [siteContactSameAsSigner, setSiteContactSameAsSigner] = useState(false)

  // #1 PIC roster (manned-trailer) — seeded from the linked rental agreement,
  // edited here, written through to the agreement on sync.
  const [rentalPics, setRentalPics] = useState<RentalPic[]>([])
  const [picsSeededFor, setPicsSeededFor] = useState<string | null>(null)
  // On-site contact pulled from the linked rental agreement (read-only) so a
  // manned-trailer tech has the customer's site contact in hand without popping
  // back to the rental. Seeded alongside the PIC roster.
  const [linkedSiteContact, setLinkedSiteContact] = useState<{ name: string; phone: string; email: string } | null>(null)

  // ---- Air Fill state ----
  const [airFillLocationText, setAirFillLocationText] = useState('')
  // Free text only — not a fixed asset, not a recallable data point. Just
  // captured for the invoice location and pulled into reports as requested.
  const [driverName, setDriverName] = useState('')
  const [airFillArrivePsi, setAirFillArrivePsi] = useState('')
  const [airFillDepartPsi, setAirFillDepartPsi] = useState('')

  // Track whether we've restored from a draft
  const [draftRestored, setDraftRestored] = useState(false)

  // Restore draft on load
  useEffect(() => {
    if (!isLoaded || draftRestored) return
    if (draft?.wizardData) {
      const d = draft.wizardData
      // Restore work type (backward compat: default to field_service)
      if (d.workType) {
        setWorkType(d.workType as WorkType)
        setStep(draft.step || 1) // skip type selector since type was already chosen
      } else if (d.serviceType === 'fit_test') {
        // Legacy draft upgrade: fit_test used to be a field_service subtype
        setWorkType('fit_test')
        setStep(draft.step || 1)
      } else if (d.customer || d.serviceType) {
        // Legacy draft without workType — assume field_service
        setWorkType('field_service')
        setStep(draft.step || 1)
      }
      if (d.customer) setCustomer(d.customer)
      if (d.location) {
        // Backward compat: old drafts had `well` (singular), migrate to `wells` array
        const loc = d.location as any
        if (loc.well && !loc.wells) {
          loc.wells = [loc.well]
          delete loc.well
        }
        if (!loc.wells) loc.wells = []
        setLocation(loc as LocationSelection)
      }
      if (d.serviceType && d.serviceType !== 'fit_test') setServiceType(normalizeServiceType(d.serviceType))
      if (d.poNumber) setPoNumber(d.poNumber)
      // #3 restore structured refs; migrate a legacy poNumber-only draft.
      if (d.billingRefs && d.billingRefs.length > 0) {
        setBillingRefs(d.billingRefs)
        setBillingRefsSeeded(true)
      } else if (d.poNumber) {
        setBillingRefs([{ id: uuidv4(), type: 'po', value: d.poNumber, required: false }])
        setBillingRefsSeeded(true)
      }
      if (d.division !== undefined) setDivision(d.division)
      if (d.isDickinson !== undefined) setIsDickinson(d.isDickinson)
      if (d.returnShopShortCode) setReturnShopShortCode(d.returnShopShortCode)
      if (d.linkedRentalId) setLinkedRentalId(d.linkedRentalId)
      if (d.arrivedAt) setArrivedAt(d.arrivedAt)
      if (d.serviceDate) setServiceDate(d.serviceDate)
      if (d.dispatchNotes) setDispatchNotes(d.dispatchNotes)
      if (d.lineItems) setLineItems(d.lineItems)
      if (d.departedAt) setDepartedAt(d.departedAt)
      if (d.onSiteSubtype) setOnSiteSubtype(d.onSiteSubtype)
      if (d.onSiteEntries) setOnSiteEntries(d.onSiteEntries)
      if (d.onSiteOtherDescription) setOnSiteOtherDescription(d.onSiteOtherDescription)
      setSiteTimesManual(restoreSiteTimesManual({
        manual: d.siteTimesManual, entries: d.onSiteEntries,
        serviceDate: d.serviceDate, arrivedAt: d.arrivedAt, departedAt: d.departedAt,
      }))
      if (d.workNotes) setWorkNotes(d.workNotes)
      if (d.photos) setPhotos(d.photos)
      if (d.siteSignPhotos) setSiteSignPhotos(d.siteSignPhotos)
      if (d.signature !== undefined) setSignature(d.signature)
      if (d.fitTestRecords) {
        // Backward compat: old drafts may lack disclosure fields
        const migrated = d.fitTestRecords.map(rec => ({
          ...rec,
          jobTitle: rec.jobTitle ?? '',
          disclosureConditions: rec.disclosureConditions ?? [],
          isCleanShaven: rec.isCleanShaven ?? null,
          wearsGlassesContacts: rec.wearsGlassesContacts ?? null,
          adverseReactions: rec.adverseReactions ?? [],
          criteriaAcknowledged: rec.criteriaAcknowledged ?? false,
          participantSignature: rec.participantSignature ?? null,
        }))
        setFitTestRecords(migrated)
      }
      if (d.airSystemRecords) {
        setAirSystemRecords(d.airSystemRecords)
      }
      if (Array.isArray(d.newInstallSystems) && d.newInstallSystems.length > 0) {
        setNewInstallSystems(d.newInstallSystems.map((system: any) => newInstallSystemFromPayload(system)))
      }
      if (d.ihTestRecords) {
        setIhTestRecords(d.ihTestRecords)
      }
      if (d.gasDetectionRecords) {
        setGasDetectionRecords(d.gasDetectionRecords)
      }
      if (d.gasDetectionFixed !== undefined) setGasDetectionFixed(d.gasDetectionFixed)
      if (d.gasDetectionArea !== undefined) setGasDetectionArea(d.gasDetectionArea)
      if (Array.isArray(d.d3CombinedServices) && d.d3CombinedServices.length > 0) {
        setD3CombinedServices(new Set(d.d3CombinedServices))
      }
      // Restore IH subtypes — multi array preferred; legacy drafts only carried
      // the single serviceType.
      if (d.workType === 'ih_testing') {
        if (Array.isArray(d.ihSubtypes) && d.ihSubtypes.length > 0) {
          setIhSubtypes(new Set(d.ihSubtypes))
        } else if (d.serviceType) {
          setIhSubtype(d.serviceType as IhTestType)
        }
      }
      // Restore training class state
      if (d.trainingRosterRecords) {
        setTrainingRosterRecords(d.trainingRosterRecords)
      }
      if (d.trainingCourseName) setTrainingCourseName(d.trainingCourseName)
      if (d.trainingCourseOther) setTrainingCourseOther(d.trainingCourseOther)
      if (d.trainingTrainerName) setTrainingTrainerName(d.trainingTrainerName)
      if (d.trainingIsOnSite !== undefined) setTrainingIsOnSite(d.trainingIsOnSite)
      if (d.trainingMileage) setTrainingMileage(d.trainingMileage)
      // #10 Occ Health setup restore
      if (Array.isArray(d.occServices) && d.occServices.length > 0) setOccServices(new Set(d.occServices))
      if (d.occOnSite !== undefined) setOccOnSite(d.occOnSite)
      if (d.occMileage) setOccMileage(d.occMileage)
      if (d.trainingLocationText) setTrainingLocationText(d.trainingLocationText)
      if (d.cpLocationId) setTrainingLocation({ id: d.cpLocationId, name: d.trainingLocationText || d.cpLocationId, type: 'client' })
      if (d.rigPresent) {
        setRigPresent(true)
        if (d.presentRigId) setPresentRig({ id: d.presentRigId, name: d.presentRigName || d.presentRigId, kind: 'rig' })
      }
      // Restore air fill state
      if (d.airFillLocationText) setAirFillLocationText(d.airFillLocationText)
      if (d.driverName) setDriverName(d.driverName)
      if (d.airFillArrivePsi) setAirFillArrivePsi(d.airFillArrivePsi)
      if (d.airFillDepartPsi) setAirFillDepartPsi(d.airFillDepartPsi)
      // Restore rental state
      if (d.selectedStartJobRentalId) setSelectedStartJobRentalId(d.selectedStartJobRentalId)
      if (d.rentalItems) setRentalItems(d.rentalItems)
      if (d.deployShortReason) setDeployShortReason(d.deployShortReason)
      if (d.rentalBillingRateType) setRentalBillingRateType(d.rentalBillingRateType)
      if (d.rentalAfeNumber) setRentalAfeNumber(d.rentalAfeNumber)
      if (d.rentalLiabilitySignedByName) setRentalLiabilitySignedByName(d.rentalLiabilitySignedByName)
      if (d.rentalLiabilitySignature !== undefined) setRentalLiabilitySignature(d.rentalLiabilitySignature ?? null)
      if (d.rentalLiabilityAcknowledged) setRentalLiabilityAcknowledged(d.rentalLiabilityAcknowledged)
      if (d.rentalSiteContactName) setRentalSiteContactName(d.rentalSiteContactName)
      if (d.rentalSiteContactPhone) setRentalSiteContactPhone(d.rentalSiteContactPhone)
      if (d.rentalSiteContactEmail) setRentalSiteContactEmail(d.rentalSiteContactEmail)
      if (d.rentalPics) setRentalPics(d.rentalPics)
    }
    // If no draft restored a work type, check ?type= query param to auto-select
    if (!draft?.wizardData?.workType) {
      const typeParam = searchParams.get('type') as WorkType | null
      if (typeParam && WORK_TYPES.some(wt => wt.key === typeParam)) {
        setWorkType(typeParam)
        setStep(1) // skip the type selector
      }
      // ADR-0017: the division rides the path. WizardShell stamps ?division=
      // from the tapped tile; flows entered from an app-switcher surface
      // (Training, Occ Health, Direct Sale) fall back to their work type's
      // division. Either way EVERY work type carries one, so nothing lands in
      // QB uncategorized. The tech never picks it.
      const divisionParam = searchParams.get('division')
      if (isQbDivision(divisionParam)) {
        setDivision(divisionParam)
      } else if (typeParam && WORK_TYPE_QB_DIVISION[typeParam]) {
        setDivision(WORK_TYPE_QB_DIVISION[typeParam])
      }
      // The division tile already said what this is — "D4 › Daily Ticket" IS
      // On-Site Services › Manned Trailer. WizardShell stamps both onto the
      // URL; honor them so the tech isn't asked to re-pick what they just
      // tapped. Answered-from-the-path selections render collapsed below.
      const serviceParam = searchParams.get('service')
      if (serviceParam && SERVICE_TYPES.some(st => st.value === serviceParam)) {
        setServiceType(serviceParam)
        setServiceFromPath(true)
      }
      const subtypeParam = searchParams.get('subtype')
      if (serviceParam === 'on_site_services') {
        const match = ON_SITE_SUBTYPES.find(s => s.value === subtypeParam)
        if (match) setOnSiteSubtype(match.value)
      } else if (serviceParam === 'cascade_air' && subtypeParam) {
        const requested = subtypeParam
          .split(',')
          .map(s => s.trim())
          .filter((s): s is CascadeAirSubtype => CASCADE_AIR_SUBTYPE_VALUES.includes(s as CascadeAirSubtype))
        if (requested.includes('new_install')) {
          setCascadeAirSubtypes(new Set<CascadeAirSubtype>(['new_install']))
        } else if (requested.length > 0) {
          setCascadeAirSubtypes(new Set(requested))
        }
      }
    }
    setDraftRestored(true)
  }, [isLoaded, draft, draftRestored, searchParams])

  // ADR-0017: default the Dickinson bit from the yard the user is working at
  // (the header site switcher). Convenience only — the ticket still wins, and
  // there's enough Williston↔Dickinson back-and-forth that it has to. New
  // tickets only; never clobbers a restored draft or an edit load.
  const dickinsonSeeded = useRef(false)
  useEffect(() => {
    if (isEditMode || !draftRestored || dickinsonSeeded.current) return
    dickinsonSeeded.current = true
    if (draft?.wizardData?.workType) return // a live draft owns isDickinson
    const activeSiteId = getActiveSiteId()
    if (!activeSiteId) return
    api.get<{ data: { id: string; name: string; shortCode: string }[] }>('/sites?active=true')
      .then(({ data }) => {
        const site = data.find(s => s.id === activeSiteId)
        if (site && (/dickinson/i.test(site.name) || site.shortCode?.toUpperCase().startsWith('DI'))) {
          setIsDickinson(true)
        }
      })
      .catch(() => { /* offline / no sites — leave the Williston default */ })
  }, [isEditMode, draftRestored, draft])

  // ---- Template seed: ?template=<sourceTicketId> ----
  // Fetches the source ticket and pre-fills wizard with context (customer,
  // location, work type, PO/division flags) while leaving work-detail fields
  // (line items, notes, photos, signatures, sub-records, dates) blank.
  // Skipped in edit mode and when the user already has a draft in flight.
  const [templateSeeded, setTemplateSeeded] = useState(false)
  useEffect(() => {
    if (!isLoaded || !draftRestored || templateSeeded || isEditMode) return
    const templateId = searchParams.get('template')
    if (!templateId) {
      setTemplateSeeded(true)
      return
    }
    if (draft?.wizardData?.workType) {
      // User already started something on this draft id — don't clobber.
      setTemplateSeeded(true)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const src = await api.get<any>(`/tickets/${templateId}`)
        if (cancelled || !src) return
        const derived = deriveWorkTypeFromTicket(src.ticketType, src.serviceSubtype)
        if (!derived) return  // unsupported source type — the guard below redirects out
        setWorkType(derived)
        setStep(1)
        if (src.company) {
          setCustomer({
            id: src.company.id,
            name: src.company.name,
            companyType: 'operator',
            city: null,
            state: null,
          })
        }
        setLocation({
          field: src.field ? { id: src.field.id, name: src.field.name } : null,
          pad: src.pad && src.fieldId
            ? {
              id: src.pad.id,
              name: src.pad.name,
              fieldId: src.fieldId,
              pendingReview: src.pad.pendingReview ?? false,
              currentOperatorId: src.pad.currentOperatorId ?? null,
              currentOperatorName: src.pad.currentOperatorName ?? null,
            }
            : null,
          wells: src.well && src.padId
            ? [{
              id: src.well.id,
              wellName: src.well.wellName ?? '',
              padId: src.well.padId ?? src.padId,
              apiNumber: src.well.apiNumber ?? null,
              pendingReview: src.well.pendingReview ?? false,
              currentOperatorId: src.well.currentOperatorId ?? null,
              currentOperatorName: src.well.currentOperatorName ?? null,
            }]
            : [],
        })
        // Field-service subtype carries over (gas detection, cascade, on-site)
        if (
          derived === 'field_service' &&
          src.serviceSubtype &&
          src.serviceSubtype !== 'air_fill' &&
          src.serviceSubtype !== 'fit_test'
        ) {
          setServiceType(normalizeServiceType(src.serviceSubtype))
        }
        if (derived === 'ih_testing' && src.serviceSubtype) {
          setIhSubtype(src.serviceSubtype as IhTestType)
        }
        if (src.poNumber) setPoNumber(src.poNumber)
        // #3 carry structured refs from the template (or migrate flat po).
        if (Array.isArray(src.billingRefs) && src.billingRefs.length > 0) {
          setBillingRefs(src.billingRefs as BillingRef[])
          setBillingRefsSeeded(true)
        } else if (src.poNumber) {
          setBillingRefs([{ id: uuidv4(), type: 'po', value: src.poNumber, required: false }])
          setBillingRefsSeeded(true)
        }
        if (src.division) setDivision(src.division as Division)
        if (src.isDickinson) setIsDickinson(true)
        // Training: keep course context — same employer often books the
        // same course again. Roster (the people) is intentionally NOT copied.
        if (derived === 'training' && src.customData) {
          if (src.customData.courseName) setTrainingCourseName(src.customData.courseName)
          if (src.customData.courseOther) setTrainingCourseOther(src.customData.courseOther)
          if (src.customData.trainerName) setTrainingTrainerName(src.customData.trainerName)
          if (src.customData.isOnSite !== undefined) setTrainingIsOnSite(!!src.customData.isOnSite)
          if (src.customData.locationText) setTrainingLocationText(src.customData.locationText)
          if (src.customData.cpLocationId) {
            setTrainingLocation({ id: src.customData.cpLocationId, name: src.customData.locationText || src.customData.cpLocationId, type: 'client' })
          }
        }
        // Air fill: keep the truck/unit identifier + driver name
        if (derived === 'air_fill' && src.customData?.truckUnit) {
          setAirFillLocationText(src.customData.truckUnit)
        }
        if (derived === 'air_fill' && src.customData?.driverName) {
          setDriverName(src.customData.driverName)
        }
      } catch {
        // Ignore — wizard falls back to empty state and the user picks normally.
      } finally {
        if (!cancelled) {
          setTemplateSeeded(true)
          // Strip ?template= from URL so a reload doesn't re-seed.
          const next = new URLSearchParams(searchParams)
          next.delete('template')
          setSearchParams(next, { replace: true })
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, draftRestored, templateSeeded, isEditMode])

  // ADR-0013 backstop: this wizard has no work-type screen any more, so a
  // create-mode arrival that never resolved one has nothing to render. Two
  // paths still get here — a ?template= copy whose source type can't be
  // derived (or whose fetch failed), and a bare /tickets/new from a stale
  // link or bookmark. Send both to the real picker. Gated on templateSeeded
  // so the async template seed gets to set a work type first.
  useEffect(() => {
    if (isEditMode || !isLoaded || !draftRestored || !templateSeeded) return
    if (workType) return
    navigate('/tickets/start', { replace: true })
  }, [isEditMode, isLoaded, draftRestored, templateSeeded, workType, navigate])

  // ---- Edit mode: load existing ticket ----
  useEffect(() => {
    if (!isEditMode || !isLoaded || editDataLoaded) return
    // If a draft exists for this edit session, skip loading from ticket
    if (draft?.wizardData?.workType) {
      setEditDataLoaded(true)
      return
    }
    loadExistingTicket(editTicketId!)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode, isLoaded, editDataLoaded, editTicketId])

  // #13 Landing after the create→edit sign-in handoff (?signin=1): jump to the
  // roster step and restore the QR (the link route is idempotent — it returns
  // the class's existing token).
  useEffect(() => {
    if (!isEditMode || !editDataLoaded || workType !== 'training') return
    if (searchParams.get('signin') !== '1') return
    const rosterIdx = activeConfig ? activeConfig.steps.indexOf('tr_roster') : -1
    if (rosterIdx >= 0) setStep(rosterIdx + 1)
    api.post<{ url: string; qrDataUrl: string }>(`/train/link/${editTicketId}`, {})
      .then(setSigninQr)
      .catch(() => { /* offline — the roster panel's button can retry */ })
    const next = new URLSearchParams(searchParams)
    next.delete('signin')
    setSearchParams(next, { replace: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode, editDataLoaded, workType])

  async function loadExistingTicket(id: string) {
    try {
      // Try Dexie first (fast, works offline)
      const ticket = await db.tickets.get(id)
      if (ticket) {
        const localLineItems = await db.ticketLineItems.where('ticketId').equals(id).toArray()
        const localFitTests = await db.fitTestRecords.where('ticketId').equals(id).toArray()
        const localAirSystems = await db.airSystemRecords.where('ticketId').equals(id).toArray()
        const localIhTests = await db.ihTestRecords.where('ticketId').equals(id).toArray()
        const localTrainingRoster = await db.trainingRosterRecords.where('ticketId').equals(id).toArray()
        const company = ticket.companyId ? await db.companies.get(ticket.companyId) : null

        // Resolve location FKs → named objects (Dexie ticket stores only IDs)
        const [pad, field, singleWell] = await Promise.all([
          ticket.padId ? db.pads.get(ticket.padId) : Promise.resolve(null),
          ticket.fieldId ? db.fields.get(ticket.fieldId) : Promise.resolve(null),
          ticket.wellId ? db.wells.get(ticket.wellId) : Promise.resolve(null),
        ])
        const multiWellIds = (ticket.customData as any)?.wellIds
        const wellsById: Record<string, OfflineWell | undefined> = {}
        if (Array.isArray(multiWellIds) && multiWellIds.length > 0) {
          const wells = await db.wells.bulkGet(multiWellIds)
          for (const w of wells) if (w) wellsById[w.id] = w
        }
        const enriched: any = {
          ...ticket,
          field: field ? { id: field.id, name: field.name } : undefined,
          pad: pad ? {
            id: pad.id,
            name: pad.name,
            fieldId: pad.fieldId,
            county: (pad as any).county ?? null,
            pendingReview: (pad as any).pendingReview ?? false,
            currentOperatorId: (pad as any).currentOperatorId ?? null,
            currentOperatorName: (pad as any).currentOperatorName ?? null,
          } : undefined,
          well: singleWell ? {
            id: singleWell.id,
            wellName: singleWell.wellName,
            padId: singleWell.padId,
            apiNumber: singleWell.apiNumber ?? null,
            pendingReview: singleWell.pendingReview ?? false,
            currentOperatorId: singleWell.currentOperatorId ?? null,
            currentOperatorName: singleWell.currentOperatorName ?? null,
          } : undefined,
          _resolvedWellsById: wellsById,
        }
        populateFromTicket(enriched, localLineItems, localFitTests, localAirSystems, localIhTests, localTrainingRoster, company)
        return
      }

      // Fallback: try API
      const apiTicket = await api.get<any>(`/tickets/${id}`)
      if (apiTicket?.id) {
        populateFromTicket(apiTicket, apiTicket.lineItems || [], apiTicket.fitTestRecords || [], apiTicket.airSystemInspections || [], apiTicket.ihTestRecords || [], apiTicket.trainingRosterRecords || [], apiTicket.company)
        return
      }
      setError('Ticket not found')
    } catch {
      setError('Could not load ticket for editing')
    }
  }

  function populateFromTicket(ticket: any, ticketLineItems: any[], ticketFitTests: any[], ticketAirSystems: any[], ticketIhTests: any[], ticketTrainingRoster: any[], company?: any) {
    // Determine work type
    let resolvedWorkType: WorkType = 'field_service'
    if (ticket.serviceSubtype === 'air_fill') resolvedWorkType = 'air_fill'
    else if (ticket.ticketType === 'field_service' && ticket.serviceSubtype === 'inspection') resolvedWorkType = 'field_inspection'
    else if (ticket.serviceSubtype === 'fit_test') resolvedWorkType = 'fit_test'
    else if (ticket.ticketType === 'inspection' && ticket.serviceSubtype?.startsWith('ih_')) resolvedWorkType = 'ih_testing'
    else if (ticket.serviceSubtype === 'safety_training' || (ticket.ticketType === 'training' && ticket.serviceSubtype !== 'fit_test')) resolvedWorkType = 'training'
    else if (ticket.ticketType === 'rental') resolvedWorkType = 'rental'
    else if (ticket.ticketType === 'repair') resolvedWorkType = 'repair'

    // Check if work type is coming soon (can't edit these yet)
    const config = WORK_TYPES.find(wt => wt.key === resolvedWorkType)
    if (config?.comingSoon) {
      setError(`Editing ${config.label} tickets is not yet supported`)
      return
    }

    setWorkType(resolvedWorkType)
    setOriginalStatus(ticket.status || 'draft')

    // Customer — mirror the location fallback below: preserve the companyId
    // as a stub even when the Company row isn't in Dexie (pruned / wiped / not
    // yet synced). Without this, an offline edit-reopen dropped the customer
    // entirely, and submit then saved a customer-less ticket.
    const c = company || ticket.company
    if (c) {
      setCustomer({ id: c.id, name: c.name, companyType: c.companyType || '', city: c.city || null, state: c.state || null })
    } else if (ticket.companyId) {
      setCustomer({ id: ticket.companyId, name: ticket.companyId, companyType: '', city: null, state: null })
    }

    // Location — load from ticket fields
    const locField = ticket.field || (ticket.fieldId ? { id: ticket.fieldId, name: ticket.fieldId } : null)
    const locPad = ticket.pad || (ticket.padId ? { id: ticket.padId, name: ticket.padId, fieldId: ticket.fieldId } : null)
    const locWells: any[] = []
    // Single well from ticket
    if (ticket.well) {
      locWells.push({
        id: ticket.well.id,
        wellName: ticket.well.wellName || null,
        padId: ticket.well.padId || ticket.padId || null,
        apiNumber: ticket.well.apiNumber ?? null,
        pendingReview: ticket.well.pendingReview ?? false,
        currentOperatorId: ticket.well.currentOperatorId ?? null,
        currentOperatorName: ticket.well.currentOperatorName ?? null,
      })
    } else if (ticket.wellId) {
      locWells.push({ id: ticket.wellId, wellName: null, padId: ticket.padId || null })
    }
    // Multi-well from customData
    if (ticket.customData?.wellIds && Array.isArray(ticket.customData.wellIds)) {
      const existingIds = new Set(locWells.map(w => w.id))
      const resolved = (ticket._resolvedWellsById || {}) as Record<string, {
        wellName?: string | null
        padId?: string | null
        apiNumber?: string | null
        pendingReview?: boolean
        currentOperatorId?: string | null
        currentOperatorName?: string | null
      } | undefined>
      for (const wid of ticket.customData.wellIds) {
        if (!existingIds.has(wid)) {
          const w = resolved[wid]
          locWells.push({
            id: wid,
            wellName: w?.wellName || null,
            padId: w?.padId || ticket.padId || null,
            apiNumber: w?.apiNumber ?? null,
            pendingReview: w?.pendingReview ?? false,
            currentOperatorId: w?.currentOperatorId ?? null,
            currentOperatorName: w?.currentOperatorName ?? null,
          })
        }
      }
    }
    setLocation({ field: locField, pad: locPad, wells: locWells })

    // Rig present — mirrors the pad/well fallback above: use the included
    // relation when present, else fall back to an id-only stub so re-saving
    // an edited ticket doesn't silently clear an existing presentRigId.
    if (ticket.rigPresent) {
      setRigPresent(true)
      const rig = ticket.presentRig || (ticket.presentRigId ? { id: ticket.presentRigId, name: ticket.presentRigId } : null)
      if (rig) setPresentRig({ id: rig.id, name: rig.name, kind: 'rig' })
    }

    // Service subtype (field service only). Legacy values are mapped to the
    // new top-level type so the UI shows the correct selection.
    if (ticket.serviceSubtype && ticket.serviceSubtype !== 'fit_test') {
      setServiceType(normalizeServiceType(ticket.serviceSubtype))
    }

    setPoNumber(ticket.poNumber || '')
    // #3 hydrate structured refs; migrate pre-feature tickets from flat fields.
    if (Array.isArray(ticket.billingRefs) && ticket.billingRefs.length > 0) {
      setBillingRefs(ticket.billingRefs as BillingRef[])
    } else {
      const migrated: BillingRef[] = []
      if (ticket.poNumber) migrated.push({ id: uuidv4(), type: 'po', value: ticket.poNumber, required: false })
      if (ticket.afeNumber) migrated.push({ id: uuidv4(), type: 'afe', value: ticket.afeNumber, required: false })
      if (ticket.costCenter) migrated.push({ id: uuidv4(), type: 'cost_code', value: ticket.costCenter, required: false })
      setBillingRefs(migrated)
    }
    setBillingRefsSeeded(true)
    setDivision((ticket.division as Division) ?? null)
    setIsDickinson(ticket.isDickinson ?? false)
    setLinkedRentalId(ticket.linkedRentalAgreementId || null)
    setServiceDate(calendarDateKey(ticket.serviceDate) || todayKey())
    setArrivedAt(ticket.arrivalTime || null)
    setDepartedAt(ticket.departureTime || null)
    const savedLog = ticket.customData?.onSiteLog as {
      siteTimesManual?: { arrived: boolean; departed: boolean }
      entries?: OnSiteEntry[]; shiftStart?: string; shiftEnd?: string
    } | undefined
    setSiteTimesManual(restoreSiteTimesManual({
      manual: savedLog?.siteTimesManual,
      entries: savedLog?.entries,
      shiftStart: savedLog?.shiftStart,
      shiftEnd: savedLog?.shiftEnd,
      serviceDate: calendarDateKey(ticket.serviceDate) || todayKey(),
      arrivedAt: ticket.arrivalTime, departedAt: ticket.departureTime,
    }))
    setDispatchNotes(ticket.dispatchNotes || '')
    setWorkNotes(ticket.workDescription || '')
    setSignature(ticket.customerRepSignature || null)

    // Line items
    if (ticketLineItems.length > 0) {
      const mapped = ticketLineItems.map(li => ({
        id: li.id,
        lineType: li.lineType || 'part',
        description: li.description || '',
        quantity: Number(li.quantity) || 1,
        rate: li.rate != null ? Number(li.rate) : null,
        total: li.total != null ? Number(li.total) : null,
        unitOfMeasure: li.unitOfMeasure || undefined,
        productId: li.productId || undefined,
        serialNumberInstalled: li.serialNumberInstalled || undefined,
        serialNumberRemoved: li.serialNumberRemoved || undefined,
        testResult: li.testResult || undefined,
        calGasLotNumber: li.calGasLotNumber || undefined,
        notes: li.notes || undefined,
        // Restore the pricing provenance stamped when the line was first
        // added, so a re-opened ticket still says where its rates came from.
        ...(() => {
          const pl = (li.customData as any)?.priceLevel
          return pl && typeof pl === 'object'
            ? {
                priceLevelName: pl.name ?? null,
                listRate: pl.listRate ?? null,
                contractRate: pl.contractRate ?? null,
              }
            : {}
        })(),
      })) as LineItem[]
      setLineItems(mapped)
      setOriginalLineItemIds(new Set(mapped.map(li => li.id)))
    }

    // Fit test records
    if (ticketFitTests.length > 0) {
      const mapped = ticketFitTests.map(ft => ({
        id: ft.id,
        employeeName: ft.employeeName || '',
        employeeId: ft.employeeId || '',
        employerName: ft.employerName || '',
        jobTitle: ft.jobTitle || '',
        respiratorType: ft.respiratorType || '',
        respiratorClass: ft.respiratorClass ?? null,
        respiratorMake: ft.respiratorMake || '',
        respiratorModel: ft.respiratorModel || '',
        respiratorSize: ft.respiratorSize || '',
        secondMask: ft.secondMask ?? null,
        testMethod: ft.testMethod || '',
        passFail: (ft.passFail || 'pass') as 'pass' | 'fail',
        fitFactor: ft.fitFactor != null ? Number(ft.fitFactor) : null,
        meqAccepted: ft.meqAccepted ?? false,
        meqDate: ft.meqDate ? String(ft.meqDate).split('T')[0] : null,
        includesFitTest: ft.includesFitTest !== false,
        includesAudiometric: ft.includesAudiometric === true,
        audiometricResult: ft.audiometricResult ?? null,
        resultFiles: [],
        notes: ft.notes || '',
        disclosureConditions: ft.disclosureConditions || [],
        isCleanShaven: ft.isCleanShaven ?? null,
        wearsGlassesContacts: ft.wearsGlassesContacts ?? null,
        adverseReactions: ft.adverseReactions || [],
        criteriaAcknowledged: ft.criteriaAcknowledged ?? false,
        participantSignature: ft.participantSignature || null,
      })) as FitTestDraftRecord[]
      setFitTestRecords(mapped)
      setOriginalFitTestIds(new Set(mapped.map(ft => ft.id)))
      // #10 restore the visit's service selection (fall back to record flags)
      const occCd = (ticket.customData as any) || {}
      if (Array.isArray(occCd.occServices) && occCd.occServices.length > 0) {
        setOccServices(new Set(occCd.occServices))
      } else {
        const svcs = new Set<'fit_test' | 'audiometric'>()
        if (mapped.some(r => r.includesFitTest !== false)) svcs.add('fit_test')
        if (mapped.some(r => r.includesAudiometric)) svcs.add('audiometric')
        if (svcs.size > 0) setOccServices(svcs)
      }
      if (occCd.isOnSite !== undefined && ticket.serviceSubtype === 'fit_test') setOccOnSite(!!occCd.isOnSite)
      if (occCd.mileage && ticket.serviceSubtype === 'fit_test') setOccMileage(String(occCd.mileage))
    }

    // Air system inspection records
    if (ticketAirSystems.length > 0) {
      const mapped = ticketAirSystems.map((as: any) => ({
        id: as.id,
        ticketId: as.ticketId,
        workPointId: as.workPointId || null,
        workPointName: as.workPointName || '',
        airSystemType: as.airSystemType || 'tank_battery',
        reelSerialNumber: as.reelSerialNumber || '',
        standSerialNumber: as.standSerialNumber || '',
        overallResult: (as.overallResult || 'pass') as AirSystemDraftRecord['overallResult'],
        reelCondition: as.reelCondition || 'pass',
        standCondition: as.standCondition || 'pass',
        hoseCondition: as.hoseCondition || 'pass',
        maskCondition: as.maskCondition || 'pass',
        regulatorCondition: as.regulatorCondition || 'pass',
        gaugeCondition: as.gaugeCondition || 'pass',
        alarmCondition: as.alarmCondition || 'pass',
        cylinderCondition: as.cylinderCondition || 'pass',
        cascadeArrivalPsi: as.cascadeArrivalPsi != null ? Number(as.cascadeArrivalPsi) : null,
        cascadeDeparturePsi: as.cascadeDeparturePsi != null ? Number(as.cascadeDeparturePsi) : null,
        cylinders: Array.isArray(as.cylinders) ? as.cylinders : [],
        serviceActions: as.serviceActions || [],
        partsReplaced: as.partsReplaced || '',
        replacedRegulatorSerialOld: as.replacedRegulatorSerialOld || '',
        replacedRegulatorSerialNew: as.replacedRegulatorSerialNew || '',
        replacedMaskSerialOld: as.replacedMaskSerialOld || '',
        replacedMaskSerialNew: as.replacedMaskSerialNew || '',
        notes: as.notes || '',
        inspectedAt: as.inspectedAt || new Date().toISOString(),
      })) as AirSystemDraftRecord[]
      setAirSystemRecords(mapped)
      setOriginalAirSystemIds(new Set(mapped.map(r => r.id)))
    }

    // IH test records
    if (ticketIhTests.length > 0) {
      const mapped = ticketIhTests.map((r: any) => ({
        id: r.id,
        ticketId: r.ticketId,
        testType: r.testType as IhTestType,
        locationPoint: r.locationPoint || '',
        instrumentModel: r.instrumentModel || '',
        instrumentSerial: r.instrumentSerial || '',
        testData: r.testData || {},
        notes: r.notes || '',
        testedAt: r.testedAt || new Date().toISOString(),
      })) as IhTestDraftRecord[]
      setIhTestRecords(mapped)
      setOriginalIhTestIds(new Set(mapped.map(r => r.id)))
      // #8 Restore the full multi-selection: customData.ihSubtypes if the ticket
      // was created multi, else the union of record types, else the legacy
      // single serviceSubtype.
      const savedSubtypes: IhTestType[] | undefined = (ticket.customData as any)?.ihSubtypes
      if (Array.isArray(savedSubtypes) && savedSubtypes.length > 0) {
        setIhSubtypes(new Set(savedSubtypes))
        setServiceType(savedSubtypes[0])
      } else if (mapped.length > 0) {
        const union = new Set(mapped.map(r => r.testType))
        setIhSubtypes(union)
        setServiceType(mapped[0].testType)
      } else if (ticket.serviceSubtype?.startsWith('ih_')) {
        setIhSubtype(ticket.serviceSubtype as IhTestType)
        setServiceType(ticket.serviceSubtype)
      }
    }

    // Training roster records
    if (ticketTrainingRoster.length > 0) {
      const mapped = ticketTrainingRoster.map((r: any) => ({
        id: r.id,
        ticketId: r.ticketId,
        employeeName: r.employeeName || '',
        employeeId: r.employeeId || '',
        employerName: r.employerName || '',
        employerCompanyId: r.employerCompanyId || null,
        contactEmail: r.contactEmail || '',
        contactPhone: r.contactPhone || '',
        courseName: r.courseName || '',
        passed: r.passed ?? true,
        cardIssuedOnSite: r.cardIssuedOnSite ?? false,
        cardIssuedOfficial: r.cardIssuedOfficial ?? false,
        cardNumber: r.cardNumber || '',
        cardExpiryDate: r.cardExpiryDate || '',
        notes: r.notes || '',
        trainedAt: r.trainedAt || new Date().toISOString(),
      })) as TrainingRosterDraftRecord[]
      setTrainingRosterRecords(mapped)
      setOriginalTrainingRosterIds(new Set(mapped.map(r => r.id)))
    }
    // Restore training course metadata from customData
    if (ticket.customData?.courseName) {
      setTrainingCourseName(ticket.customData.courseName)
    }
    if (ticket.customData?.courseOther) {
      setTrainingCourseOther(ticket.customData.courseOther)
    }
    if (ticket.customData?.trainerName) {
      setTrainingTrainerName(ticket.customData.trainerName)
    }
    if (ticket.customData?.isOnSite !== undefined) {
      setTrainingIsOnSite(ticket.customData.isOnSite)
    }
    if (ticket.customData?.mileage && ticket.serviceSubtype !== 'fit_test') {
      setTrainingMileage(String(ticket.customData.mileage))
    }
    if (ticket.customData?.locationText) {
      setTrainingLocationText(ticket.customData.locationText)
    }
    if (ticket.customData?.cpLocationId) {
      setTrainingLocation({ id: ticket.customData.cpLocationId, name: ticket.customData.locationText || ticket.customData.cpLocationId, type: 'client' })
    }
    if (ticket.customData?.isCallOut) {
      setIsCallOut(true)
    }
    if (ticket.customData?.truckUnit) {
      setAirFillLocationText(ticket.customData.truckUnit)
    }
    if (ticket.customData?.driverName) {
      setDriverName(ticket.customData.driverName)
    }
    if (ticket.customData?.gasDetectionFixed) {
      setGasDetectionFixed(true)
    }
    if (ticket.customData?.gasDetectionArea) {
      setGasDetectionArea(true)
    }
    // Phase B follow-up: subtype is now multi-select. Read the array first;
    // fall back to the single-value field for any in-flight tickets that
    // pre-date the multi-select rollout.
    if (Array.isArray(ticket.customData?.cascadeAirSubtypes)) {
      setCascadeAirSubtypes(new Set(ticket.customData.cascadeAirSubtypes as CascadeAirSubtype[]))
    } else if (ticket.customData?.cascadeAirSubtype) {
      setCascadeAirSubtypes(new Set([ticket.customData.cascadeAirSubtype as CascadeAirSubtype]))
    }
    if (ticket.customData?.cylinderSerial) {
      setCascadeAirCylinderSerial(ticket.customData.cylinderSerial)
    }
    if (ticket.customData?.onSiteSubtype) {
      setOnSiteSubtype(ticket.customData.onSiteSubtype as OnSiteSubtype)
    }
    if (ticket.customData?.onSiteDescription) {
      setOnSiteOtherDescription(ticket.customData.onSiteDescription)
    }
    if (ticket.customData?.onSiteLog) {
      const log = ticket.customData.onSiteLog as any
      // shiftStart/shiftEnd aren't restored — the window is derived from the
      // entries now, and the ticket's own arrival/departure already carry the
      // human-adjusted version of it.
      if (Array.isArray(log.entries)) {
        setOnSiteEntries(log.entries)
      } else {
        // Backward-compat: legacy ticket pre-dates the entries pattern.
        // Promote the old workPerformed + personnel fields into single entries
        // so the user sees the data and can keep adding to it.
        const promoted: OnSiteEntry[] = []
        const baseTime = (log.shiftStart || '').slice(11, 16) || '00:00'
        if (log.workPerformed) {
          promoted.push({ id: uuidv4(), time: baseTime, type: 'note', text: String(log.workPerformed), createdAt: new Date().toISOString() })
        }
        if (log.personnel) {
          promoted.push({ id: uuidv4(), time: baseTime, type: 'note', text: `Personnel: ${log.personnel}`, createdAt: new Date().toISOString() })
        }
        if (promoted.length > 0) setOnSiteEntries(promoted)
      }
    }
    if (Array.isArray(ticket.customData?.pics)) {
      setRentalPics(ticket.customData.pics as RentalPic[])
    }
    if (Array.isArray(ticket.customData?.newInstalls) && ticket.customData.newInstalls.length > 0) {
      setNewInstallSystems(ticket.customData.newInstalls.map((ni: any) => newInstallSystemFromPayload(ni)))
    } else if (ticket.customData?.newInstall) {
      const ni = {
        ...ticket.customData.newInstall,
        installDescription: ticket.customData.installDescription,
      }
      setNewInstallSystems([newInstallSystemFromPayload(ni)])
    }
    if (ticket.customData?.repairDescription) {
      setCascadeAirOtherDescription(ticket.customData.repairDescription)
    }
    if (ticket.customData?.arrivePsi) {
      setAirFillArrivePsi(ticket.customData.arrivePsi)
    }
    if (ticket.customData?.departPsi) {
      setAirFillDepartPsi(ticket.customData.departPsi)
    }

    // Skip type selector, go to step 1
    setStep(1)
    setEditDataLoaded(true)
  }

  // Build current wizard data snapshot
  const getWizardData = useCallback((): WizardDraftData => ({
    workType: workType || '',
    customer,
    location: {
      field: location.field ? { id: location.field.id, name: location.field.name } : null,
      pad: location.pad ? {
        id: location.pad.id,
        name: location.pad.name,
        fieldId: location.pad.fieldId,
        currentOperatorId: location.pad.currentOperatorId ?? null,
        currentOperatorName: location.pad.currentOperatorName ?? null,
      } : null,
      wells: location.wells.map(w => ({
        id: w.id,
        wellName: w.wellName ?? null,
        padId: w.padId ?? null,
        apiNumber: w.apiNumber ?? null,
        pendingReview: w.pendingReview ?? false,
        currentOperatorId: w.currentOperatorId ?? null,
        currentOperatorName: w.currentOperatorName ?? null,
      })),
    },
    serviceType,
    poNumber,
    billingRefs,
    division,
    isDickinson,
    returnShopShortCode,
    arrivedAt,
    siteTimesManual: { ...siteTimesManual },
    onSiteSubtype,
    onSiteEntries,
    onSiteOtherDescription,
    serviceDate,
    dispatchNotes,
    lineItems,
    departedAt,
    workNotes,
    photos,
    siteSignPhotos,
    signature,
    fitTestRecords,
    airSystemRecords,
    newInstallSystems,
    ihTestRecords,
    ihSubtypes: selectedIhSubtypes,
    occServices: occServicesArr,
    occOnSite,
    occMileage,
    trainingMileage,
    gasDetectionRecords,
    gasDetectionFixed,
    gasDetectionArea,
    d3CombinedServices: d3CombinedServicesArr,
    trainingRosterRecords,
    trainingCourseName,
    trainingCourseOther,
    trainingTrainerName,
    trainingIsOnSite,
    trainingLocationText,
    cpLocationId: trainingLocation?.id || null,
    linkedRentalId,
    rigPresent,
    presentRigId: presentRig?.id || null,
    presentRigName: presentRig?.name || null,
    airFillLocationText,
    driverName,
    airFillArrivePsi,
    airFillDepartPsi,
    selectedStartJobRentalId,
    rentalItems,
    deployShortReason,
    rentalBillingRateType,
    rentalAfeNumber,
    rentalLiabilitySignedByName,
    rentalLiabilitySignature,
    rentalLiabilityAcknowledged,
    rentalSiteContactName,
    rentalSiteContactPhone,
    rentalSiteContactEmail,
    rentalPics,
  }), [siteTimesManual, onSiteSubtype, onSiteEntries, onSiteOtherDescription, workType, customer, location, serviceType, poNumber, billingRefs, division, isDickinson, returnShopShortCode, linkedRentalId, arrivedAt, serviceDate, dispatchNotes, lineItems, departedAt, workNotes, photos, siteSignPhotos, signature, fitTestRecords, airSystemRecords, newInstallSystems, ihTestRecords, ihSubtypes, occServices, occOnSite, occMileage, trainingMileage, gasDetectionRecords, gasDetectionFixed, gasDetectionArea, d3CombinedServicesArr, trainingRosterRecords, trainingCourseName, trainingCourseOther, trainingTrainerName, trainingIsOnSite, trainingLocationText, airFillLocationText, airFillArrivePsi, airFillDepartPsi, selectedStartJobRentalId, rentalItems, deployShortReason, rentalBillingRateType, rentalAfeNumber, rentalLiabilitySignedByName, rentalLiabilitySignature, rentalLiabilityAcknowledged, rentalSiteContactName, rentalSiteContactPhone, rentalSiteContactEmail, rentalPics])

  // Auto-save draft on every field change (debounced in useDraftPersistence)
  useEffect(() => {
    if (!draftRestored) return
    persistDraft(getWizardData(), step)
  }, [draftRestored, persistDraft, getWizardData, step])

  function rentalWellIds(raw: unknown): string[] {
    if (!Array.isArray(raw)) return []
    return raw.filter((id): id is string => typeof id === 'string' && id.length > 0)
  }

  function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
  }

  async function decorateRentalJobs(rentals: RentalJobRow[]): Promise<RentalJobOption[]> {
    const companyIds = Array.from(new Set(rentals.map(r => r.companyId).filter(isNonEmptyString)))
    const padIds = Array.from(new Set(rentals.map(r => r.padId).filter(isNonEmptyString)))
    const wellIds = Array.from(new Set(rentals.flatMap(r => {
      const ids = rentalWellIds(r.wellIds)
      return [...ids, r.wellId].filter(isNonEmptyString)
    })))

    const [companies, pads, wells] = await Promise.all([
      companyIds.length ? db.companies.where('id').anyOf(companyIds).toArray() : Promise.resolve([]),
      padIds.length ? db.pads.where('id').anyOf(padIds).toArray() : Promise.resolve([]),
      wellIds.length ? db.wells.where('id').anyOf(wellIds).toArray() : Promise.resolve([]),
    ])
    const companyById = new Map(companies.map(c => [c.id, c]))
    const padById = new Map(pads.map(p => [p.id, p]))
    const wellById = new Map(wells.map(w => [w.id, w]))
    const fieldIds = Array.from(new Set([
      ...rentals.map(r => r.fieldId).filter(isNonEmptyString),
      ...pads.map(p => p.fieldId).filter(isNonEmptyString),
      ...wells.map(w => w.fieldId).filter(isNonEmptyString),
    ]))
    const fields = fieldIds.length ? await db.fields.where('id').anyOf(fieldIds).toArray() : []
    const fieldName = new Map(fields.map(f => [f.id, f.name]))

    return rentals.map((r) => {
      const pad = r.padId ? padById.get(r.padId) : null
      const ids = Array.from(new Set([
        ...rentalWellIds(r.wellIds),
        r.wellId,
      ].filter(isNonEmptyString)))
      const resolvedWells = ids.map(id => wellById.get(id)).filter(Boolean)
      const fieldId = r.fieldId || pad?.fieldId || resolvedWells[0]?.fieldId || null
      const field = r.field?.name || (fieldId ? fieldName.get(fieldId) : null)
      const padName = r.pad?.name || pad?.name || null
      const wellNames = resolvedWells
        .map(w => w?.wellName || null)
        .filter((name): name is string => !!name)
      if (wellNames.length === 0 && r.well?.wellName) wellNames.push(r.well.wellName)
      const locationParts = [field, padName].filter(Boolean)
      const company = r.companyId ? companyById.get(r.companyId) : null

      return {
        id: r.id,
        agreementNumber: r.agreementNumber || null,
        status: r.status,
        startDate: r.startDate,
        billingRateType: r.billingRateType,
        companyId: r.companyId,
        companyName: r.company?.name || r.companyName || company?.name || null,
        fieldId,
        fieldName: field || null,
        padId: r.padId || null,
        padName,
        wellId: r.wellId || ids[0] || null,
        wellIds: ids,
        wellNames,
        poNumber: r.poNumber || null,
        afeNumber: r.afeNumber || null,
        locationDisplay: r.locationDisplay || (locationParts.length ? locationParts.join(' > ') : null),
        siteContactName: r.siteContactName,
        personCallingName: r.personCallingName,
        composition: r.composition || null,
      }
    })
  }

  function rentalJobHeader(r: RentalJobOption): string {
    const wellNames = (r.wellNames || []).filter(Boolean)
    if (wellNames.length === 1) return wellNames[0]
    if (wellNames.length > 1) return `${wellNames[0]} + ${wellNames.length - 1} well${wellNames.length === 2 ? '' : 's'}`
    return r.padName || r.locationDisplay || r.fieldName || r.companyName || r.agreementNumber || r.id.slice(0, 8)
  }

  function rentalJobSite(r: RentalJobOption): string {
    const parts = [r.fieldName, r.padName].filter(Boolean)
    if (parts.length > 0) return parts.join(' > ')
    return r.locationDisplay || rentalJobHeader(r)
  }

  function rentalJobOptionLabel(r: RentalJobOption): string {
    const parts = [
      `Customer: ${r.companyName || 'Unknown'}`,
      `Site: ${rentalJobSite(r)}`,
      r.agreementNumber ? `RA ${r.agreementNumber}` : null,
    ].filter(Boolean)
    return `${rentalJobHeader(r)} - ${parts.join(' | ')}`
  }

  async function resolveRentalLocation(r: RentalJobOption): Promise<LocationSelection> {
    const wellIds = Array.from(new Set([...(r.wellIds || []), r.wellId].filter(isNonEmptyString)))
    const [pad, wells] = await Promise.all([
      r.padId ? db.pads.get(r.padId) : Promise.resolve(null),
      wellIds.length ? db.wells.where('id').anyOf(wellIds).toArray() : Promise.resolve([]),
    ])
    const fieldId = r.fieldId || pad?.fieldId || wells[0]?.fieldId || null
    const field = fieldId ? await db.fields.get(fieldId) : null

    return {
      field: field ? { id: field.id, name: field.name } : (r.fieldId && r.fieldName ? { id: r.fieldId, name: r.fieldName } : null),
      pad: pad ? {
        id: pad.id,
        name: pad.name,
        fieldId: pad.fieldId,
        currentOperatorId: pad.currentOperatorId ?? null,
        currentOperatorName: pad.currentOperatorName ?? null,
      } : (r.padId && r.padName && fieldId ? { id: r.padId, name: r.padName, fieldId } : null),
      wells: wellIds.map((id, index) => {
        const well = wells.find(w => w.id === id)
        return {
          id,
          wellName: well?.wellName || r.wellNames?.[index] || '',
          padId: well?.padId || r.padId || '',
          currentOperatorId: well?.currentOperatorId ?? null,
          currentOperatorName: well?.currentOperatorName ?? null,
        }
      }),
    }
  }

  async function applyRentalJobToWizard(r: RentalJobOption, mode: 'start' | 'link') {
    if (mode === 'start') {
      setSelectedStartJobRentalId(r.id)
      setRentalBillingRateType(r.billingRateType)
    } else {
      setLinkedRentalId(r.id)
    }

    if (r.companyId) {
      const c = await db.companies.get(r.companyId).catch(() => null)
      setCustomer({
        id: r.companyId,
        name: c?.name || r.companyName || 'Unknown customer',
        companyType: c?.companyType || '',
        city: c?.city || null,
        state: c?.state || null,
        cashCcOnly: c?.cashCcOnly ?? false,
        creditHold: c?.creditHold ?? false,
      })
    }

    const nextLocation = await resolveRentalLocation(r)
    if (nextLocation.field || nextLocation.pad || nextLocation.wells.length > 0) {
      setLocation(nextLocation)
    }
  }

  // ---- Field Inspection: pin division to D6 + load shop sites ----
  // FEX field inspection (and the shop work it spawns) is always D6 — only the
  // Dickinson toggle splits the charge path. Force it here so the locked
  // selector and the who_where validation (which requires a division) agree.
  useEffect(() => {
    if (workType !== 'field_inspection') return
    if (division !== 'D6') setDivision('D6')
    // Always refetch, even when the cache seeded shopSites — a stale cache is
    // the thing that would let a deactivated shop stay selectable.
    api.get<{ data: { id: string; name: string; shortCode: string }[] }>('/sites?active=true')
      .then(({ data }) => {
        if (data.length === 0) return
        setShopSites(data)
        cacheActiveSites(data)
      })
      .catch(() => { /* offline — keep whatever the device cache seeded */ })
  }, [workType, division])

  // ---- Field Inspection: keep the return-shop pick pointing at a real site ----
  //
  // The submitted short code becomes `transitToShortCode` on the spawned shop
  // work order, and the server resolves it to a Site to build the transfer
  // event that puts the gear in that shop's Incoming column. A code that
  // doesn't resolve means no transfer event and no inbound card anywhere — so
  // the pick is validated against the live list HERE, before it can be
  // submitted, rather than being discovered later as absent equipment.
  //
  // Runs whenever the list changes, which also covers a restored draft holding
  // a shop that has since been deactivated.
  useEffect(() => {
    if (workType !== 'field_inspection') return
    if (shopSites.length === 0) return
    if (shopSites.some(sit => sit.shortCode === returnShopShortCode)) return

    // Preference order: the tech's own home site, then Williston (the ~98%
    // case, but only if it actually exists), then whatever the first site is.
    // Every arm comes off the live list, so the result is always resolvable.
    const home = user?.homeSiteId ? shopSites.find(sit => sit.id === user.homeSiteId) : undefined
    const williston = shopSites.find(sit => sit.shortCode === 'WIL')
    setReturnShopShortCode((home ?? williston ?? shopSites[0]).shortCode)
  }, [workType, shopSites, returnShopShortCode, user?.homeSiteId])

  // ---- Load Start Job candidates for the rental deploy flow ----
  useEffect(() => {
    if (workType !== 'rental') {
      setStartJobCandidates([])
      return
    }
    let cancelled = false
    setStartJobLoading(true)
    ;(async () => {
      try {
        // Pull from server first (covers freshly-dispatched contracts that
        // haven't synced down yet). Fall back to Dexie if offline.
        let rentals: RentalJobRow[] = []
        try {
          const params = new URLSearchParams({ limit: '200' })
          if (customer?.id) params.set('companyId', customer.id)
          const res = await api.get<{ data: RentalJobRow[] }>(`/rentals?${params}`)
          rentals = (res.data || []).filter(r => r.status === 'scheduled' || r.status === 'active')
        } catch {
          const local = customer?.id
            ? await db.rentalAgreements
              .where('companyId').equals(customer.id)
              .filter(r => r.status === 'scheduled' || r.status === 'active')
              .toArray()
            : await db.rentalAgreements
              .filter(r => r.status === 'scheduled' || r.status === 'active')
              .toArray()
          rentals = local
        }

        if (!cancelled) {
          setStartJobCandidates(await decorateRentalJobs(rentals))
        }
      } finally {
        if (!cancelled) setStartJobLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [workType, customer?.id])

  // #19 Surface equipment already on the selected job (active rentals being
  // re-deployed / added to). Read-only context above the scanner.
  useEffect(() => {
    if (workType !== 'rental' || !selectedStartJobRentalId) {
      setExistingDeployed([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const data = await api.get<any>(`/rentals/${selectedStartJobRentalId}`)
        if (!cancelled && Array.isArray(data?.items)) {
          setExistingDeployed(
            data.items
              .filter((i: any) => i.status === 'deployed')
              .map((i: any) => ({
                id: i.id,
                productName: i.product?.name || 'Equipment',
                serialNumber: i.serializedEquipment?.serialNumber || '?',
              }))
          )
        }
      } catch {
        if (!cancelled) setExistingDeployed([])
      }
    })()
    return () => { cancelled = true }
  }, [workType, selectedStartJobRentalId])

  // ---- Load active rentals for linked rental dropdown ----
  useEffect(() => {
    const mannedTrailerPath = serviceType === 'on_site_services' && onSiteSubtype === 'manned_trailer'
    if (workType === 'rental' || (!customer?.id && !mannedTrailerPath)) {
      setActiveRentals([])
      return
    }
    ;(async () => {
      try {
        const rentals = customer?.id
          ? await db.rentalAgreements
            .where('companyId').equals(customer.id)
            .filter(r => r.status === 'active')
            .toArray()
          : await db.rentalAgreements
            .filter(r => r.status === 'active')
            .toArray()
        setActiveRentals(await decorateRentalJobs(rentals))
      } catch {
        setActiveRentals([])
      }
    })()
  }, [customer?.id, workType, serviceType, onSiteSubtype])

  // ---- #1 PIC roster: seed from the linked rental agreement ----
  // When a manned-trailer ticket links to a rental, pull that agreement's
  // current PIC roster from Dexie so the tech sees who's already on the job and
  // can add forepersons. Merge (not clobber) with anything restored from a
  // draft. Seeds once per linked rental.
  useEffect(() => {
    if (!linkedRentalId) { setPicsSeededFor(null); setLinkedSiteContact(null); return }
    if (picsSeededFor === linkedRentalId) return
    let cancelled = false
    ;(async () => {
      try {
        const agreement = await db.rentalAgreements.get(linkedRentalId)
        const existing = Array.isArray(agreement?.pics) ? agreement!.pics! : []
        if (cancelled) return
        setRentalPics(prev => {
          const byId = new Map<string, RentalPic>()
          for (const p of existing) if (p?.id) byId.set(p.id, p)
          for (const p of prev) if (p?.id) byId.set(p.id, p) // draft-restored wins
          return Array.from(byId.values())
        })
        // On-site contact — read-only carry-through from the rental so the tech
        // on the manned trailer can call down without leaving the ticket.
        const name = (agreement?.siteContactName || '').trim()
        const phone = (agreement?.siteContactPhone || '').trim()
        const email = (agreement?.siteContactEmail || '').trim()
        setLinkedSiteContact((name || phone || email) ? { name, phone, email } : null)
      } finally {
        if (!cancelled) setPicsSeededFor(linkedRentalId)
      }
    })()
    return () => { cancelled = true }
  }, [linkedRentalId, picsSeededFor])

  // ---- #3 Billing refs: load the customer's labels + active profile seed ----
  useEffect(() => {
    if (!customer?.id) { setBillingLabels({}); setBillingProfilesSeed([]); setCustomerCashCcOnly(false); setCustomerCreditHold(false); return }
    let cancelled = false
    ;(async () => {
      const c = await db.companies.get(customer.id!)
      if (cancelled || !c) {
        // Fall back to whatever the picker handed us when offline cache misses.
        if (!cancelled) {
          setCustomerCashCcOnly(!!customer.cashCcOnly)
          setCustomerCreditHold(!!customer.creditHold)
        }
        return
      }
      setBillingLabels({ po: c.poLabel, afe: c.afeLabel, costCode: c.costCenterLabel })
      setBillingProfilesSeed(c.billingProfilesSeed || [])
      setCustomerCashCcOnly(!!c.cashCcOnly || !!customer.cashCcOnly)
      setCustomerCreditHold(!!c.creditHold || !!customer.creditHold)
    })()
    return () => { cancelled = true }
  }, [customer?.id])

  // ---- #3 Seed billing-ref row 1 from the customer's billing profile ----
  // requiresPo → a required PO row; requiresAfe → a required AFE row; else one
  // optional row (pre-filled from a default if any). Seeds once, only after the
  // draft-restore pass, and never in edit mode (edit hydrates from the ticket).
  useEffect(() => {
    if (isEditMode || !draftRestored || billingRefsSeeded) return
    if (!customer?.id) return
    if (billingRefs.length > 0) { setBillingRefsSeeded(true); return }
    const profile = selectBillingProfileSeed(billingProfilesSeed, {
      ticketType: activeConfig?.ticketType || workType,
      division,
    })
    const seeded: BillingRef[] = []
    if (profile?.requiresPo) seeded.push({ id: uuidv4(), type: 'po', value: profile.defaultPoNumber || '', required: true })
    if (profile?.requiresAfe) seeded.push({ id: uuidv4(), type: 'afe', value: profile.defaultAfeNumber || '', required: true })
    if (seeded.length === 0) {
      seeded.push({ id: uuidv4(), type: 'po', value: profile?.defaultPoNumber || '', required: false })
    }
    setBillingRefs(seeded)
    setBillingRefsSeeded(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftRestored, billingProfilesSeed, customer?.id, isEditMode])

  // ---- #3 Keep poNumber synced to the first PO row (display + back-compat) ----
  useEffect(() => {
    if (!billingRefsSeeded && billingRefs.length === 0) return
    const po = billingRefs.find(r => r.type === 'po' && r.value.trim())
    setPoNumber(po ? po.value : '')
  }, [billingRefs, billingRefsSeeded])

  // ---- Air Fill: keep the PSI service line in sync with the readings ----
  // Air fill owns ONE 'service' line whose description tracks the PSI readings.
  // The billable labor + mileage lines live alongside it (seeded below + editable
  // on the af_line_items step), so we insert/update the service line by its
  // lineType marker instead of collapsing the whole list to a single row.
  useEffect(() => {
    if (workType !== 'air_fill') return
    const psiNote = airFillArrivePsi && airFillDepartPsi
      ? ` (${airFillArrivePsi} → ${airFillDepartPsi} PSI)`
      : ''
    const desc = `Breathing Air Fill${airFillLocationText ? ` — ${airFillLocationText}` : ''}${psiNote}`
    setLineItems(prev => {
      const idx = prev.findIndex(li => li.lineType === 'service')
      if (idx === -1) {
        return [{ id: uuidv4(), lineType: 'service', description: desc, quantity: 1 }, ...prev]
      }
      const next = [...prev]
      next[idx] = { ...next[idx], description: desc }
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workType, airFillArrivePsi, airFillDepartPsi, airFillLocationText])

  // ---- Auto-populate default line items when service type is chosen ----
  useEffect(() => {
    // Only for new tickets (not edits), only when service type just changed.
    if (isEditMode) return
    if (!serviceType) return
    // On-Site Services can't seed until the subtype is settled — what gets
    // billed differs per subtype, and a manned-trailer day bills nothing at
    // all: the shift is already inside the rental package. Parts and labor
    // stay available for genuinely out-of-scope work, just not pre-filled.
    if (serviceType === 'on_site_services') {
      if (!onSiteSubtype) return
      if (onSiteSubtype === 'manned_trailer') return
    }
    // Leave the list alone once the tech (or a draft/template restore) has added
    // real billing lines. Air fill's own PSI line has lineType 'service' and does
    // NOT count as a real billing line — we still want labor + mileage seeded
    // alongside it, so it's excluded from this guard.
    if (lineItems.some(li => li.lineType !== 'service')) return

    let cancelled = false
    getDefaultLineItems(serviceType, pickerDivision, priceLevels).then(defaults => {
      if (cancelled || defaults.length === 0) return
      setLineItems(prev => {
        // Double-fire / async-race guard: never duplicate labor or mileage.
        if (prev.some(li => li.lineType === 'labor' || li.lineType === 'travel')) return prev
        // Preserve any existing line (e.g. air fill's PSI service line); append.
        return [...prev, ...defaults]
      })
    })
    return () => { cancelled = true }
  // priceLevels is deliberately NOT a dependency: seeding must not re-run when
  // the pricebook lands. LineItemEditor's own reprice pass fixes up rates that
  // were seeded before the customer's levels loaded.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceType, onSiteSubtype])

  // ---- #5 Rental deploy fulfillment ----
  // The composition (set at dispatch) defines the priced lines. At deploy the
  // checklist compares scanned serials against the spec per gas-monitor line
  // (product-matched). A mismatch — under OR over — soft-gates Next with a
  // confirm rather than blocking: field reality wins, but on purpose.
  // Trailer/other are shown as a reminder only (often non-serialized).
  const deployRental = workType === 'rental'
    ? (startJobCandidates.find(r => r.id === selectedStartJobRentalId) || null)
    : null
  const deployComposition: RentalComposition | null = deployRental?.composition || null
  // Price extras in the AGREEMENT's unit, not the wizard's field — dispatch set
  // it, and a mismatch here would bill a weekly rate as a daily one.
  const deployRateType = (deployRental?.billingRateType === 'weekly' || deployRental?.billingRateType === 'monthly'
    ? deployRental.billingRateType
    : 'daily') as 'daily' | 'weekly' | 'monthly'
  const deployItemCategory = (productId?: string | null) =>
    (productId ? deployProductsById.get(productId)?.category : null) ?? null
  const deployMonitorConsumed = new Map<string, number>()
  const deployMonitorLines = (deployComposition?.gasMonitors || [])
    .filter(g => g.productId && (g.qty || 1) > 0)
    .map((g, _idx, specs) => {
      const qty = g.qty || 1
      const category = deployItemCategory(g.productId)
      const matchKey = category ? `cat:${category}` : `product:${g.productId}`
      const totalScanned = rentalItems.filter(it => {
        if (category) return deployItemCategory(it.productId) === category
        return it.productId === g.productId
      }).length
      const duplicateSpecCount = specs.filter(s => {
        const specCategory = deployItemCategory(s.productId)
        const specKey = specCategory ? `cat:${specCategory}` : `product:${s.productId}`
        return specKey === matchKey
      }).length
      const alreadyConsumed = deployMonitorConsumed.get(matchKey) || 0
      const remainingScanned = Math.max(0, totalScanned - alreadyConsumed)
      const displayScanned = duplicateSpecCount > 1 ? Math.min(remainingScanned, qty) : totalScanned
      deployMonitorConsumed.set(matchKey, alreadyConsumed + displayScanned)
      return {
        id: g.id,
        productId: g.productId,
        label: g.productName || 'Gas Monitor',
        qty,
        scanned: displayScanned,
        met: displayScanned === qty,
      }
    })
  const deployMonitorsMet = deployMonitorLines.every(l => l.met)

  // ---- Package baseline diff ----
  // The customer's package says what a job is supposed to deploy; the scanned
  // serials say what actually is. Both resolve to the same axis — the BOM row
  // carries an equipment category, and a serial's product has one — so the
  // comparison is a group-by-category count.
  //
  // Over baseline bills: the package covers its contents, the 5th of 4 monitors
  // doesn't. Short of baseline does NOT credit — the package bills whole — but
  // it's still shown, because a tech leaving gear behind is worth catching on
  // site rather than in a billing dispute three weeks later.
  const deployBaseline = deployComposition?.bom || []
  // Gear dispatch already put on its OWN priced line (a gas-monitor or other
  // spec) is spoken for. Without this, a monitor ordered as a separate line
  // would also read as over-baseline and bill a second time.
  const deployAlreadyLined = new Map<string, number>()
  for (const spec of [...(deployComposition?.gasMonitors || []), ...(deployComposition?.other || [])]) {
    const cat = deployItemCategory(spec.productId)
    if (!cat) continue
    deployAlreadyLined.set(cat, (deployAlreadyLined.get(cat) || 0) + (spec.qty || 1))
  }
  const deployedForDiff = netAlreadyLined(
    rentalItems.map(it => deployItemCategory(it.productId)),
    deployAlreadyLined,
  )

  const deployDiffRows = deployBaseline.length
    ? diffDeployedAgainstBaseline(deployBaseline, deployedForDiff)
    : []
  const deployOverRows = deployDiffRows.filter(r => r.over > 0)
  const deployShortRows = deployDiffRows.filter(r => r.short > 0)

  // Over-baseline gear, priced from the product AR bound to that baseline row.
  // An unbound row still produces a line — AR needs to see the extra went out —
  // it just arrives unrated, and the invoice guard refuses to bill blind.
  const deployExtras: RentalBomExtraSpec[] = deployOverRows.map(r => {
    const prod = r.productId ? deployProductsById.get(r.productId) : undefined
    return {
      id: `bomx-${r.equipmentCategory}`,
      label: `${prod?.name || r.label} (over baseline)`,
      equipmentCategory: r.equipmentCategory,
      productId: r.productId,
      qty: r.over,
      rate: productRateFor(prod, deployRateType),
    }
  })

  // Resolve the products behind the baseline rows and the scanned serials, so
  // the diff has a category for each and an over-baseline extra can be priced.
  // Dexie-first — the field is often offline. Declared after the derived consts
  // above because it depends on them.
  useEffect(() => {
    if (workType !== 'rental') return
    const ids = Array.from(new Set([
      ...rentalItems.map(i => i.productId),
      ...(deployComposition?.bom || []).map(b => b.productId),
      // Needed to net separately-lined gear out of the baseline comparison.
      ...(deployComposition?.gasMonitors || []).map(g => g.productId),
      ...(deployComposition?.other || []).map(o => o.productId),
    ].filter(Boolean) as string[]))
    // Chase whatever isn't resolved yet. Deliberately keyed on HITS, not
    // attempts: a product Dexie hasn't synced yet must be retried, or its
    // overage would read "rate TBD" for the rest of the session even after the
    // data lands. Safe from looping — this effect only re-runs when the scanned
    // items or the composition change, not when the resolved map does.
    const wanted = ids.filter(id => !deployProductsById.has(id))
    if (wanted.length === 0) return
    let cancelled = false
    ;(async () => {
      const rows = await db.products.where('id').anyOf(wanted).toArray()
      if (cancelled || rows.length === 0) return
      setDeployProductsById(prev => {
        const next = new Map(prev)
        for (const r of rows) {
          next.set(r.id, {
            id: r.id,
            name: r.name,
            partNumber: r.partNumber,
            category: r.category,
            defaultRentalRateDaily: r.defaultRentalRateDaily,
            defaultRentalRateWeekly: r.defaultRentalRateWeekly,
            defaultRentalRateMonthly: r.defaultRentalRateMonthly,
            defaultSellPrice: r.defaultSellPrice,
          })
        }
        return next
      })
    })()
    return () => { cancelled = true }
  }, [workType, rentalItems, deployComposition])

  /** Confirm a deliberate over/under-deploy against the dispatch order. */
  function confirmDeployMismatch(): boolean {
    const off = deployMonitorLines.filter(l => !l.met)
    const ordered = off.map(l =>
      `• ${l.label}: ${l.scanned} scanned, ${l.qty} ordered (${l.scanned < l.qty ? `${l.qty - l.scanned} short` : `${l.scanned - l.qty} extra`})`
    )
    const short = deployShortRows.map(r =>
      `• ${r.label}: ${r.deployed} of ${r.expected} in the package (${r.short} short)`
    )
    const over = deployOverRows.map(r =>
      `• ${r.label}: ${r.deployed} out, package covers ${r.expected} — ${r.over} extra will bill`
    )
    if (!ordered.length && !short.length && !over.length) return true
    const sections = [
      ordered.length ? `Doesn't match the dispatch order:\n${ordered.join('\n')}` : '',
      short.length ? `Short of the package baseline:\n${short.join('\n')}` : '',
      over.length ? `Over the package baseline:\n${over.join('\n')}` : '',
    ].filter(Boolean).join('\n\n')
    return confirm(`${sections}\n\nDeploy anyway?`)
  }
  // True when dispatch priced the composition → billing comes from those lines,
  // so per-item rates here are tracking-only (not billed). $0 is a real rate
  // (deliberately free line) — mirrors server hasRate(), only null = unpriced.
  const deployPriced = !!deployComposition && [
    deployComposition.trailer?.rate,
    ...(deployComposition.gasMonitors || []).map(g => g.rate),
    ...(deployComposition.other || []).map(o => o.rate),
    ...(deployComposition.bom || []).map(b => b.rate),
    deployComposition.bomPackage?.rate,
    ...(deployComposition.bomExtras || []).map(e => e.rate),
  ].some(r => typeof r === 'number')

  // Pure Cascade Air inspection captures everything in the inspection editor,
  // so the standard line-item editor is hidden on this step (see render below).
  // Both the gate and the render read this flag so they can't drift apart.
  const cascadeInspectionOnly = serviceType === 'cascade_air' &&
    cascadeAirSubtypes.size === 1 && cascadeAirSubtypes.has('inspection')

  // A pure Cascade inspection hides the line-item editor, so the tech has no
  // field to describe the seeded labor line in — yet submit AND supervisor
  // approval both require one. The inspection records already say what was
  // done, so derive the description from them. Only fills a blank note; never
  // overwrites text a human typed.
  useEffect(() => {
    if (!cascadeInspectionOnly) return
    if (airSystemRecords.length === 0) return
    const names = airSystemRecords.map(r => r.workPointName?.trim()).filter(Boolean) as string[]
    const list = names.join(', ')
    const count = `${airSystemRecords.length} system${airSystemRecords.length === 1 ? '' : 's'}`
    // Keep it short enough for a QB line memo — fall back to a count when the
    // site has a long list of systems.
    const detail = list && list.length <= 120 ? list : count
    const summary = `${DERIVED_NOTE_PREFIX}${detail}`
    // Refresh our own derived text (systems get added/renamed as the tech
    // works) but leave anything a human typed alone.
    const ours = (n?: string | null) => !n?.trim() || n.startsWith(DERIVED_NOTE_PREFIX)
    if (!lineItems.some(li => isLaborRatePart(li.partNumber) && ours(li.notes) && li.notes !== summary)) return
    setLineItems(prev => prev.map(li =>
      isLaborRatePart(li.partNumber) && ours(li.notes) ? { ...li, notes: summary } : li,
    ))
  }, [cascadeInspectionOnly, airSystemRecords, lineItems])

  // ---- Validation ----

  // Why the field-service line-items step can't advance yet — null when it can.
  // Doubles as the gate and as the hint beside a disabled Next, so the step says
  // what's missing instead of greying out with no explanation.
  function lineItemsBlocker(): string | null {
    const serviceBlocker = serviceLineItemsBlocker()
    if (serviceBlocker) return serviceBlocker
    // Labor-rate lines (legacy 406 or new-scheme [DIV]00002) must describe the
    // work done before advancing (required, not optional). Checked last so the
    // service's own "you still owe me an inspection" message wins first.
    if (lineItems.some(li => isLaborRatePart(li.partNumber) && !li.notes?.trim()))
      return 'Add notes to the labor line describing the work performed.'
    return null
  }

  /** The selected service's own required fields — null when they're satisfied. */
  function serviceLineItemsBlocker(): string | null {
    if (serviceType === 'cascade_air') {
      if (cascadeAirSubtypes.size === 0) return 'Pick at least one Cascade Air service.'
      // New Install is exclusive — its own field set is the only check.
      if (cascadeAirSubtypes.has('new_install')) {
        const namedSystems = cleanNewInstallSystems()
        if (namedSystems.length === 0) return 'Name at least one new system.'
        const partiallyFilled = newInstallSystems.some(system =>
          !system.workPointName.trim() && (
            system.reelSerialNumber.trim() ||
            system.standSerialNumber.trim() ||
            system.regulatorSerial.trim() ||
            system.installDescription.trim() ||
            system.cylinders.some(c => c.serialNumber.trim() || c.hydroDate || c.expiryDate)
          )
        )
        if (partiallyFilled) return 'Name every new system, or remove the blank one.'
        if (lineItems.length === 0) return 'Add at least one line item.'
        return null
      }
      // Otherwise every selected subtype must have its required fields filled.
      if (cascadeAirSubtypes.has('inspection') && airSystemRecords.length === 0)
        return 'Add at least one air system to inspect.'
      if (cascadeAirSubtypes.has('air_fill') && (!airFillArrivePsi || !airFillDepartPsi || !cascadeAirCylinderSerial.trim()))
        return 'On-site Fill needs start PSI, end PSI, and the cylinder serial.'
      if (cascadeAirSubtypes.has('other_repair') && !cascadeAirOtherDescription.trim())
        return 'Describe the repair.'
      return null
    }
    if (serviceType === 'gas_detection') {
      if (gasDetectionRecords.length === 0) return 'Add at least one monitor.'
      if (!gasDetectionRecords.every(isGasDetectionRecordComplete))
        return 'Finish every monitor — one is still marked incomplete.'
      return null
    }
    if (serviceType === 'inspection')
      return inspectionRecords.length === 0 ? 'Add at least one inspection.' : null
    if (serviceType === 'on_site_services') {
      if (onSiteSubtype === 'other') {
        if (!onSiteOtherDescription.trim()) return 'Describe the work performed.'
        if (lineItems.length === 0) return 'Add at least one line item.'
        return null
      }
      if (onSiteSubtype === 'confined_space' || onSiteSubtype === 'manned_trailer' || onSiteSubtype === 'bottle_watch') {
        if (onSiteEntries.length === 0) return 'Log at least one entry.'
        return null
      }
      return 'Pick an On-Site service on the first step.'
    }
    return lineItems.length === 0 ? 'Add at least one line item.' : null
  }

  function d3CombinedBlocker(): string | null {
    if (d3CombinedServices.size === 0) return 'Pick at least one D3 service.'
    if (d3HasAir) {
      if (cascadeAirSubtypes.size === 0) return 'Pick at least one Air System service.'
      if (cascadeAirSubtypes.has('new_install')) return 'Air System New Install must be a separate ticket.'
      if (cascadeAirSubtypes.has('inspection') && airSystemRecords.length === 0) return 'Add at least one air system inspection.'
      if (cascadeAirSubtypes.has('air_fill') && (!airFillArrivePsi || !airFillDepartPsi || !cascadeAirCylinderSerial.trim()))
        return 'Air Fill needs start PSI, end PSI, and cylinder serial.'
      if (cascadeAirSubtypes.has('other_repair') && !cascadeAirOtherDescription.trim()) return 'Describe the air repair.'
    }
    if (d3HasGas) {
      if (!gasDetectionFixed && !gasDetectionArea) return 'Pick Fixed, Area, or both for Gas Detection.'
      if (gasDetectionRecords.length === 0) return 'Add at least one gas detection monitor.'
      if (!gasDetectionRecords.every(isGasDetectionRecordComplete)) return 'Finish every gas detection monitor.'
    }
    if (d3HasIh) {
      if (selectedIhSubtypes.length === 0) return 'Pick at least one IH test type.'
      if (ihTestRecords.length === 0) return 'Add at least one IH record.'
      if (!selectedIhSubtypes.every(st => ihTestRecords.some(r => r.testType === st))) return 'Each selected IH test type needs a record.'
    }
    if (lineItems.some(li => isLaborRatePart(li.partNumber) && !li.notes?.trim()))
      return 'Add notes to the labor line describing the work performed.'
    return null
  }

  function whoWhereBlocker(): string | null {
    if (!customer) return 'Select a customer.'
    if (!location.pad && location.wells.length === 0) return 'Select a site or well.'
    if (!division) return 'Select a charge path.'
    if (workType === 'd3_combined') return null
    if (!serviceType) return 'Select a service.'
    if (serviceType === 'gas_detection' && !gasDetectionFixed && !gasDetectionArea) return 'Pick Fixed, Area, or both for Gas Detection.'
    if (serviceType === 'cascade_air' && cascadeAirSubtypes.size === 0) return 'Pick at least one Cascade Air service.'
    if (serviceType === 'on_site_services' && !onSiteSubtype) return 'Pick an On-Site service.'
    return null
  }

  function canAdvance(): boolean {
    if (!currentStepId) return false
    switch (currentStepId) {
      case 'd3_services':
        if (d3CombinedServices.size === 0) return false
        if (d3HasAir && (cascadeAirSubtypes.size === 0 || cascadeAirSubtypes.has('new_install'))) return false
        if (d3HasGas && !gasDetectionFixed && !gasDetectionArea) return false
        if (d3HasIh && selectedIhSubtypes.length === 0) return false
        return true
      // Field service
      case 'who_where':
        // A well with no pad is a complete location (wells are first-class;
        // Pad is only an optional grouping), so require *a* location, not a pad.
        return whoWhereBlocker() === null
      case 'line_items': return workType === 'd3_combined' ? d3CombinedBlocker() === null : lineItemsBlocker() === null
      case 'wrap_up': return true
      // Air fill
      case 'af_customer': return !!customer
      case 'af_confirm': return !!airFillArrivePsi && !!airFillDepartPsi
      case 'af_line_items': return true
      case 'af_wrap_up': return true
      // Occ Health (internally still fit_test)
      case 'ft_setup': return !!customer && occServices.size > 0
      // #10/#14 per-person completeness: name + service rules (Full Face needs
      // APR/SAR, SAR needs a fit factor, audiometric needs Baseline/Retest).
      case 'ft_records': return fitTestRecords.length > 0 && fitTestRecords.every(occRecordComplete)
      case 'ft_line_items': return true
      case 'ft_wrap_up': return true
      // IH testing
      case 'ih_setup': return !!customer && ihSubtypes.size > 0
      // Every selected test type needs at least one record — selecting a type
      // is a claim that the work was done; don't let it submit empty.
      case 'ih_records':
        return ihTestRecords.length > 0 &&
          selectedIhSubtypes.every(st => ihTestRecords.some(r => r.testType === st))
      case 'ih_line_items': return true
      case 'ih_wrap_up': return true
      // Training
      case 'tr_setup': return !!customer && !!trainingCourseName
      case 'tr_roster': return trainingRosterRecords.length > 0 && trainingRosterRecords.every(r => r.employeeName.trim() !== '')
      case 'tr_line_items': return true
      case 'tr_wrap_up': return true
      // Rental
      case 'rn_setup': return !!customer && !!selectedStartJobRentalId
      // Mismatch vs the dispatch order soft-gates via confirm in goNext, not here.
      case 'rn_equipment': return rentalItems.length > 0 && (deployShortRows.length === 0 || deployShortReason.trim().length > 0)
      case 'rn_review': return true
      default: return false
    }
  }

  // ---- Payload builders ----

  function wellsDisplayLabel(): string {
    if (location.wells.length === 0) return ''
    if (location.wells.length === 1) return location.wells[0].wellName || ''
    return `${location.wells.length} wells`
  }

  // Location breadcrumb shared by the Dexie record and the sync payload. Air
  // fills happen at the shop, so their "location" is the truck/unit + driver.
  function locationBreadcrumb(): string {
    if (workType === 'air_fill') {
      return `${airFillLocationText || customer?.name || 'Air Fill'}${driverName ? ` — ${driverName}` : ''}`
    }
    return [location.pad?.name, wellsDisplayLabel()].filter(Boolean).join(' > ') || customer?.name || ''
  }

  function addFieldSiteContext(data: Record<string, any>) {
    if (showsSiteSignEvidence && (requiresSiteSignEvidence || siteSignPhotos.length > 0)) {
      const signPhoto = siteSignPhotos.find(p => p.latitude != null && p.longitude != null) ?? siteSignPhotos[0]
      data.siteSignEvidence = {
        required: requiresSiteSignEvidence,
        photoIds: siteSignPhotos.map(p => p.id),
        geotagged: siteSignGeotagged,
        latitude: signPhoto?.latitude ?? null,
        longitude: signPhoto?.longitude ?? null,
        accuracy: signPhoto?.accuracy ?? null,
        capturedAt: signPhoto?.timestamp ?? null,
      }
    }
    if (customerLocationMismatch && selectedLocationOwner) {
      data.customerLocationMismatch = {
        status: 'pending',
        selectedCustomerId: customer?.id,
        selectedCustomerName: customer?.name,
        currentOperatorId: selectedLocationOwner.id,
        currentOperatorName: selectedLocationOwner.name,
        source: selectedLocationOwner.source,
        locationId: selectedLocationOwner.locationId,
      }
    }
    return data
  }

  function buildTicketPayload() {
    const resolvedTicketType = activeConfig?.ticketType || 'field_service'
    const resolvedSubtype = workType === 'ih_testing'
      ? (ihSubtype || undefined)
      : (activeConfig?.serviceSubtype || serviceType || undefined)
    const wellIds = location.wells.map(w => w.id)
    return {
      companyId: customer?.id,
      fieldId: location.field?.id || undefined,
      padId: location.pad?.id || undefined,
      // Primary well for the FK (first selected)
      wellId: wellIds[0] || undefined,
      rigPresent: rigPresent || undefined,
      presentRigId: rigPresent ? (presentRig?.id || undefined) : undefined,
      // Send the breadcrumb the local Dexie record already carries — the server
      // rebuilds it from the location FKs when it's missing, but air-fill
      // tickets have no FKs and their truck/driver label only exists here.
      locationDisplay: locationBreadcrumb() || undefined,
      // The local Dexie record has always carried assignedTechId, but this
      // payload didn't — so a wizard-created ticket landed on the server with a
      // NULL assignment, dropped out of the field tech's own "My Jobs" filter,
      // and then got pruned off the device by the next delta sync (the prune
      // list is scoped by assignedTechId for field_tech). Only on create: on an
      // edit this object is spread straight into prisma.update, so sending it
      // would reassign the ticket to whoever opened it.
      assignedTechId: isEditMode ? undefined : (user?.id || undefined),
      ticketType: resolvedTicketType,
      serviceSubtype: resolvedSubtype,
      serviceDate,
      poNumber: poNumber || undefined,
      // #3 send the structured refs; the server derives flat po/afe/cost from them.
      billingRefs: billingRefs.filter(r => r.value.trim() || r.required).length > 0
        ? billingRefs.filter(r => r.value.trim() || r.required)
        : undefined,
      division: division || undefined,
      isDickinson: isDickinson || undefined,
      linkedRentalAgreementId: linkedRentalId || undefined,
      dispatchNotes: dispatchNotes || undefined,
      workDescription: workNotes || undefined,
      arrivalTime: arrivedAt || undefined,
      departureTime: departedAt || undefined,
      // All selected wells in customData for billing + training course metadata
      customData: (() => {
        const data: any = {}
        if (wellIds.length > 1) data.wellIds = wellIds
        if (workType === 'training') {
          data.courseName = trainingCourseName
          if (trainingCourseOther) data.courseOther = trainingCourseOther
          if (trainingTrainerName) data.trainerName = trainingTrainerName
          data.isOnSite = trainingIsOnSite
          if (trainingLocationText) data.locationText = trainingLocationText
          if (trainingLocation?.id) data.cpLocationId = trainingLocation.id
          // #12 on-site mileage → billed as a mileage line at invoice gen
          if (trainingIsOnSite && parseFloat(trainingMileage) > 0) data.mileage = parseFloat(trainingMileage)
        }
        // #10 Occ Health: services + in-house/on-site + mileage
        if (workType === 'fit_test') {
          data.occServices = occServicesArr
          data.isOnSite = occOnSite
          if (occOnSite && parseFloat(occMileage) > 0) data.mileage = parseFloat(occMileage)
        }
        if (isCallOut) {
          data.isCallOut = true
        }
        // #8 full IH multi-selection; serviceSubtype carries only the first.
        if (workType === 'ih_testing' && selectedIhSubtypes.length > 0) {
          data.ihSubtypes = selectedIhSubtypes
        }
        if (workType === 'd3_combined') {
          data.d3CombinedServices = d3CombinedServicesArr
          data.isCombinedVisit = true
        }
        if (serviceType === 'gas_detection' || d3HasGas) {
          if (gasDetectionFixed) data.gasDetectionFixed = true
          if (gasDetectionArea) data.gasDetectionArea = true
        }
        if (d3HasIh && selectedIhSubtypes.length > 0) {
          data.ihSubtypes = selectedIhSubtypes
        }
        if ((serviceType === 'cascade_air' || d3HasAir) && cascadeAirSubtypes.size > 0) {
          data.cascadeAirSubtypes = Array.from(cascadeAirSubtypes)
          // Legacy single-value field kept for any consumer not yet updated.
          data.cascadeAirSubtype = data.cascadeAirSubtypes[0]
          if (cascadeAirSubtypes.has('air_fill')) {
            if (airFillArrivePsi) data.arrivePsi = airFillArrivePsi
            if (airFillDepartPsi) data.departPsi = airFillDepartPsi
            if (cascadeAirCylinderSerial) data.cylinderSerial = cascadeAirCylinderSerial
          }
          if (cascadeAirSubtypes.has('new_install')) {
            // Server-side: a sync hook reads customData.newInstalls and mints
            // WorkPoints at the ticket's location, then links the ticket to the
            // first one for legacy ticket.workPointId consumers.
            const installs = cleanNewInstallSystems()
            if (installs.length > 0) {
              data.newInstalls = installs
              data.newInstall = installs[0]
              if (installs[0].installDescription) data.installDescription = installs[0].installDescription
            }
          }
          if (cascadeAirSubtypes.has('other_repair') && cascadeAirOtherDescription) {
            data.repairDescription = cascadeAirOtherDescription
          }
        }
        if (serviceType === 'on_site_services' && onSiteSubtype) {
          data.onSiteSubtype = onSiteSubtype
          if (onSiteSubtype === 'other') {
            if (onSiteOtherDescription) data.onSiteDescription = onSiteOtherDescription
          } else {
            data.onSiteLog = {
              shiftStart: onSiteShiftWindow?.start,
              shiftEnd: onSiteShiftWindow?.end,
              siteTimesManual: { ...siteTimesManual },
              entries: onSiteEntries,
            }
          }
          // #1 PIC roster — top-level so the sync hook mirrors it onto the
          // linked rental agreement. Drop blank rows.
          if (onSiteSubtype === 'manned_trailer') {
            const cleanPics = rentalPics.filter(p => p.name.trim())
            if (cleanPics.length > 0) data.pics = cleanPics
          }
        }
        if (workType === 'air_fill') {
          if (airFillLocationText) data.truckUnit = airFillLocationText
          if (driverName) data.driverName = driverName
          if (airFillArrivePsi) data.arrivePsi = airFillArrivePsi
          if (airFillDepartPsi) data.departPsi = airFillDepartPsi
        }
        addFieldSiteContext(data)
        return Object.keys(data).length > 0 ? data : undefined
      })(),
    }
  }

  function buildTicketRecord(status: string, now: string) {
    const resolvedTicketType = activeConfig?.ticketType || 'field_service'
    const resolvedSubtype = workType === 'ih_testing'
      ? (ihSubtype || null)
      : (activeConfig?.serviceSubtype || serviceType || null)
    const wellIds = location.wells.map(w => w.id)
    return {
      id: offlineId,
      offlineId,
      ticketNumber: null,
      ticketType: resolvedTicketType,
      serviceSubtype: resolvedSubtype,
      status,
      companyId: customer?.id || '',
      fieldId: location.field?.id || null,
      padId: location.pad?.id || null,
      wellId: wellIds[0] || null,
      facilityId: null,
      workPointId: null,
      rigPresent,
      presentRigId: rigPresent ? (presentRig?.id || null) : null,
      locationDisplay: locationBreadcrumb(),
      assignedTechId: user?.id || null,
      serviceDate,
      arrivalTime: arrivedAt,
      departureTime: departedAt,
      // #3 derive flat afe/po/cost from the structured refs for the local Dexie
      // record (display); the server re-derives authoritatively on sync.
      afeNumber: billingRefs.find(r => r.type === 'afe' && r.value.trim())?.value || null,
      poNumber: billingRefs.find(r => r.type === 'po' && r.value.trim())?.value || poNumber || null,
      costCenter: billingRefs.find(r => r.type === 'cost_code' && r.value.trim())?.value || null,
      billingRefs: billingRefs.filter(r => r.value.trim() || r.required),
      division: division || null,
      isDickinson,
      linkedRentalAgreementId: linkedRentalId || null,
      customerRepName: null,
      // Attach the signature for any non-draft state (supervisor_review
      // and completed both represent a finalized ticket).
      customerRepSignature: status !== 'draft' ? signature : null,
      techSignature: null,
      dispatchNotes: dispatchNotes || null,
      workDescription: workNotes || null,
      internalNotes: null,
      customData: (() => {
        const data: any = {}
        const wellIds = location.wells.map(w => w.id)
        if (wellIds.length > 1) data.wellIds = wellIds
        if (workType === 'training') {
          data.courseName = trainingCourseName
          if (trainingCourseOther) data.courseOther = trainingCourseOther
          if (trainingTrainerName) data.trainerName = trainingTrainerName
          data.isOnSite = trainingIsOnSite
          if (trainingLocationText) data.locationText = trainingLocationText
          if (trainingLocation?.id) data.cpLocationId = trainingLocation.id
          // #12 on-site mileage → billed as a mileage line at invoice gen
          if (trainingIsOnSite && parseFloat(trainingMileage) > 0) data.mileage = parseFloat(trainingMileage)
        }
        // #10 Occ Health: services + in-house/on-site + mileage
        if (workType === 'fit_test') {
          data.occServices = occServicesArr
          data.isOnSite = occOnSite
          if (occOnSite && parseFloat(occMileage) > 0) data.mileage = parseFloat(occMileage)
        }
        if (isCallOut) data.isCallOut = true
        if (workType === 'd3_combined') {
          data.d3CombinedServices = d3CombinedServicesArr
          data.isCombinedVisit = true
        }
        if (serviceType === 'gas_detection' || d3HasGas) {
          if (gasDetectionFixed) data.gasDetectionFixed = true
          if (gasDetectionArea) data.gasDetectionArea = true
        }
        if (d3HasIh && selectedIhSubtypes.length > 0) {
          data.ihSubtypes = selectedIhSubtypes
        }
        if ((serviceType === 'cascade_air' || d3HasAir) && cascadeAirSubtypes.size > 0) {
          data.cascadeAirSubtypes = Array.from(cascadeAirSubtypes)
          // Legacy single-value field kept for any consumer not yet updated.
          data.cascadeAirSubtype = data.cascadeAirSubtypes[0]
          if (cascadeAirSubtypes.has('air_fill')) {
            if (airFillArrivePsi) data.arrivePsi = airFillArrivePsi
            if (airFillDepartPsi) data.departPsi = airFillDepartPsi
            if (cascadeAirCylinderSerial) data.cylinderSerial = cascadeAirCylinderSerial
          }
          if (cascadeAirSubtypes.has('new_install')) {
            // Server-side: a sync hook reads customData.newInstalls and mints
            // WorkPoints at the ticket's location, then links the ticket to the
            // first one for legacy ticket.workPointId consumers.
            const installs = cleanNewInstallSystems()
            if (installs.length > 0) {
              data.newInstalls = installs
              data.newInstall = installs[0]
              if (installs[0].installDescription) data.installDescription = installs[0].installDescription
            }
          }
          if (cascadeAirSubtypes.has('other_repair') && cascadeAirOtherDescription) {
            data.repairDescription = cascadeAirOtherDescription
          }
        }
        if (serviceType === 'on_site_services' && onSiteSubtype) {
          data.onSiteSubtype = onSiteSubtype
          if (onSiteSubtype === 'other') {
            if (onSiteOtherDescription) data.onSiteDescription = onSiteOtherDescription
          } else {
            data.onSiteLog = {
              shiftStart: onSiteShiftWindow?.start,
              shiftEnd: onSiteShiftWindow?.end,
              siteTimesManual: { ...siteTimesManual },
              entries: onSiteEntries,
            }
          }
          // #1 PIC roster — top-level so the sync hook mirrors it onto the
          // linked rental agreement. Drop blank rows.
          if (onSiteSubtype === 'manned_trailer') {
            const cleanPics = rentalPics.filter(p => p.name.trim())
            if (cleanPics.length > 0) data.pics = cleanPics
          }
        }
        if (workType === 'air_fill') {
          if (airFillLocationText) data.truckUnit = airFillLocationText
          if (driverName) data.driverName = driverName
          if (airFillArrivePsi) data.arrivePsi = airFillArrivePsi
          if (airFillDepartPsi) data.departPsi = airFillDepartPsi
        }
        addFieldSiteContext(data)
        return Object.keys(data).length > 0 ? data : null
      })(),
      offlineCreated: true,
      sourceTicketId: null,
      sourceType: 'self_created',
      createdAt: now,
      updatedAt: now,
      _offlineStatus: 'pending' as const,
    }
  }

  // ---- Save / Submit ----

  async function handleSaveDraft() {
    setSaving(true)
    setError('')
    try {
      const now = new Date().toISOString()
      await db.tickets.put(buildTicketRecord('draft', now))
      await db.mutationQueue.add({
        table: 'tickets',
        action: 'create',
        entityId: offlineId,
        offlineId,
        payload: { ...buildTicketPayload(), status: 'draft', offlineId },
        createdAt: now,
        status: 'pending',
        retryCount: 0,
      })
      await clearDraft()
      navigate('/my-jobs')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save draft'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  // Phase C: this no longer creates a rental — dispatch already did. It
  // attaches items to the chosen contract and flips status to 'active'.
  async function submitRentalAgreement() {
    if (!selectedStartJobRentalId) {
      setError('Pick a rental contract first.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const now = new Date().toISOString()
      const agreementId = selectedStartJobRentalId

      // 1. Update the local Dexie copy of the rental: status → 'active'.
      // What went out beyond the package baseline. Resolved here rather than at
      // dispatch because it isn't knowable until the tech has scanned — this is
      // the moment the 5th-of-4 monitor becomes a real charge.
      const bomExtras = deployExtras.length ? deployExtras : undefined
      const deploymentExceptions = deployShortRows.length > 0
        ? {
            shortReason: deployShortReason.trim(),
            shortRows: deployShortRows.map(r => ({
              equipmentCategory: r.equipmentCategory,
              label: r.label,
              expected: r.expected,
              deployed: r.deployed,
              short: r.short,
            })),
            recordedAt: now,
          }
        : undefined
      const compositionUpdate = deployComposition && (bomExtras || deploymentExceptions)
        ? { ...deployComposition, ...(bomExtras ? { bomExtras } : {}), ...(deploymentExceptions ? { deploymentExceptions } : {}) }
        : undefined

      const existing = await db.rentalAgreements.get(agreementId)
      if (existing) {
        await db.rentalAgreements.put({
          ...existing,
          status: 'active',
          ...(existing.composition && (bomExtras || deploymentExceptions)
            ? { composition: { ...existing.composition, ...(bomExtras ? { bomExtras } : {}), ...(deploymentExceptions ? { deploymentExceptions } : {}) } }
            : {}),
          updatedAt: now,
          _offlineStatus: 'pending',
        })
      }

      // 2. Save items to Dexie + mark equipment rented locally.
      for (const item of rentalItems) {
        await db.rentalAgreementItems.put({
          ...item,
          rentalAgreementId: agreementId,
          _offlineStatus: 'pending',
        })
        await db.equipment.update(item.serializedEquipmentId, {
          status: 'rented',
          currentRentalId: agreementId,
          currentCustomerId: customer?.id || null,
        })
      }

      // 3. Push update mutation for the rental — flip to active.
      await db.mutationQueue.add({
        table: 'rentalAgreements',
        action: 'update',
        entityId: agreementId,
        // Merge onto the dispatch-time composition rather than replacing it —
        // the package line and baseline roster are dispatch's to own.
        payload: {
          status: 'active',
          ...(compositionUpdate ? { composition: compositionUpdate } : {}),
        },
        createdAt: now,
        status: 'pending',
        retryCount: 0,
      })

      // 4. Push create mutations for items.
      for (const item of rentalItems) {
        await db.mutationQueue.add({
          table: 'rentalAgreementItems',
          action: 'create',
          entityId: item.id,
          payload: {
            rentalAgreementId: agreementId,
            productId: item.productId,
            serializedEquipmentId: item.serializedEquipmentId,
            rate: item.rate,
            rateType: item.rateType || rentalBillingRateType,
            deployedDate: serviceDate,
            status: 'deployed',
            deployInspection: item.deployInspection || undefined,
          },
          createdAt: now,
          status: 'pending',
          retryCount: 0,
        })
      }

      await clearDraft()
      navigate(`/rentals/${agreementId}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start rental job'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  async function submitTicket() {
    // Customer is mandatory — guard against a customer-less submit (e.g. an
    // offline edit-reopen that couldn't resolve the company). Surfaces a clear
    // error instead of silently saving a ticket with no customer.
    if (!customer) {
      setError('Customer is required — re-select the customer before submitting.')
      return
    }
    // Credit hold is a hard stop, not a warning — the banner has been on screen
    // since customer select, and the server rejects the create anyway.
    if (customerCreditHold) {
      setError(CREDIT_HOLD_MESSAGE)
      return
    }
    // Arrival + departure required before submit (systemwide rule).
    if (!arrivedAt || !departedAt) {
      setError('Arrival and departure times are required before submit.')
      return
    }
    if (requiresSiteSignEvidence && siteSignPhotos.length === 0) {
      setError('Site sign photo is required before submitting this field ticket.')
      return
    }
    if (requiresSiteSignEvidence && !siteSignGeotagged) {
      setError('Site sign photo must include GPS before submitting. Allow location access and capture the sign again.')
      return
    }
    // Labor-rate lines (legacy 406 or new-scheme [DIV]00002) must carry a
    // reason/description of work done.
    const missing406Reason = lineItems.filter(li => isLaborRatePart(li.partNumber) && !li.notes?.trim())
    if (missing406Reason.length > 0) {
      setError('Reason required on labor line(s) — describe work done in the line notes.')
      return
    }
    // #3 Required billing refs (customer-mandated PO/AFE) must be filled in.
    const missingRef = billingRefs.find(r => r.required && !r.value.trim())
    if (missingRef) {
      const lbl = missingRef.type === 'po' ? (billingLabels.po || 'PO')
        : missingRef.type === 'afe' ? (billingLabels.afe || 'AFE')
        : (billingLabels.costCode || 'Cost Code')
      setError(`${lbl} # is required for this customer.`)
      return
    }
    setSaving(true)
    setError('')
    try {
      const now = new Date().toISOString()
      const ticketId = offlineId

      // 1. Save ticket to Dexie. Status is supervisor_review so the
      //    TicketsPage reflects the Approvals-bound state even before sync.
      const ticketRecord = buildTicketRecord('supervisor_review', now)
      await db.tickets.put(ticketRecord)

      // 2. Save line items to Dexie (field service flow)
      for (let i = 0; i < lineItems.length; i++) {
        const item = lineItems[i]
        await db.ticketLineItems.put({
          id: item.id,
          ticketId,
          lineNumber: i + 1,
          lineType: item.lineType,
          productId: (item as any).productId || null,
          description: item.description,
          quantity: item.quantity,
          rate: item.rate ?? null,
          total: item.total ?? null,
          unitOfMeasure: item.unitOfMeasure || null,
          serialNumberInstalled: item.serialNumberInstalled || null,
          serialNumberRemoved: item.serialNumberRemoved || null,
          testResult: item.testResult || null,
          calGasLotNumber: item.calGasLotNumber || null,
          sortOrder: i,
          notes: item.notes || null,
          customData: priceLevelCustomData(item),
          updatedAt: now,
          _offlineStatus: 'pending',
        })
      }

      // 3. Save photos to Dexie
      for (const photo of photos) {
        await db.ticketAttachments.put({
          id: photo.id,
          ticketId,
          fileName: `${photo.id}.jpg`,
          fileType: 'photo',
          filePath: null,
          fileSizeBytes: null,
          mimeType: 'image/jpeg',
          offlineBlobId: photo.id,
          dataUrl: photo.dataUrl,
          uploadedAt: photo.timestamp,
          _offlineStatus: 'pending',
        })
      }
      for (const photo of siteSignPhotos) {
        await db.ticketAttachments.put({
          id: photo.id,
          ticketId,
          fileName: `${photo.id}.jpg`,
          fileType: 'photo',
          filePath: null,
          fileSizeBytes: null,
          mimeType: 'image/jpeg',
          offlineBlobId: photo.id,
          dataUrl: photo.dataUrl,
          uploadedAt: photo.timestamp,
          _offlineStatus: 'pending',
        })
      }

      // 4. Enqueue mutations — sync engine handles the server push
      //    Ticket mutation. Tickets land directly in supervisor_review so
      //    they flow into the Approvals dashboard without a separate
      //    "submit for review" button. The server runs the rules engine
      //    post-batch once line items are committed.
      await db.mutationQueue.add({
        table: 'tickets',
        action: 'create',
        entityId: ticketId,
        offlineId,
        payload: {
          ...buildTicketPayload(),
          status: 'supervisor_review',
          offlineId,
          customerRepSignature: signature || undefined,
        },
        createdAt: now,
        status: 'pending',
        retryCount: 0,
      })

      //    Line item mutations
      for (let i = 0; i < lineItems.length; i++) {
        const item = lineItems[i]
        await db.mutationQueue.add({
          table: 'ticketLineItems',
          action: 'create',
          entityId: item.id,
          payload: {
            ticketId,
            lineType: item.lineType,
            productId: (item as any).productId || undefined,
            description: item.description,
            quantity: item.quantity,
            rate: item.rate ?? undefined,
            total: item.total ?? undefined,
            unitOfMeasure: item.unitOfMeasure || undefined,
            sortOrder: i,
            serialNumberInstalled: item.serialNumberInstalled || undefined,
            serialNumberRemoved: item.serialNumberRemoved || undefined,
            testResult: item.testResult || undefined,
            calGasLotNumber: item.calGasLotNumber || undefined,
            notes: item.notes || undefined,
            customData: priceLevelCustomData(item),
          },
          createdAt: now,
          status: 'pending',
          retryCount: 0,
        })
      }

      //    Photo/attachment mutations
      for (const photo of photos) {
        await db.mutationQueue.add({
          table: 'ticketAttachments',
          action: 'create',
          entityId: photo.id,
          payload: {
            ticketId,
            fileName: `${photo.id}.jpg`,
            fileType: 'photo',
            mimeType: 'image/jpeg',
            offlineBlobId: photo.id,
            dataUrl: photo.dataUrl,
            uploadedAt: photo.timestamp,
          },
          createdAt: now,
          status: 'pending',
          retryCount: 0,
        })
      }
      for (const photo of siteSignPhotos) {
        await db.mutationQueue.add({
          table: 'ticketAttachments',
          action: 'create',
          entityId: photo.id,
          payload: {
            ticketId,
            fileName: `${photo.id}.jpg`,
            fileType: 'photo',
            mimeType: 'image/jpeg',
            offlineBlobId: photo.id,
            dataUrl: photo.dataUrl,
            uploadedAt: photo.timestamp,
          },
          createdAt: now,
          status: 'pending',
          retryCount: 0,
        })
      }

      //    #11 Occ Health attachments: per-person individual results
      //    (fit_test_report, linked via fitTestRecordId) + daily calibration
      //    (calibration_cert, once per roster).
      if (workType === 'fit_test') {
        const occFiles: Array<{ id: string; fileName: string; mimeType: string; dataUrl: string; fileType: string; fitTestRecordId: string | null }> = [
          ...fitTestRecords.flatMap(rec => (rec.resultFiles || []).map(f => ({ ...f, fileType: 'fit_test_report', fitTestRecordId: rec.id }))),
          ...occDailyCalFiles.map(f => ({ ...f, fileType: 'calibration_cert', fitTestRecordId: null })),
        ]
        for (const f of occFiles) {
          await db.ticketAttachments.put({
            id: f.id, ticketId, fileName: f.fileName, fileType: f.fileType,
            filePath: null, fileSizeBytes: null, mimeType: f.mimeType,
            offlineBlobId: f.id, dataUrl: f.dataUrl, uploadedAt: now,
            fitTestRecordId: f.fitTestRecordId, _offlineStatus: 'pending',
          })
          await db.mutationQueue.add({
            table: 'ticketAttachments',
            action: 'create',
            entityId: f.id,
            payload: {
              ticketId, fileName: f.fileName, fileType: f.fileType,
              mimeType: f.mimeType, offlineBlobId: f.id, dataUrl: f.dataUrl,
              uploadedAt: now, fitTestRecordId: f.fitTestRecordId || undefined,
            },
            createdAt: now,
            status: 'pending',
            retryCount: 0,
          })
        }
      }

      //    Fit test record mutations
      if (workType === 'fit_test' && fitTestRecords.length > 0) {
        for (const rec of fitTestRecords) {
          await db.mutationQueue.add({
            table: 'fitTestRecords',
            action: 'create',
            entityId: rec.id,
            payload: {
              ticketId,
              employeeName: rec.employeeName,
              employeeId: rec.employeeId || undefined,
              employerName: rec.employerName || undefined,
              jobTitle: rec.jobTitle || undefined,
              respiratorType: rec.respiratorType || undefined,
              respiratorClass: rec.respiratorClass || undefined,
              respiratorMake: rec.respiratorMake || undefined,
              respiratorModel: rec.respiratorModel || undefined,
              respiratorSize: rec.respiratorSize || undefined,
              secondMask: rec.secondMask || undefined,
              testMethod: rec.testMethod || undefined,
              passFail: rec.passFail,
              fitFactor: rec.fitFactor || undefined,
              testDate: serviceDate,
              meqAccepted: rec.meqAccepted,
              meqDate: rec.meqDate || undefined,
              includesFitTest: rec.includesFitTest !== false,
              includesAudiometric: rec.includesAudiometric === true,
              audiometricResult: rec.audiometricResult || undefined,
              notes: rec.notes || undefined,
              // Disclosure data
              disclosureConditions: rec.disclosureConditions,
              isCleanShaven: rec.isCleanShaven,
              wearsGlassesContacts: rec.wearsGlassesContacts,
              adverseReactions: rec.adverseReactions,
              criteriaAcknowledged: rec.criteriaAcknowledged,
              participantSignature: rec.participantSignature || undefined,
            },
            createdAt: now,
            status: 'pending',
            retryCount: 0,
          })
        }
      }

      //    Air system inspection mutations
      if ((serviceType === 'cascade_air' || d3HasAir) && airSystemRecords.length > 0) {
        for (const rec of airSystemRecords) {
          await db.airSystemRecords.put({ ...rec, ticketId, _offlineStatus: 'pending' })
          await db.mutationQueue.add({
            table: 'airSystemRecords',
            action: 'create',
            entityId: rec.id,
            payload: {
              ticketId,
              workPointId: rec.workPointId || undefined,
              workPointName: rec.workPointName,
              airSystemType: rec.airSystemType || undefined,
              reelSerialNumber: rec.reelSerialNumber || undefined,
              standSerialNumber: rec.standSerialNumber || undefined,
              overallResult: rec.overallResult,
              reelCondition: rec.reelCondition,
              standCondition: rec.standCondition,
              hoseCondition: rec.hoseCondition,
              maskCondition: rec.maskCondition,
              regulatorCondition: rec.regulatorCondition,
              gaugeCondition: rec.gaugeCondition,
              alarmCondition: rec.alarmCondition,
              cylinderCondition: rec.cylinderCondition,
              cascadeArrivalPsi: rec.cascadeArrivalPsi ?? undefined,
              cascadeDeparturePsi: rec.cascadeDeparturePsi ?? undefined,
              cylinders: rec.cylinders,
              serviceActions: rec.serviceActions,
              partsReplaced: rec.partsReplaced || undefined,
              replacedRegulatorSerialOld: rec.replacedRegulatorSerialOld || undefined,
              replacedRegulatorSerialNew: rec.replacedRegulatorSerialNew || undefined,
              replacedMaskSerialOld: rec.replacedMaskSerialOld || undefined,
              replacedMaskSerialNew: rec.replacedMaskSerialNew || undefined,
              notes: rec.notes || undefined,
              inspectedAt: rec.inspectedAt || now,
            },
            createdAt: now,
            status: 'pending',
            retryCount: 0,
          })
        }
      }

      //    Gas detection record mutations (Phase B)
      if ((serviceType === 'gas_detection' || d3HasGas) && gasDetectionRecords.length > 0) {
        for (const rec of gasDetectionRecords) {
          await db.gasDetectionRecords.put({ ...rec, ticketId, _offlineStatus: 'pending' })
          await db.mutationQueue.add({
            table: 'gasDetectionRecords',
            action: 'create',
            entityId: rec.id,
            payload: {
              ticketId,
              monitorMake: rec.monitorMake || undefined,
              monitorModel: rec.monitorModel || undefined,
              monitorSerial: rec.monitorSerial,
              subtype: rec.subtype,
              testResult: rec.testResult || undefined,
              sensorReplaced: rec.sensorReplaced || undefined,
              workPerformed: rec.workPerformed || undefined,
              notes: rec.notes || undefined,
            },
            createdAt: now,
            status: 'pending',
            retryCount: 0,
          })
        }
      }

      //    Field inspection records (ShopWork Wave 4): PASS → locked ledger record
      //    (visual-only field bill); FAIL → spawn a Shop WO carrying field context.
      if (serviceType === 'inspection' && inspectionRecords.length > 0) {
        const passRecords = inspectionRecords.filter(r => r.outcome === 'pass')
        const failRecords = inspectionRecords.filter(r => r.outcome !== 'pass')

        for (const rec of passRecords) {
          await db.equipmentInspections.put({ ...rec, ticketId, lockedAt: now, _offlineStatus: 'pending' })
          await db.mutationQueue.add({
            table: 'equipmentInspections',
            action: 'create',
            entityId: rec.id,
            // Created already-locked so sync replay runs flow-back + BlueLion enqueue.
            payload: {
              id: rec.id,
              ticketId,
              shopItemId: null,
              serializedEquipmentId: rec.serializedEquipmentId ?? null,
              serialNumber: rec.serialNumber,
              category: rec.category,
              outcome: rec.outcome,
              serviceActions: rec.serviceActions,
              data: rec.data,
              partsReplaced: rec.partsReplaced ?? null,
              notes: rec.notes ?? null,
              customerApprovedName: rec.customerApprovedName ?? null,
              customerApprovedSignature: rec.customerApprovedSignature ?? null,
              customerApprovedAt: rec.customerApprovedAt ?? null,
              inspectedAt: rec.inspectedAt ?? now,
              lockedAt: now,
            },
            createdAt: now,
            status: 'pending',
            retryCount: 0,
          })
        }

        // FAIL units write NO ledger record (§4) — the fail survives as Shop WO
        // intake context. Spawn ONE WO; the shop re-inspects as the authority.
        if (failRecords.length > 0) {
          const woId = uuidv4()
          const woItems = failRecords.map(r => {
            const d = (r.data ?? {}) as Record<string, any>
            const isFex = r.category === 'fire_extinguisher'
            // Best-effort human label: FEX brand/type/size, else make/model
            // (gas monitors, SCBA), else nothing.
            const description =
              [d.brand, d.type, d.size].filter(Boolean).join(' ').trim()
              || [d.make, d.model].filter(Boolean).join(' ').trim()
              || null
            return {
              serializedEquipmentId: r.serializedEquipmentId ?? null,
              serialNumber: r.serialNumber,
              equipmentCategory: INSP_TO_SHOP_CATEGORY[r.category] ?? 'other',
              serviceType: 'inspection',
              // Carry the unit identity captured in the field so the shop sees a
              // real unit, not a bare serial (was dropped pre-fix — only serial +
              // category survived). FEX brand/size/type map to dedicated columns;
              // everything captured rides along in customData for the shop.
              fexBrand: isFex ? (d.brand || null) : null,
              fexSize: isFex ? (d.size || null) : null,
              fexType: isFex ? (d.type || null) : null,
              equipmentDescription: description,
              customData: Object.keys(d).length > 0 ? { fieldInspection: d } : undefined,
              reportedIssue: `Field inspection FAILED ${now.slice(0, 10)} (outcome: ${r.outcome.replace(/_/g, ' ')}). Re-inspect.`,
            }
          })
          // A field-spawned WO has no shop drop-off/pickup contact yet — the tech
          // carried it in. Send a lenient drop-off (the inspecting tech) and flag
          // contacts optional so the shared create helper doesn't reject it (the
          // missing contacts were why the WO synced with zero items pre-fix).
          const techName = user?.name || user?.id || 'Field Tech'
          const woPayload = {
            id: woId,
            companyId: customer?.id || '',
            isInternal: false,
            intakeDate: now,
            intakeNotes: `Auto-spawned from a field inspection — ${failRecords.length} unit(s) failed and were sent in for shop service.`,
            primaryCategory: woItems[0]?.equipmentCategory ?? null,
            priority: 5,
            intakeSiteId: getActiveSiteId() ?? '',
            sourceLocationId: location.pad?.id ?? null,
            // Contacts are optional for field-spawned WOs; record the tech as the
            // drop-off so the shop knows who brought it in.
            contactsOptional: true,
            dropOffContact: { name: techName, preferred: 'call' },
            // Auto-transit to the selected return shop, transported by the
            // inspecting tech. The server resolves the destination by short
            // code, leaves the items "in transit" until that shop receives
            // them, and no-ops when intake already happened there.
            //
            // No literal fallback: the value is already validated against the
            // live (or last-cached) site list, so it is either resolvable or
            // genuinely unknown. Sending a guess is what silently stranded
            // gear — a guess that fails to resolve looks exactly like a
            // deliberate no-op, whereas omitting it is honest, and the
            // who_where step warns the tech when it comes to that.
            transitToShortCode: returnShopShortCode || undefined,
            transportedById: user?.id ?? null,
            items: woItems,
          }
          await db.shopWorkOrders.put({
            id: woId,
            workOrderNumber: 'Pending...',
            status: 'intake',
            companyId: customer?.id || '',
            companyName: customer?.name || '',
            isInternal: false,
            poNumber: null,
            afeNumber: null,
            intakeDate: now,
            intakeNotes: woPayload.intakeNotes,
            intakeById: null,
            intakeByName: undefined,
            intakeSiteId: woPayload.intakeSiteId,
            sourceLocationId: location.pad?.id ?? null,
            returnLocationId: null,
            promisedDate: null,
            priority: 5,
            completedDate: null,
            returnedDate: null,
            totalItems: woItems.length,
            completedItems: 0,
            primaryCategory: woPayload.primaryCategory,
            notes: null,
            dropOffContactName: null,
            dropOffContactPhone: null,
            dropOffContactEmail: null,
            dropOffContactPreferred: null,
            pickupContactName: null,
            pickupContactPhone: null,
            pickupContactEmail: null,
            pickupContactPreferred: null,
            pickupSignedByName: null,
            pickupSignature: null,
            pickupSignedAt: null,
            pickupNotes: null,
            createdAt: now,
            updatedAt: now,
            _offlineStatus: 'pending',
          } as OfflineShopWorkOrder)
          await db.mutationQueue.add({
            table: 'shopWorkOrders',
            action: 'create',
            entityId: woId,
            payload: woPayload,
            createdAt: now,
            status: 'pending',
            retryCount: 0,
          })
        }
      }

      //    IH test record mutations
      if ((workType === 'ih_testing' || d3HasIh) && ihTestRecords.length > 0) {
        for (const rec of ihTestRecords) {
          await db.ihTestRecords.put({ ...rec, ticketId, _offlineStatus: 'pending' })
          await db.mutationQueue.add({
            table: 'ihTestRecords',
            action: 'create',
            entityId: rec.id,
            payload: {
              ticketId,
              testType: rec.testType,
              locationPoint: rec.locationPoint || undefined,
              instrumentModel: rec.instrumentModel || undefined,
              instrumentSerial: rec.instrumentSerial || undefined,
              testData: rec.testData,
              notes: rec.notes || undefined,
              testedAt: rec.testedAt || now,
            },
            createdAt: now,
            status: 'pending',
            retryCount: 0,
          })
        }
      }

      //    Training roster record mutations
      if (workType === 'training' && trainingRosterRecords.length > 0) {
        for (const rec of trainingRosterRecords) {
          await db.trainingRosterRecords.put({ ...rec, ticketId, _offlineStatus: 'pending' })
          await db.mutationQueue.add({
            table: 'trainingRosterRecords',
            action: 'create',
            entityId: rec.id,
            payload: {
              ticketId,
              employeeName: rec.employeeName,
              employeeId: rec.employeeId || undefined,
              employerName: rec.employerName || undefined,
              employerCompanyId: rec.employerCompanyId || undefined,
              contactEmail: rec.contactEmail || undefined,
              contactPhone: rec.contactPhone || undefined,
              courseName: rec.courseName,
              passed: rec.passed,
              cardIssuedOnSite: rec.cardIssuedOnSite,
              cardIssuedOfficial: rec.cardIssuedOfficial,
              cardNumber: rec.cardNumber || undefined,
              cardExpiryDate: rec.cardExpiryDate || undefined,
              notes: rec.notes || undefined,
              trainedAt: rec.trainedAt || now,
            },
            createdAt: now,
            status: 'pending',
            retryCount: 0,
          })
        }
      }

      await clearDraft()
      navigate('/tickets')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to submit ticket'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  // ---- Edit mode save ----

  async function handleSaveEdit(targetStatus?: string) {
    if (!editTicketId) return
    // Customer is mandatory — guard the edit/re-entry path too. If an offline
    // reopen couldn't resolve the customer, this forces a re-selection instead
    // of re-saving a customer-less ticket.
    if (!customer) {
      setError('Customer is required — re-select the customer before saving.')
      return
    }
    if (targetStatus === 'supervisor_review' && requiresSiteSignEvidence && siteSignPhotos.length === 0) {
      setError('Site sign photo is required before completing this field ticket.')
      return
    }
    if (targetStatus === 'supervisor_review' && requiresSiteSignEvidence && !siteSignGeotagged) {
      setError('Site sign photo must include GPS before completing. Allow location access and capture the sign again.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const now = new Date().toISOString()
      const status = targetStatus || originalStatus
      const payload = buildTicketPayload()

      // 1. Update local ticket in Dexie
      await db.tickets.update(editTicketId, {
        ...payload,
        locationDisplay: [location.pad?.name, wellsDisplayLabel()].filter(Boolean).join(' > ') || customer?.name || '',
        status,
        updatedAt: now,
        _offlineStatus: 'pending' as const,
      })

      // 2. Queue the ticket mutation. If this ticket was created offline and
      //    its create hasn't synced yet, amend that create in place rather than
      //    queuing an update for a record the server has never seen. This is
      //    also the recovery path for a create that errored server-side (e.g. a
      //    customer-less ticket): re-selecting the customer here rewrites the
      //    queued payload so it can finally land, instead of leaving a dead
      //    create + a doomed update stuck in the queue.
      const ticketPayload = { ...payload, status, customerRepSignature: signature || undefined }
      const pendingCreate = (
        await db.mutationQueue.where('entityId').equals(editTicketId).toArray()
      ).find(m => m.table === 'tickets' && m.action === 'create' && m.status !== 'done')
      if (pendingCreate) {
        await db.mutationQueue.update(pendingCreate.queueId!, {
          payload: { ...ticketPayload, offlineId: pendingCreate.offlineId ?? editTicketId },
          status: 'pending',
          retryCount: 0,
          errorMessage: null,
        })
      } else {
        await db.mutationQueue.add({
          table: 'tickets' as const,
          action: 'update' as const,
          entityId: editTicketId,
          payload: ticketPayload,
          createdAt: now,
          status: 'pending' as const,
          retryCount: 0,
        })
      }

      // 3. Diff line items: create / update / delete
      const currentLineItemIds = new Set(lineItems.map(li => li.id))
      // New items
      for (let i = 0; i < lineItems.length; i++) {
        const item = lineItems[i]
        if (!originalLineItemIds.has(item.id)) {
          await db.ticketLineItems.put({
            id: item.id, ticketId: editTicketId, lineNumber: i + 1,
            lineType: item.lineType, productId: (item as any).productId || null,
            description: item.description, quantity: item.quantity,
            rate: item.rate ?? null, total: item.total ?? null, unitOfMeasure: item.unitOfMeasure || null,
            serialNumberInstalled: item.serialNumberInstalled || null,
            serialNumberRemoved: item.serialNumberRemoved || null,
            testResult: item.testResult || null, calGasLotNumber: item.calGasLotNumber || null,
            sortOrder: i, notes: item.notes || null, customData: priceLevelCustomData(item),
            updatedAt: now, _offlineStatus: 'pending',
          })
          await db.mutationQueue.add({
            table: 'ticketLineItems' as const, action: 'create' as const, entityId: item.id,
            payload: {
              ticketId: editTicketId, lineType: item.lineType,
              productId: (item as any).productId || undefined,
              description: item.description, quantity: item.quantity,
              rate: item.rate ?? undefined, total: item.total ?? undefined,
              unitOfMeasure: item.unitOfMeasure || undefined, sortOrder: i,
              serialNumberInstalled: item.serialNumberInstalled || undefined,
              serialNumberRemoved: item.serialNumberRemoved || undefined,
              testResult: item.testResult || undefined, calGasLotNumber: item.calGasLotNumber || undefined,
              notes: item.notes || undefined, customData: priceLevelCustomData(item),
            },
            createdAt: now, status: 'pending' as const, retryCount: 0,
          })
        }
      }
      // Updated items
      for (let i = 0; i < lineItems.length; i++) {
        const item = lineItems[i]
        if (originalLineItemIds.has(item.id)) {
          await db.ticketLineItems.update(item.id, {
            lineType: item.lineType, description: item.description, quantity: item.quantity,
            rate: item.rate ?? null, total: item.total ?? null, unitOfMeasure: item.unitOfMeasure || null,
            serialNumberInstalled: item.serialNumberInstalled || null,
            serialNumberRemoved: item.serialNumberRemoved || null,
            testResult: item.testResult || null, calGasLotNumber: item.calGasLotNumber || null,
            sortOrder: i, notes: item.notes || null, customData: priceLevelCustomData(item),
            updatedAt: now, _offlineStatus: 'pending',
          })
          await db.mutationQueue.add({
            table: 'ticketLineItems' as const, action: 'update' as const, entityId: item.id,
            payload: {
              lineType: item.lineType, description: item.description, quantity: item.quantity,
              rate: item.rate ?? undefined, total: item.total ?? undefined,
              unitOfMeasure: item.unitOfMeasure || undefined,
              sortOrder: i, serialNumberInstalled: item.serialNumberInstalled || undefined,
              serialNumberRemoved: item.serialNumberRemoved || undefined,
              testResult: item.testResult || undefined, calGasLotNumber: item.calGasLotNumber || undefined,
              notes: item.notes || undefined, customData: priceLevelCustomData(item),
            },
            createdAt: now, status: 'pending' as const, retryCount: 0,
          })
        }
      }
      // Deleted items
      for (const oldId of originalLineItemIds) {
        if (!currentLineItemIds.has(oldId)) {
          await db.ticketLineItems.delete(oldId)
          await db.mutationQueue.add({
            table: 'ticketLineItems' as const, action: 'delete' as const, entityId: oldId,
            payload: {}, createdAt: now, status: 'pending' as const, retryCount: 0,
          })
        }
      }

      // 4. Diff fit test records: create / update / delete
      if (workType === 'fit_test') {
        const currentFitTestIds = new Set(fitTestRecords.map(ft => ft.id))
        const fitTestPayload = (rec: FitTestDraftRecord) => ({
          ticketId: editTicketId,
          employeeName: rec.employeeName, employeeId: rec.employeeId || undefined,
          employerName: rec.employerName || undefined, jobTitle: rec.jobTitle || undefined,
          respiratorType: rec.respiratorType || undefined, respiratorClass: rec.respiratorClass || undefined,
          respiratorMake: rec.respiratorMake || undefined,
          respiratorModel: rec.respiratorModel || undefined, respiratorSize: rec.respiratorSize || undefined,
          secondMask: rec.secondMask || undefined,
          testMethod: rec.testMethod || undefined, passFail: rec.passFail,
          fitFactor: rec.fitFactor || undefined, testDate: serviceDate,
          meqAccepted: rec.meqAccepted, meqDate: rec.meqDate || undefined,
          includesFitTest: rec.includesFitTest !== false, includesAudiometric: rec.includesAudiometric === true,
          audiometricResult: rec.audiometricResult || undefined,
          notes: rec.notes || undefined,
          disclosureConditions: rec.disclosureConditions, isCleanShaven: rec.isCleanShaven,
          wearsGlassesContacts: rec.wearsGlassesContacts, adverseReactions: rec.adverseReactions,
          criteriaAcknowledged: rec.criteriaAcknowledged, participantSignature: rec.participantSignature || undefined,
        })

        for (const rec of fitTestRecords) {
          if (!originalFitTestIds.has(rec.id)) {
            // New record
            await db.fitTestRecords.put({
              ...rec, ticketId: editTicketId, testDate: serviceDate,
              updatedAt: now, _offlineStatus: 'pending',
            })
            await db.mutationQueue.add({
              table: 'fitTestRecords' as const, action: 'create' as const, entityId: rec.id,
              payload: fitTestPayload(rec), createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          } else {
            // Updated record
            await db.mutationQueue.add({
              table: 'fitTestRecords' as const, action: 'update' as const, entityId: rec.id,
              payload: fitTestPayload(rec), createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          }
        }
        // Deleted records
        for (const oldId of originalFitTestIds) {
          if (!currentFitTestIds.has(oldId)) {
            await db.fitTestRecords.delete(oldId)
            await db.mutationQueue.add({
              table: 'fitTestRecords' as const, action: 'delete' as const, entityId: oldId,
              payload: {}, createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          }
        }
      }

      // 5. Diff air system records: create / update / delete
      if (serviceType === 'cascade_air' || d3HasAir) {
        const currentAirSystemIds = new Set(airSystemRecords.map(r => r.id))
        const airSystemPayload = (rec: AirSystemDraftRecord) => ({
          ticketId: editTicketId,
          workPointId: rec.workPointId || undefined,
          workPointName: rec.workPointName,
          airSystemType: rec.airSystemType || undefined,
          reelSerialNumber: rec.reelSerialNumber || undefined,
          standSerialNumber: rec.standSerialNumber || undefined,
          overallResult: rec.overallResult,
          reelCondition: rec.reelCondition,
          standCondition: rec.standCondition,
          hoseCondition: rec.hoseCondition,
          maskCondition: rec.maskCondition,
          regulatorCondition: rec.regulatorCondition,
          gaugeCondition: rec.gaugeCondition,
          alarmCondition: rec.alarmCondition,
          cylinderCondition: rec.cylinderCondition,
          cascadeArrivalPsi: rec.cascadeArrivalPsi ?? undefined,
          cascadeDeparturePsi: rec.cascadeDeparturePsi ?? undefined,
          cylinders: rec.cylinders,
          serviceActions: rec.serviceActions,
          partsReplaced: rec.partsReplaced || undefined,
          replacedRegulatorSerialOld: rec.replacedRegulatorSerialOld || undefined,
          replacedRegulatorSerialNew: rec.replacedRegulatorSerialNew || undefined,
          replacedMaskSerialOld: rec.replacedMaskSerialOld || undefined,
          replacedMaskSerialNew: rec.replacedMaskSerialNew || undefined,
          notes: rec.notes || undefined,
          inspectedAt: rec.inspectedAt || now,
        })

        for (const rec of airSystemRecords) {
          if (!originalAirSystemIds.has(rec.id)) {
            // New record
            await db.airSystemRecords.put({ ...rec, ticketId: editTicketId, _offlineStatus: 'pending' })
            await db.mutationQueue.add({
              table: 'airSystemRecords' as const, action: 'create' as const, entityId: rec.id,
              payload: airSystemPayload(rec), createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          } else {
            // Updated record
            await db.mutationQueue.add({
              table: 'airSystemRecords' as const, action: 'update' as const, entityId: rec.id,
              payload: airSystemPayload(rec), createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          }
        }
        // Deleted records
        for (const oldId of originalAirSystemIds) {
          if (!currentAirSystemIds.has(oldId)) {
            await db.airSystemRecords.delete(oldId)
            await db.mutationQueue.add({
              table: 'airSystemRecords' as const, action: 'delete' as const, entityId: oldId,
              payload: {}, createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          }
        }
      }

      // 6. Diff IH test records: create / update / delete
      if (workType === 'ih_testing' || d3HasIh) {
        const currentIhTestIds = new Set(ihTestRecords.map(r => r.id))
        const ihTestPayload = (rec: IhTestDraftRecord) => ({
          ticketId: editTicketId,
          testType: rec.testType,
          locationPoint: rec.locationPoint || undefined,
          instrumentModel: rec.instrumentModel || undefined,
          instrumentSerial: rec.instrumentSerial || undefined,
          testData: rec.testData,
          notes: rec.notes || undefined,
          testedAt: rec.testedAt || now,
        })

        for (const rec of ihTestRecords) {
          if (!originalIhTestIds.has(rec.id)) {
            // New record
            await db.ihTestRecords.put({ ...rec, ticketId: editTicketId, _offlineStatus: 'pending' })
            await db.mutationQueue.add({
              table: 'ihTestRecords' as const, action: 'create' as const, entityId: rec.id,
              payload: ihTestPayload(rec), createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          } else {
            // Updated record
            await db.mutationQueue.add({
              table: 'ihTestRecords' as const, action: 'update' as const, entityId: rec.id,
              payload: ihTestPayload(rec), createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          }
        }
        // Deleted records
        for (const oldId of originalIhTestIds) {
          if (!currentIhTestIds.has(oldId)) {
            await db.ihTestRecords.delete(oldId)
            await db.mutationQueue.add({
              table: 'ihTestRecords' as const, action: 'delete' as const, entityId: oldId,
              payload: {}, createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          }
        }
      }

      // 7. Diff training roster records: create / update / delete
      if (workType === 'training') {
        const currentTrainingIds = new Set(trainingRosterRecords.map(r => r.id))
        const trainingPayload = (rec: TrainingRosterDraftRecord) => ({
          ticketId: editTicketId,
          employeeName: rec.employeeName,
          employeeId: rec.employeeId || undefined,
          employerName: rec.employerName || undefined,
          employerCompanyId: rec.employerCompanyId || undefined,
          contactEmail: rec.contactEmail || undefined,
          contactPhone: rec.contactPhone || undefined,
          courseName: rec.courseName,
          passed: rec.passed,
          cardIssuedOnSite: rec.cardIssuedOnSite,
          cardIssuedOfficial: rec.cardIssuedOfficial,
          cardNumber: rec.cardNumber || undefined,
          cardExpiryDate: rec.cardExpiryDate || undefined,
          notes: rec.notes || undefined,
          trainedAt: rec.trainedAt || now,
        })

        for (const rec of trainingRosterRecords) {
          if (!originalTrainingRosterIds.has(rec.id)) {
            // New record
            await db.trainingRosterRecords.put({ ...rec, ticketId: editTicketId, _offlineStatus: 'pending' })
            await db.mutationQueue.add({
              table: 'trainingRosterRecords' as const, action: 'create' as const, entityId: rec.id,
              payload: trainingPayload(rec), createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          } else {
            // Updated record
            await db.mutationQueue.add({
              table: 'trainingRosterRecords' as const, action: 'update' as const, entityId: rec.id,
              payload: trainingPayload(rec), createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          }
        }
        // Deleted records
        for (const oldId of originalTrainingRosterIds) {
          if (!currentTrainingIds.has(oldId)) {
            await db.trainingRosterRecords.delete(oldId)
            await db.mutationQueue.add({
              table: 'trainingRosterRecords' as const, action: 'delete' as const, entityId: oldId,
              payload: {}, createdAt: now, status: 'pending' as const, retryCount: 0,
            })
          }
        }
      }

      // 8. New photos only (existing photos are immutable)
      for (const photo of photos) {
        await db.ticketAttachments.put({
          id: photo.id, ticketId: editTicketId,
          fileName: `${photo.id}.jpg`, fileType: 'photo', filePath: null, fileSizeBytes: null,
          mimeType: 'image/jpeg', offlineBlobId: photo.id, dataUrl: photo.dataUrl,
          uploadedAt: photo.timestamp, _offlineStatus: 'pending',
        })
        await db.mutationQueue.add({
          table: 'ticketAttachments' as const, action: 'create' as const, entityId: photo.id,
          payload: {
            ticketId: editTicketId, fileName: `${photo.id}.jpg`, fileType: 'photo',
            mimeType: 'image/jpeg', offlineBlobId: photo.id, dataUrl: photo.dataUrl,
            uploadedAt: photo.timestamp,
          },
          createdAt: now, status: 'pending' as const, retryCount: 0,
        })
      }
      for (const photo of siteSignPhotos) {
        await db.ticketAttachments.put({
          id: photo.id, ticketId: editTicketId,
          fileName: `${photo.id}.jpg`, fileType: 'photo', filePath: null, fileSizeBytes: null,
          mimeType: 'image/jpeg', offlineBlobId: photo.id, dataUrl: photo.dataUrl,
          uploadedAt: photo.timestamp, _offlineStatus: 'pending',
        })
        await db.mutationQueue.add({
          table: 'ticketAttachments' as const, action: 'create' as const, entityId: photo.id,
          payload: {
            ticketId: editTicketId, fileName: `${photo.id}.jpg`, fileType: 'photo',
            mimeType: 'image/jpeg', offlineBlobId: photo.id, dataUrl: photo.dataUrl,
            uploadedAt: photo.timestamp,
          },
          createdAt: now, status: 'pending' as const, retryCount: 0,
        })
      }

      await clearDraft()
      navigate(`/tickets/${editTicketId}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save changes'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  // ---- #13 Student QR sign-in (roster step) ----

  // Open self-sign-in for this class. Sign-ins land as roster records on the
  // server ticket, so in create mode the class is created right now (as a
  // draft — no arrival/departure yet) and the wizard reopens in edit mode on
  // it; the typed-so-far state rides across in the edit-session draft so the
  // final Save & Complete updates that ticket instead of creating a twin.
  async function openStudentSignin() {
    if (signinBusy) return
    setSigninBusy(true)
    setSigninError('')
    try {
      if (!isEditMode) {
        const created = await api.post<{ id: string }>('/tickets', {
          ...buildTicketPayload(),
          status: 'draft',
        })
        const rosterIdx = activeConfig ? activeConfig.steps.indexOf('tr_roster') : -1
        await db.drafts.put({
          id: `edit-${created.id}`,
          ticketId: null,
          step: rosterIdx >= 0 ? rosterIdx + 1 : step,
          wizardData: getWizardData(),
          updatedAt: new Date().toISOString(),
        })
        await clearDraft()
        navigate(`/tickets/${created.id}/edit?signin=1`, { replace: true })
        return
      }
      const qr = await api.post<{ url: string; qrDataUrl: string }>(`/train/link/${editTicketId}`, {})
      setSigninQr(qr)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : ''
      setSigninError(msg || 'Could not open sign-in — check your connection.')
    } finally {
      setSigninBusy(false)
    }
  }

  // Pull self-sign-ins from the server into the local roster. Merged records
  // register as "original" so the edit diff updates them instead of
  // re-creating duplicates on save.
  async function refreshSignins() {
    if (!editTicketId || signinRefreshing) return
    setSigninRefreshing(true)
    setSigninError('')
    try {
      const t = await api.get<any>(`/tickets/${editTicketId}`)
      const server: any[] = Array.isArray(t?.trainingRosterRecords) ? t.trainingRosterRecords : []
      const have = new Set(trainingRosterRecords.map(r => r.id))
      const mapped: TrainingRosterDraftRecord[] = server
        .filter(r => r?.id && !have.has(r.id))
        .map(r => ({
          id: r.id,
          ticketId: editTicketId,
          employeeName: r.employeeName || '',
          employeeId: r.employeeId || '',
          employerName: r.employerName || '',
          employerCompanyId: r.employerCompanyId ?? null,
          contactEmail: r.contactEmail || '',
          contactPhone: r.contactPhone || '',
          courseName: r.courseName || (trainingCourseName === 'Other' ? trainingCourseOther : trainingCourseName),
          passed: r.passed ?? true,
          cardIssuedOnSite: r.cardIssuedOnSite ?? false,
          cardIssuedOfficial: r.cardIssuedOfficial ?? false,
          cardNumber: r.cardNumber || '',
          cardExpiryDate: r.cardExpiryDate ? String(r.cardExpiryDate).slice(0, 10) : '',
          notes: r.notes || '',
          trainedAt: r.trainedAt || new Date().toISOString(),
        }))
      if (mapped.length > 0) {
        setTrainingRosterRecords(prev => [...prev, ...mapped])
        setOriginalTrainingRosterIds(prev => new Set([...prev, ...mapped.map(m => m.id)]))
      }
      setSigninNewCount(mapped.length)
    } catch {
      setSigninError('Could not refresh sign-ins — check your connection.')
    } finally {
      setSigninRefreshing(false)
    }
  }

  // ---- Navigation helpers ----

  function handleBack() {
    if (isEditMode && step <= 1) {
      // In edit mode, back from step 1 goes to the ticket detail page
      navigate(`/tickets/${editTicketId}`)
    } else if (step <= 1) {
      // ADR-0013: the work type came from /tickets/start, so backing out of
      // the first step goes back THERE to re-pick it. This wizard no longer
      // owns a work-type screen of its own.
      navigate('/tickets/start')
    } else {
      setStep(step - 1)
    }
  }

  // ---- Render ----

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={handleBack}
          className="p-2 -ml-2 text-slate-600 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-900">
            {`${isEditMode ? 'Edit' : 'New'} ${activeConfig?.label || 'Ticket'}`}
          </h1>
          {step > 0 && totalSteps > 0 && (
            <p className="text-sm text-slate-500">Step {step} of {totalSteps}</p>
          )}
        </div>
      </div>

      {/* Progress bar (only when inside a flow) */}
      {step > 0 && totalSteps > 0 && (
        <div className="flex gap-1 mb-6">
          {activeConfig!.steps.map((_, i) => (
            <div
              key={i}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-colors',
                i < step ? 'bg-blue-600' : 'bg-slate-200',
              )}
            />
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* ADR-0013: the step-0 work-type grid used to live here. /tickets/start
          (WizardShell) is the only work-type picker now, so a wizard that
          somehow lands without one redirects there rather than rendering a
          second, divergent copy of the same choice. */}

      {/* ============================================================ */}
      {/* D3 COMBINED: Services                                        */}
      {/* ============================================================ */}
      {currentStepId === 'd3_services' && (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">D3 work performed</h2>
            <p className="text-sm text-slate-500 mt-1">Pick every service handled on this visit. Air System New Install stays as its own Air System ticket.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {([
              { value: 'air', label: 'Air System', icon: Wind },
              { value: 'ih', label: 'IH Testing', icon: FlaskConical },
              { value: 'gas', label: 'Gas Detection', icon: ShieldCheck },
            ] as const).map(s => {
              const Icon = s.icon
              const selected = d3CombinedServices.has(s.value)
              return (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => {
                    const next = new Set(d3CombinedServices)
                    if (selected) next.delete(s.value)
                    else next.add(s.value)
                    setD3CombinedServices(next)
                  }}
                  className={cn(
                    'p-4 rounded-lg border-2 text-left transition-colors',
                    selected ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600 hover:border-slate-300',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4" />
                    <span className="font-medium text-sm">{s.label}</span>
                    {selected && <Check className="w-4 h-4 ml-auto text-blue-600" />}
                  </div>
                </button>
              )
            })}
          </div>

          {d3HasAir && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Air System work <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {([
                  { value: 'inspection', label: 'Inspection' },
                  { value: 'air_fill', label: 'Air Fill' },
                  { value: 'other_repair', label: 'Other Repair' },
                ] as const).map(s => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => toggleCascadeAirSubtype(s.value)}
                    className={cn(
                      'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                      cascadeAirSubtypes.has(s.value)
                        ? 'border-blue-500 bg-blue-50 text-blue-800'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {d3HasIh && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                IH Test Types <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {IH_SUBTYPES.map(st => {
                  const selected = ihSubtypes.has(st.value)
                  return (
                    <button
                      key={st.value}
                      type="button"
                      onClick={() => {
                        const next = new Set(ihSubtypes)
                        if (selected) next.delete(st.value)
                        else next.add(st.value)
                        setIhSubtypes(next)
                      }}
                      className={cn(
                        'p-3 rounded-lg border-2 text-left transition-colors',
                        selected ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600 hover:border-slate-300',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm">{st.label}</span>
                        {selected && <Check className="w-4 h-4 text-blue-600" />}
                      </div>
                      <p className="text-xs mt-0.5 opacity-75">{st.description}</p>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {d3HasGas && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Gas Detection monitor type <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setGasDetectionFixed(v => !v)}
                  className={cn(
                    'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                    gasDetectionFixed ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600 hover:border-slate-300',
                  )}
                >
                  Fixed
                </button>
                <button
                  type="button"
                  onClick={() => setGasDetectionArea(v => !v)}
                  className={cn(
                    'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                    gasDetectionArea ? 'border-blue-500 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600 hover:border-slate-300',
                  )}
                >
                  Area
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* FIELD SERVICE: Who & Where                                   */}
      {/* ============================================================ */}
      {currentStepId === 'who_where' && (
        <div className="space-y-6">
          {/* ADR-0017: the division came from the wizard path — lock it and show
              only the Dickinson toggle. The free D3/D4 picker is the legacy
              fallback for /tickets/new reached without a division. */}
          <DivisionSelector
            division={division}
            isDickinson={isDickinson}
            onChange={(d, dickinson) => { setDivision(d); setIsDickinson(dickinson) }}
            fixedDivision={division ?? (workType === 'field_inspection' ? 'D6' : undefined)}
          />

          {/* Field Inspection: which shop do failed units go back to? Defaults
              to Williston (~98%); selectable so the rare return-elsewhere unit
              isn't stranded at the wrong site. */}
          {workType === 'field_inspection' && shopSites.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Return to shop
                <span className="ml-2 text-xs font-normal text-slate-500">where failed units are sent for service</span>
              </label>
              <select
                value={returnShopShortCode}
                onChange={e => setReturnShopShortCode(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              >
                {shopSites.map(s => (
                  <option key={s.id} value={s.shortCode}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* No site list at all: never been online since install, and the
              device cache is empty. Deliberately a note and not a submit gate —
              the inspection still has to be recorded, and blocking a tech in
              the field to fix a reference-data problem is the wrong trade. It
              says what will actually happen so nobody assumes a hand-off that
              isn't going to be logged. */}
          {workType === 'field_inspection' && shopSites.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>
                Can't reach the shop list, so a return shop can't be set. Failed units will be
                logged at your current site and <strong>won't show as inbound anywhere else</strong> —
                tell the shop directly if you're driving them in.
              </span>
            </div>
          )}

          <CustomerSearch value={customer} onChange={setCustomer} />
          <CustomerFlagBanners creditHold={customerCreditHold} cashCcOnly={customerCashCcOnly} priceLevel={priceLevel} />

          <LocationPicker
            companyId={customer?.id || null}
            value={location}
            onChange={setLocation}
            allActive
          />

          {showsSiteSignEvidence && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
              <div>
                <h3 className="font-medium text-amber-950">
                  Site sign photo {requiresSiteSignEvidence && <span className="text-red-500">*</span>}
                </h3>
                <p className="text-xs text-amber-800 mt-1">
                  {requiresSiteSignEvidence
                    ? 'Required when the location is new, pending review, or not linked to the selected customer. Capture the site sign with GPS enabled.'
                    : 'Optional. This site is already linked to the selected customer in ServicePRO.'}
                </p>
              </div>
              {customerLocationMismatch && selectedLocationOwner && (
                <p className="text-xs font-medium text-amber-900">
                  Site currently belongs to {selectedLocationOwner.name || 'another customer'}; approval will ask whether to assign it to {customer?.name}.
                </p>
              )}
              <PhotoCapture photos={siteSignPhotos} onChange={setSiteSignPhotos} maxPhotos={3} captureLocation />
            </div>
          )}

          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={rigPresent}
                onChange={e => {
                  setRigPresent(e.target.checked)
                  if (!e.target.checked) setPresentRig(null)
                }}
                className="rounded"
              />
              Rig present
            </label>
            {rigPresent && (
              <div className="mt-2">
                <MobileAssetPicker kind="rig" value={presentRig} onChange={setPresentRig} />
              </div>
            )}
          </div>

          {/* The division tile already answered this. Show it as a settled
              line rather than a live question — tapping Change reopens both
              grids for the rare mis-tap. */}
          {serviceFromPath && !showServicePickers && workType !== 'field_inspection' && workType !== 'd3_combined' && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Service Type</p>
                <p className="truncate text-sm font-medium text-slate-800">
                  {SERVICE_TYPES.find(st => st.value === serviceType)?.label || serviceType}
                  {onSiteSubtype && (
                    <span className="text-slate-500">
                      {' · '}{ON_SITE_SUBTYPES.find(s => s.value === onSiteSubtype)?.label}
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowServicePickers(true)}
                className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-white"
              >
                Change
              </button>
            </div>
          )}

          {/* Field Inspection is a dedicated work type locked to serviceType
              'inspection' — the service-type grid is only shown for the generic
              Field Service flow where the tech still has to pick one. */}
          {workType !== 'field_inspection' && workType !== 'd3_combined' && (!serviceFromPath || showServicePickers) && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Service Type</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {SERVICE_TYPES.map(st => (
                  <button
                    key={st.value}
                    type="button"
                    onClick={() => setServiceType(st.value)}
                    className={cn(
                      'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                      serviceType === st.value
                        ? 'border-blue-500 bg-blue-50 text-blue-800'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    )}
                  >
                    {st.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {serviceType === 'on_site_services' && (
            <div>
              {(!serviceFromPath || showServicePickers) && (
                <>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    On-site work <span className="text-red-500">*</span>
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {ON_SITE_SUBTYPES.map(s => (
                      <button
                        key={s.value}
                        type="button"
                        onClick={() => setOnSiteSubtype(s.value)}
                        className={cn(
                          'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                          onSiteSubtype === s.value
                            ? 'border-blue-500 bg-blue-50 text-blue-800'
                            : 'border-slate-200 text-slate-600 hover:border-slate-300',
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {/* Hoisted rental picker for Manned Trailer — this is THE most
                  important field on the page when manned_trailer is selected. */}
              {onSiteSubtype === 'manned_trailer' && (
                <div className={cn(
                  'mt-3 p-3 rounded-lg border-2',
                  linkedRentalId
                    ? 'border-emerald-200 bg-emerald-50/50'
                    : 'border-amber-300 bg-amber-50',
                )}>
                  <label className="block text-sm font-semibold text-slate-800 mb-1.5">
                    Link to Rental {linkedRentalId ? '✓' : <span className="text-red-600">*</span>}
                  </label>
                  {activeRentals.length > 0 ? (
                    <select
                      value={linkedRentalId || ''}
                      onChange={e => {
                        const next = activeRentals.find(r => r.id === e.target.value)
                        if (next) void applyRentalJobToWizard(next, 'link')
                        else setLinkedRentalId(null)
                      }}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                    >
                      <option value="">- pick a rental job -</option>
                      {activeRentals.map(r => (
                        <option key={r.id} value={r.id}>
                          {rentalJobOptionLabel(r)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-sm text-slate-600 italic">
                      No active rentals for this customer.
                    </p>
                  )}
                  {!linkedRentalId && (
                    <p className="mt-2 text-xs text-amber-700">
                      Manned Trailer tickets <strong>should</strong> link to a rental contract so the
                      shift writes into the rental's daily log. You can submit anyway and a field sup
                      can retro-link during approval.
                    </p>
                  )}
                  {linkedRentalId && (
                    <p className="mt-1.5 text-xs text-emerald-700">
                      Site log entries below will mirror into this rental's daily log on submit.
                    </p>
                  )}

                  {/* #2 Redeploy — jump to the rental to add monitors/gear as a
                      dated event. Draft autosaves, so returning restores this ticket. */}
                  {linkedRentalId && (
                    <button
                      type="button"
                      onClick={() => navigate(`/rentals/${linkedRentalId}`)}
                      className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-700 underline"
                    >
                      Need to add monitors or gear? Manage this rental's equipment →
                    </button>
                  )}

                  {/* On-Site Contact — read-only carry-through from the rental so
                      the tech has the customer's site contact in hand and never
                      has to pop back to Rental to look it up. */}
                  {linkedRentalId && linkedSiteContact && (
                    <div className="mt-3 pt-3 border-t border-slate-200">
                      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                        On-Site Contact
                      </p>
                      <div className="text-sm text-slate-800">
                        {linkedSiteContact.name && (
                          <span className="font-medium">{linkedSiteContact.name}</span>
                        )}
                        {linkedSiteContact.phone && (
                          <a
                            href={`tel:${linkedSiteContact.phone.replace(/[^\d+]/g, '')}`}
                            className="ml-2 text-blue-600 hover:text-blue-700 underline"
                          >
                            {linkedSiteContact.phone}
                          </a>
                        )}
                        {linkedSiteContact.email && (
                          <a
                            href={`mailto:${linkedSiteContact.email}`}
                            className="ml-2 text-blue-600 hover:text-blue-700 underline break-all"
                          >
                            {linkedSiteContact.email}
                          </a>
                        )}
                      </div>
                    </div>
                  )}

                  {/* #1 PIC roster — forepersons / persons-in-charge. Seeded from
                      the agreement, written back on submit so the next tech inherits it. */}
                  {linkedRentalId && (
                    <div className="mt-3 pt-3 border-t border-slate-200">
                      <label className="block text-sm font-semibold text-slate-800 mb-1.5">
                        Person(s) in Charge
                        <span className="ml-2 text-xs font-normal text-slate-500">
                          forepersons on this job — saved to the rental for the next shift
                        </span>
                      </label>
                      {rentalPics.length === 0 && (
                        <p className="text-xs text-slate-500 italic mb-2">No PIC on file yet — add the foreperson(s) you dealt with.</p>
                      )}
                      <div className="space-y-2">
                        {rentalPics.map((pic, idx) => (
                          <div key={pic.id} className="flex flex-wrap gap-2 items-start">
                            <input
                              type="text"
                              value={pic.name}
                              placeholder="Name"
                              onChange={e => setRentalPics(prev => prev.map((p, i) => i === idx ? { ...p, name: e.target.value } : p))}
                              className="flex-1 min-w-[8rem] px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                            <input
                              type="tel"
                              value={pic.phone || ''}
                              placeholder="Phone"
                              onChange={e => setRentalPics(prev => prev.map((p, i) => i === idx ? { ...p, phone: e.target.value } : p))}
                              className="w-32 px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                            <input
                              type="email"
                              value={pic.email || ''}
                              placeholder="Email (optional)"
                              onChange={e => setRentalPics(prev => prev.map((p, i) => i === idx ? { ...p, email: e.target.value } : p))}
                              className="flex-1 min-w-[10rem] px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => setRentalPics(prev => prev.filter((_, i) => i !== idx))}
                              className="px-2 py-1.5 text-slate-400 hover:text-red-600"
                              aria-label="Remove person in charge"
                            >✕</button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => setRentalPics(prev => [...prev, {
                          id: uuidv4(),
                          name: '',
                          phone: '',
                          email: '',
                          addedAt: new Date().toISOString(),
                          addedBy: user?.name || user?.id || undefined,
                        }])}
                        className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-700"
                      >+ Add foreperson</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {serviceType === 'cascade_air' && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Cascade Air work <span className="text-red-500">*</span>
                <span className="ml-2 text-xs font-normal text-slate-500">
                  pick any combination &mdash; New Install is exclusive
                </span>
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {([
                  { value: 'inspection', label: 'Inspection' },
                  { value: 'new_install', label: 'New Install' },
                  { value: 'air_fill', label: 'Air Fill' },
                  { value: 'other_repair', label: 'Other Repair' },
                ] as const).map(s => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => toggleCascadeAirSubtype(s.value)}
                    aria-pressed={cascadeAirSubtypes.has(s.value)}
                    className={cn(
                      'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                      cascadeAirSubtypes.has(s.value)
                        ? 'border-blue-500 bg-blue-50 text-blue-800'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {serviceType === 'gas_detection' && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Monitor Type <span className="text-red-500">*</span>
                <span className="ml-2 text-xs font-normal text-slate-500">pick one (or both for mixed-job — flagged for approval)</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setGasDetectionFixed(v => !v)}
                  aria-pressed={gasDetectionFixed}
                  className={cn(
                    'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                    gasDetectionFixed
                      ? 'border-blue-500 bg-blue-50 text-blue-800'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300',
                  )}
                >Fixed</button>
                <button
                  type="button"
                  onClick={() => setGasDetectionArea(v => !v)}
                  aria-pressed={gasDetectionArea}
                  className={cn(
                    'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                    gasDetectionArea
                      ? 'border-blue-500 bg-blue-50 text-blue-800'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300',
                  )}
                >Area</button>
              </div>
              {gasDetectionFixed && gasDetectionArea && (
                <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  Both selected — this ticket will be flagged for supervisor review.
                </p>
              )}
            </div>
          )}

          <BillingRefsField refs={billingRefs} onChange={setBillingRefs} labels={billingLabels} />

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isCallOut}
              onChange={e => setIsCallOut(e.target.checked)}
              className="w-4 h-4 accent-blue-600"
            />
            <span className="text-sm font-medium text-slate-700">Emergency Call-out</span>
            <span className="text-xs text-slate-500">adds $150 call-out fee to invoice</span>
          </label>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Service Date</label>
            <input
              type="date"
              value={serviceDate}
              onChange={e => setServiceDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Dispatch Notes <span className="text-slate-400">(optional)</span></label>
            <textarea
              value={dispatchNotes}
              onChange={e => setDispatchNotes(e.target.value)}
              placeholder="Dispatch notes or instructions..."
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
            />
          </div>

          {/* Linked rental dropdown — only shows when customer has active rentals,
              and skipped here when Manned Trailer hoisted its own picker above. */}
          {activeRentals.length > 0 && !(serviceType === 'on_site_services' && onSiteSubtype === 'manned_trailer') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Link to Rental <span className="text-slate-400">(optional — for cal visits, service calls)</span>
              </label>
              <select
                value={linkedRentalId || ''}
                onChange={e => {
                  const next = activeRentals.find(r => r.id === e.target.value)
                  if (next) void applyRentalJobToWizard(next, 'link')
                  else setLinkedRentalId(null)
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
              >
                <option value="">None</option>
                {activeRentals.map(r => (
                  <option key={r.id} value={r.id}>
                    {rentalJobOptionLabel(r)}
                  </option>
                ))}
              </select>
              {linkedRentalId && (
                <p className="text-xs text-blue-600 mt-1">
                  Charges from this ticket will be pulled into the rental's next invoice.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* FIELD SERVICE: Line Items                                    */}
      {/* ============================================================ */}
      {currentStepId === 'line_items' && (
        <div className="space-y-6">
          {/* Cascade Air sub-flows — inspection uses the full editor; the
              other three are lightweight inline forms above the standard
              line items. */}
          {(serviceType === 'cascade_air' || d3HasAir) && cascadeAirSubtypes.has('inspection') && (
            <AirSystemInspectionEditor records={airSystemRecords} onChange={setAirSystemRecords} wellIds={location.wells.map(w => w.id)} padId={location.pad?.id} />
          )}
          {serviceType === 'inspection' && (
            <FieldInspectionCapture records={inspectionRecords} onChange={setInspectionRecords} ticketId={offlineId} />
          )}
          {(serviceType === 'cascade_air' || d3HasAir) && cascadeAirSubtypes.has('air_fill') && (
            <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Wind className="w-4 h-4" /> On-site Fill
              </h3>
              <p className="text-xs text-slate-500">
                Inspection went out, system was fine, just topped off the cylinders.
                Record start/end pressure + the cylinder serial. (Shop fills — customer
                brings their own tank in — use the standalone <em>Air Fill</em> work type instead.)
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Start PSI *</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={airFillArrivePsi}
                    onChange={e => setAirFillArrivePsi(e.target.value)}
                    placeholder="e.g. 1500"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">End PSI *</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={airFillDepartPsi}
                    onChange={e => setAirFillDepartPsi(e.target.value)}
                    placeholder="e.g. 4500"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Cylinder Serial *</label>
                <input
                  type="text"
                  value={cascadeAirCylinderSerial}
                  onChange={e => setCascadeAirCylinderSerial(e.target.value)}
                  placeholder="Cylinder serial number"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
            </div>
          )}
          {serviceType === 'cascade_air' && cascadeAirSubtypes.has('new_install') && (
            <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700">New Install</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Each system below becomes a work point at this location for future calibration / inspection visits.
                    Add labor + parts as line items below for billing.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setNewInstallSystems(prev => [...prev, blankNewInstallSystem()])}
                  className="shrink-0 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
                >
                  + Add system
                </button>
              </div>

              <div className="space-y-3">
                {newInstallSystems.map((system, systemIdx) => (
                  <div key={system.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">System {systemIdx + 1}</h4>
                      <button
                        type="button"
                        onClick={() => setNewInstallSystems(prev => prev.filter(s => s.id !== system.id))}
                        disabled={newInstallSystems.length === 1}
                        className="text-xs font-medium text-slate-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        Remove
                      </button>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-500 mb-1">System name *</label>
                      <input
                        type="text"
                        value={system.workPointName}
                        onChange={e => updateNewInstallSystem(system.id, { workPointName: e.target.value })}
                        placeholder="e.g. Tank Battery #2"
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-slate-500 mb-1">System type *</label>
                      <select
                        value={system.airSystemType}
                        onChange={e => updateNewInstallSystem(system.id, { airSystemType: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                      >
                        <option value="tank_battery">Tank Battery</option>
                        <option value="oil_tank_battery">Oil Tank Battery</option>
                        <option value="compressor">Compressor</option>
                        <option value="swd_facility">SWD Facility</option>
                        <option value="gas_plant">Gas Plant</option>
                        <option value="other">Other</option>
                      </select>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Reel serial</label>
                        <input
                          type="text"
                          value={system.reelSerialNumber}
                          onChange={e => updateNewInstallSystem(system.id, { reelSerialNumber: e.target.value })}
                          placeholder="optional"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Stand serial</label>
                        <input
                          type="text"
                          value={system.standSerialNumber}
                          onChange={e => updateNewInstallSystem(system.id, { standSerialNumber: e.target.value })}
                          placeholder="optional"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Regulator serial</label>
                        <input
                          type="text"
                          value={system.regulatorSerial}
                          onChange={e => updateNewInstallSystem(system.id, { regulatorSerial: e.target.value })}
                          placeholder="optional"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-xs text-slate-500">Cylinders</label>
                        <button
                          type="button"
                          onClick={() => updateNewInstallSystem(system.id, { cylinders: [...system.cylinders, blankCylinder()] })}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          + Add bottle
                        </button>
                      </div>
                      <div className="space-y-2">
                        {system.cylinders.map((cyl, idx) => (
                          <div
                            key={idx}
                            className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end rounded-md border border-slate-200 bg-white p-2"
                          >
                            <div>
                              {idx === 0 && <label className="block text-[10px] text-slate-400 mb-0.5">Serial #</label>}
                              <input
                                type="text"
                                value={cyl.serialNumber}
                                onChange={e => updateNewInstallCylinder(system.id, idx, { serialNumber: e.target.value })}
                                placeholder={`Bottle ${idx + 1}`}
                                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                              />
                            </div>
                            <div>
                              {idx === 0 && <label className="block text-[10px] text-slate-400 mb-0.5">Hydro</label>}
                              <input
                                type="date"
                                value={cyl.hydroDate}
                                onChange={e => updateNewInstallCylinder(system.id, idx, { hydroDate: e.target.value })}
                                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                              />
                            </div>
                            <div>
                              {idx === 0 && <label className="block text-[10px] text-slate-400 mb-0.5">Expiry</label>}
                              <input
                                type="date"
                                value={cyl.expiryDate}
                                onChange={e => updateNewInstallCylinder(system.id, idx, { expiryDate: e.target.value })}
                                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => updateNewInstallSystem(system.id, { cylinders: system.cylinders.filter((_, i) => i !== idx) })}
                              disabled={system.cylinders.length === 1}
                              className="text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-xs px-1.5 py-1.5"
                              aria-label="Remove bottle"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">Hydro / expiry can be left blank and filled in on the first inspection visit.</p>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Install notes</label>
                      <textarea
                        value={system.installDescription}
                        onChange={e => updateNewInstallSystem(system.id, { installDescription: e.target.value })}
                        placeholder="e.g. Ran 50ft hose, mounted alarm on the south wall. Cust contact was Joe."
                        rows={3}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none bg-white"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(serviceType === 'cascade_air' || d3HasAir) && cascadeAirSubtypes.has('other_repair') && (
            <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700">Other Repair / Service</h3>
              <p className="text-xs text-slate-500">Describe the repair. Add labor/parts/mileage as line items below.</p>
              <textarea
                value={cascadeAirOtherDescription}
                onChange={e => setCascadeAirOtherDescription(e.target.value)}
                placeholder="What was repaired, what was done"
                rows={4}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
              />
            </div>
          )}

          {/* On-Site Services sub-flows */}
          {serviceType === 'on_site_services' && onSiteSubtype === 'other' && (
            <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700">Other on-site service</h3>
              <p className="text-xs text-slate-500">
                Describe what was done. Add labor / mileage / parts as line items below.
              </p>
              <textarea
                value={onSiteOtherDescription}
                onChange={e => setOnSiteOtherDescription(e.target.value)}
                placeholder="What service was provided"
                rows={4}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
              />
            </div>
          )}

          {serviceType === 'on_site_services' && onSiteSubtype && onSiteSubtype !== 'other' && (
            <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-700">
                  {onSiteSubtype === 'confined_space' && 'Confined Space — Site Log'}
                  {onSiteSubtype === 'manned_trailer' && 'Manned Trailer — Site Log'}
                  {onSiteSubtype === 'bottle_watch' && 'Bottle Watch — Site Log'}
                </h3>
                {/* #A live clock + device timezone — readings are time-stamped */}
                <LiveClock className="text-xs" />
              </div>
              <p className="text-xs text-slate-500">
                {onSiteSubtype === 'manned_trailer'
                  ? "Each entry below mirrors into the linked rental's daily log when you submit. Add one at a time so a sneeze doesn't take down the whole shift."
                  : 'Captures the shift on-site as discrete entries — add one at a time so each is saved as its own line.'}
              </p>

              {/* Read-out, not an input: the window follows the entries. Site
                  Times on the closing step start here and stay editable, since
                  the drive out usually beats the first reading. */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <span className="text-xs font-medium text-slate-500">Shift window</span>
                {onSiteShiftWindow ? (
                  <span className="font-mono text-sm text-slate-800">
                    {onSiteShiftWindow.first} → {onSiteShiftWindow.last}
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">set by your first and last entry</span>
                )}
              </div>

              {/* Entries list */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
                    Entries ({onSiteEntries.length})
                  </label>
                </div>
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-72 overflow-y-auto">
                  {onSiteEntries.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-4">
                      No entries yet — add one below.
                    </p>
                  ) : (
                    [...onSiteEntries]
                      .sort((a, b) => `${a.date || serviceDate}T${a.time}`.localeCompare(`${b.date || serviceDate}T${b.time}`))
                      .map(e => (
                        <div key={e.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                          <span className="font-mono text-xs text-slate-500 shrink-0 pt-0.5">{e.date || serviceDate}<br />{e.time}</span>
                          <span className={cn(
                            'shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded',
                            e.type === 'h2s' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600',
                          )}>
                            {e.type === 'h2s' ? 'H₂S' : 'Note'}
                          </span>
                          <span className="flex-1 text-slate-800">
                            {e.text}
                            {e.type === 'h2s' && e.ppm != null && (
                              <span className="ml-2 text-amber-700 font-semibold">{e.ppm} PPM</span>
                            )}
                            {e.type === 'h2s' && e.location && (
                              <span className="ml-1 text-slate-500">@ {e.location}</span>
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => setOnSiteEntries(prev => prev.filter(x => x.id !== e.id))}
                            className="text-slate-400 hover:text-red-600 shrink-0 text-xs px-1"
                            aria-label="Remove entry"
                          >
                            ✕
                          </button>
                        </div>
                      ))
                  )}
                </div>
              </div>

              {/* Add entry */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-slate-600">Add entry:</span>
                  <button
                    type="button"
                    onClick={() => setEntryDraftType('note')}
                    className={cn(
                      'px-2.5 py-1 rounded border text-xs font-medium transition-colors',
                      entryDraftType === 'note'
                        ? 'border-blue-500 bg-blue-50 text-blue-800'
                        : 'border-slate-300 text-slate-600 hover:border-slate-400',
                    )}
                  >
                    Note
                  </button>
                  <button
                    type="button"
                    onClick={() => setEntryDraftType('h2s')}
                    className={cn(
                      'px-2.5 py-1 rounded border text-xs font-medium transition-colors',
                      entryDraftType === 'h2s'
                        ? 'border-amber-500 bg-amber-50 text-amber-800'
                        : 'border-slate-300 text-slate-600 hover:border-slate-400',
                    )}
                  >
                    H₂S Reading
                  </button>
                  <input
                    type="date"
                    aria-label="Entry date"
                    value={entryDraftDate || serviceDate}
                    onChange={e => setEntryDraftDate(e.target.value)}
                    className="ml-auto px-2 py-1 border border-slate-300 rounded text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                  />
                  <input
                    type="time"
                    aria-label="Entry time"
                    value={entryDraftTime}
                    onChange={e => setEntryDraftTime(e.target.value)}
                    className="px-2 py-1 border border-slate-300 rounded text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const d = new Date()
                      setEntryDraftDate(isoToLocalInput(d.toISOString()).slice(0, 10))
                      setEntryDraftTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
                    }}
                    className="px-2 py-1 text-xs text-slate-500 hover:text-slate-800 border border-slate-300 rounded hover:bg-white"
                  >
                    now
                  </button>
                </div>

                {entryDraftType === 'note' ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={entryDraftText}
                      onChange={e => setEntryDraftText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        ;(document.getElementById('on-site-add-entry-btn') as HTMLButtonElement | null)?.click()
                      }}
                      placeholder="What happened, what changed..."
                      className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                    />
                    <button
                      id="on-site-add-entry-btn"
                      type="button"
                      onClick={() => {
                        if (!entryDraftText.trim()) return
                        const now = new Date()
                        const time = entryDraftTime || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
                        setOnSiteEntries(prev => [...prev, {
                          id: uuidv4(), date: entryDraftDate || serviceDate, time, type: 'note', text: entryDraftText.trim(), createdAt: now.toISOString(),
                        }])
                        setEntryDraftText('')
                        setEntryDraftTime('')
                      }}
                      className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700"
                    >
                      Add
                    </button>
                  </div>
                ) : (
                  /* #B H2S: enter several PPM+Location readings at once; one Add
                     fans them out into individual entries (each still one reading). */
                  <div className="space-y-2">
                    <datalist id="h2s-locations">
                      <option value="Treater" />
                      <option value="Cellar" />
                      <option value="Flowline" />
                      <option value="Shale Shaker" />
                      <option value="Tank Battery" />
                      <option value="Tubing" />
                      <option value="Casing" />
                    </datalist>
                    {h2sRows.map((row, idx) => (
                      <div key={row.id} className="flex flex-wrap gap-2 items-center">
                        <input
                          type="number"
                          step="0.1"
                          inputMode="decimal"
                          value={row.ppm}
                          onChange={e => setH2sRows(rows => rows.map((r, i) => i === idx ? { ...r, ppm: e.target.value } : r))}
                          placeholder="PPM *"
                          className="w-24 px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none bg-white"
                        />
                        <input
                          type="text"
                          value={row.location}
                          onChange={e => setH2sRows(rows => rows.map((r, i) => i === idx ? { ...r, location: e.target.value } : r))}
                          placeholder="Location (Treater, Cellar, …)"
                          list="h2s-locations"
                          className="flex-1 min-w-[8rem] px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none bg-white"
                        />
                        <input
                          type="text"
                          value={row.note}
                          onChange={e => setH2sRows(rows => rows.map((r, i) => i === idx ? { ...r, note: e.target.value } : r))}
                          placeholder="Note (optional)"
                          className="flex-1 min-w-[7rem] px-2 py-1.5 border border-slate-200 rounded text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none bg-white"
                        />
                        <button
                          type="button"
                          onClick={() => setH2sRows(rows => rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows)}
                          disabled={h2sRows.length === 1}
                          className="text-slate-400 hover:text-red-600 disabled:opacity-30 px-1 text-sm"
                          aria-label="Remove reading"
                        >✕</button>
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setH2sRows(rows => [...rows, { id: uuidv4(), ppm: '', location: '', note: '' }])}
                        className="text-xs font-medium text-amber-700 hover:text-amber-800"
                      >+ add another reading</button>
                      <button
                        id="on-site-add-entry-btn"
                        type="button"
                        onClick={() => {
                          const valid = h2sRows.filter(r => r.ppm.trim())
                          if (valid.length === 0) return
                          const now = new Date()
                          const time = entryDraftTime || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
                          const newEntries: OnSiteEntry[] = valid.map(r => ({
                            id: uuidv4(),
                            date: entryDraftDate || serviceDate,
                            time,
                            type: 'h2s',
                            text: r.note.trim(),
                            createdAt: now.toISOString(),
                            ppm: r.ppm ? parseFloat(r.ppm) : null,
                            location: r.location.trim() || undefined,
                          }))
                          setOnSiteEntries(prev => [...prev, ...newEntries])
                          setH2sRows([{ id: uuidv4(), ppm: '', location: '', note: '' }])
                          setEntryDraftTime('')
                        }}
                        className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700"
                      >
                        {(() => { const n = h2sRows.filter(r => r.ppm.trim()).length; return n > 1 ? `Add ${n} readings` : 'Add' })()}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {d3HasIh && selectedIhSubtypes.length > 0 && (
            <div className="space-y-8">
              {selectedIhSubtypes.map((st, i) => (
                <IhTestingEditor
                  key={st}
                  records={ihTestRecords.filter(r => r.testType === st)}
                  onChange={recs => setIhTestRecords(prev => [...prev.filter(r => r.testType !== st), ...recs])}
                  testType={st}
                  defaultEmployer={customer?.name}
                  isCallOut={i === 0 ? isCallOut : undefined}
                />
              ))}
            </div>
          )}

          {/* Gas Detection: monitors editor + standard line items */}
          {(serviceType === 'gas_detection' || d3HasGas) ? (
            <>
              <div>
                <h3 className="text-sm font-semibold text-slate-700 mb-2">Monitors serviced</h3>
                <p className="text-xs text-slate-500 mb-3">
                  Each monitor below becomes one line item on the customer invoice.
                </p>
                <GasDetectionEditor records={gasDetectionRecords} onChange={setGasDetectionRecords} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-700 mb-2">Other charges <span className="text-slate-400 font-normal">(labor, mileage, parts)</span></h3>
                <LineItemEditor items={lineItems} onChange={setLineItems} serviceType={serviceType || 'gas_detection'} division={pickerDivision} priceLevels={priceLevels} />
              </div>
            </>
          ) : (
            <>
              {(serviceType === 'cascade_air' || d3HasAir) && (
                // The inspection editor records what was FOUND; it says nothing
                // about hours driven or miles run, and the inspection itself is
                // usually its own charge. This editor used to be hidden on a
                // pure inspection, which left the seeded labor + mileage stuck
                // at qty 1 with no way to correct them.
                <h3 className="text-sm font-semibold text-slate-700">Charges <span className="text-slate-400 font-normal">(inspection, labor, mileage, parts, fill fee)</span></h3>
              )}
              <LineItemEditor items={lineItems} onChange={setLineItems} serviceType={serviceType} division={pickerDivision} priceLevels={priceLevels} />
            </>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* FIELD SERVICE: Wrap Up                                       */}
      {/* ============================================================ */}
      {currentStepId === 'wrap_up' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-3 flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Summary
            </h3>
            <div className="space-y-2 text-sm">
              <p><span className="text-slate-500">Customer:</span> <span className="font-medium">{customer?.name}</span></p>
              <p><span className="text-slate-500">Location:</span> <span className="font-medium">
                {[location.pad?.name, wellsDisplayLabel()].filter(Boolean).join(' > ')}
              </span></p>
              <p><span className="text-slate-500">Service:</span> <span className="font-medium">{serviceType.replace('_', ' ')}</span></p>
              <p><span className="text-slate-500">Date:</span> <span className="font-medium">{serviceDate}</span></p>
              <p><span className="text-slate-500">Items:</span> <span className="font-medium">
                {serviceType === 'cascade_air' && cascadeAirSubtypes.size > 0
                  ? (() => {
                      const parts: string[] = []
                      if (cascadeAirSubtypes.has('inspection')) {
                        parts.push(`${airSystemRecords.length} inspection${airSystemRecords.length !== 1 ? 's' : ''}`)
                      }
                      if (cascadeAirSubtypes.has('air_fill')) {
                        parts.push(`fill ${airFillArrivePsi || '?'}→${airFillDepartPsi || '?'} PSI`)
                      }
                      if (cascadeAirSubtypes.has('new_install')) {
                        parts.push('new install')
                      }
                      if (cascadeAirSubtypes.has('other_repair')) {
                        parts.push('other repair')
                      }
                      const summary = parts.join(' + ')
                      return `${summary}${lineItems.length ? ` (${lineItems.length} line${lineItems.length !== 1 ? 's' : ''})` : ''}`
                    })()
                  : serviceType === 'on_site_services' && onSiteSubtype === 'other'
                  ? `Other on-site (${lineItems.length} line${lineItems.length !== 1 ? 's' : ''})`
                  : serviceType === 'on_site_services' && onSiteSubtype
                  ? `${onSiteSubtype.replace('_', ' ')} · ${onSiteEntries.length} ${onSiteEntries.length === 1 ? 'entry' : 'entries'}${onSiteShiftWindow ? ` · ${onSiteShiftWindow.first} → ${onSiteShiftWindow.last}` : ''}${lineItems.length ? ` + ${lineItems.length} line${lineItems.length !== 1 ? 's' : ''}` : ''}`
                  : serviceType === 'gas_detection'
                  ? `${gasDetectionRecords.length} monitor${gasDetectionRecords.length !== 1 ? 's' : ''}${lineItems.length ? ` + ${lineItems.length} other line${lineItems.length !== 1 ? 's' : ''}` : ''}`
                  : `${lineItems.length} line items`}
              </span></p>
              {poNumber && <p><span className="text-slate-500">PO/AFE:</span> <span className="font-medium">{poNumber}</span></p>}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-2">
              {serviceType === 'cascade_air' ? 'Air System Inspections' : 'Line Items'}
            </h3>
            <div className="space-y-1">
              {serviceType === 'cascade_air' ? (
                airSystemRecords.map((rec, i) => (
                  <div key={rec.id} className="flex items-center gap-2 text-sm py-1">
                    <span className="text-slate-400 font-mono w-5">{i + 1}.</span>
                    <span className="flex-1">{rec.workPointName || 'Unnamed System'} — {rec.airSystemType.replace('_', ' ')}</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      rec.overallResult === 'pass' ? 'bg-green-100 text-green-700' :
                      rec.overallResult === 'fail' ? 'bg-red-100 text-red-700' :
                      'bg-amber-100 text-amber-700'
                    }`}>{rec.overallResult === 'needs_service' ? 'Needs Service' : rec.overallResult.toUpperCase()}</span>
                  </div>
                ))
              ) : (
                lineItems.map((item, i) => (
                  <div key={item.id} className="flex items-center gap-2 text-sm py-1">
                    <span className="text-slate-400 font-mono w-5">{i + 1}.</span>
                    <span className="flex-1">{item.description}</span>
                    <span className="text-slate-500">x{item.quantity}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <SiteTimesCard
            arrivedAt={arrivedAt} departedAt={departedAt}
            onArrivedChange={setArrivedAtManual} onDepartedChange={setDepartedAtManual}
            onUseLogTimes={serviceType === 'on_site_services' && onSiteSubtype !== 'other' && onSiteShiftWindow ? useLogSiteTimes : undefined}
          />

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Work Notes</label>
            <textarea
              value={workNotes}
              onChange={e => setWorkNotes(e.target.value)}
              placeholder="Any additional notes..."
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Photos</label>
            <PhotoCapture photos={photos} onChange={setPhotos} />
          </div>

          <SignaturePad value={signature} onChange={setSignature} />
        </div>
      )}

      {/* ============================================================ */}
      {/* AIR FILL: Customer & Truck                                   */}
      {/* ============================================================ */}
      {currentStepId === 'af_customer' && (
        <div className="space-y-6">
          <CustomerSearch value={customer} onChange={setCustomer} />
          <CustomerFlagBanners creditHold={customerCreditHold} cashCcOnly={customerCashCcOnly} priceLevel={priceLevel} />

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Truck / Unit ID
            </label>
            <input
              type="text"
              value={airFillLocationText}
              onChange={e => setAirFillLocationText(e.target.value)}
              placeholder="e.g. B&G truck 321"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            <p className="text-xs text-slate-400 mt-1">Truck name, unit number, or where the fill happened</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Driver Name
            </label>
            <input
              type="text"
              value={driverName}
              onChange={e => setDriverName(e.target.value)}
              placeholder="e.g. John Smith"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>

          <BillingRefsField refs={billingRefs} onChange={setBillingRefs} labels={billingLabels} />
        </div>
      )}

      {/* ============================================================ */}
      {/* AIR FILL: Confirm                                            */}
      {/* ============================================================ */}
      {currentStepId === 'af_confirm' && (
        <div className="space-y-6">
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 text-center">
            <Wind className="w-10 h-10 mx-auto text-blue-600 mb-2" />
            <h3 className="font-bold text-blue-900 text-lg">Breathing Air Fill</h3>
            <p className="text-blue-700 text-sm mt-1">{customer?.name}</p>
            {airFillLocationText && (
              <p className="text-blue-600 text-sm">{airFillLocationText}</p>
            )}
            {driverName && (
              <p className="text-blue-600 text-sm">{driverName}</p>
            )}
          </div>

          {/* ADR-0017: division came from the path — Dickinson on/off only. */}
          {division && (
            <DivisionSelector
              division={division}
              isDickinson={isDickinson}
              onChange={(d, dickinson) => { setDivision(d); setIsDickinson(dickinson) }}
              fixedDivision={division}
            />
          )}


          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Arrive PSI <span className="text-red-500">*</span></label>
              <input
                type="number"
                inputMode="numeric"
                value={airFillArrivePsi}
                onChange={e => setAirFillArrivePsi(e.target.value)}
                placeholder="e.g. 2200"
                className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-lg font-semibold focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Depart PSI <span className="text-red-500">*</span></label>
              <input
                type="number"
                inputMode="numeric"
                value={airFillDepartPsi}
                onChange={e => setAirFillDepartPsi(e.target.value)}
                placeholder="e.g. 4500"
                className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-lg font-semibold focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
          </div>
          {(!airFillArrivePsi || !airFillDepartPsi) && (
            <p className="text-xs text-amber-600">Both PSI readings are required to continue.</p>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Service Date</label>
            <input
              type="date"
              value={serviceDate}
              onChange={e => setServiceDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* AIR FILL: Billing / Line Items                               */}
      {/* ============================================================ */}
      {currentStepId === 'af_line_items' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-1">Billing</h3>
            <p className="text-sm text-slate-500">Labor and mileage are pre-filled — edit the hours, miles, and rates, or add parts. The air-fill line tracks the PSI readings automatically.</p>
          </div>
          <LineItemEditor items={lineItems} onChange={setLineItems} division={pickerDivision} priceLevels={priceLevels} />
        </div>
      )}

      {/* ============================================================ */}
      {/* AIR FILL: Wrap Up                                            */}
      {/* ============================================================ */}
      {currentStepId === 'af_wrap_up' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-3 flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Summary
            </h3>
            <div className="space-y-2 text-sm">
              <p><span className="text-slate-500">Customer:</span> <span className="font-medium">{customer?.name}</span></p>
              {airFillLocationText && (
                <p><span className="text-slate-500">Truck/Unit:</span> <span className="font-medium">{airFillLocationText}</span></p>
              )}
              {driverName && (
                <p><span className="text-slate-500">Driver:</span> <span className="font-medium">{driverName}</span></p>
              )}
              <p><span className="text-slate-500">Date:</span> <span className="font-medium">{serviceDate}</span></p>
              <p><span className="text-slate-500">PSI:</span> <span className="font-medium">{airFillArrivePsi} → {airFillDepartPsi}</span></p>
              {poNumber && <p><span className="text-slate-500">PO/AFE:</span> <span className="font-medium">{poNumber}</span></p>}
            </div>
          </div>

          <SiteTimesCard arrivedAt={arrivedAt} departedAt={departedAt} onArrivedChange={setArrivedAtManual} onDepartedChange={setDepartedAtManual} />

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <textarea
              value={workNotes}
              onChange={e => setWorkNotes(e.target.value)}
              placeholder="Any additional notes..."
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
            />
          </div>

          <SignaturePad value={signature} onChange={setSignature} />
        </div>
      )}

      {/* ============================================================ */}
      {/* OCC HEALTH: Setup (company + services + in-house/on-site)    */}
      {/* ============================================================ */}
      {currentStepId === 'ft_setup' && (
        <div className="space-y-6">
          <CustomerSearch value={customer} onChange={setCustomer} />
          <CustomerFlagBanners creditHold={customerCreditHold} cashCcOnly={customerCashCcOnly} priceLevel={priceLevel} />

          {/* #10 Services — Fit Test, Audiometric, or both */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Services <span className="font-normal text-slate-400">— select all performed</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'fit_test' as const, label: 'Fit Test', description: 'Respirator fit testing' },
                { key: 'audiometric' as const, label: 'Audiometric', description: 'Hearing test — baseline / retest' },
              ]).map(svc => {
                const selected = occServices.has(svc.key)
                return (
                  <button
                    key={svc.key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      const next = new Set(occServices)
                      if (selected) {
                        if (next.size === 1) return // at least one service
                        next.delete(svc.key)
                      } else {
                        next.add(svc.key)
                      }
                      setOccServices(next)
                    }}
                    className={cn(
                      'p-4 rounded-lg border-2 text-left transition-colors',
                      selected
                        ? 'border-blue-500 bg-blue-50 text-blue-800'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-sm">{svc.label}</p>
                      {selected && <Check className="w-4 h-4 text-blue-600" />}
                    </div>
                    <p className="text-xs mt-0.5 opacity-75">{svc.description}</p>
                  </button>
                )
              })}
            </div>
          </div>

          {/* #10 In-house vs on-site (+ mileage) */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Where</label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { val: false, label: 'In-House', description: 'At the shop' },
                { val: true, label: 'On-Site', description: "At the customer's location" },
              ]).map(o => (
                <button
                  key={String(o.val)}
                  type="button"
                  onClick={() => setOccOnSite(o.val)}
                  className={cn(
                    'p-3 rounded-lg border-2 text-left transition-colors',
                    occOnSite === o.val
                      ? 'border-blue-500 bg-blue-50 text-blue-800'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300',
                  )}
                >
                  <p className="font-medium text-sm">{o.label}</p>
                  <p className="text-xs mt-0.5 opacity-75">{o.description}</p>
                </button>
              ))}
            </div>
            {occOnSite && (
              <div className="mt-2 flex items-center gap-2">
                <label className="text-sm text-slate-600">Mileage</label>
                <input
                  type="number"
                  min={0}
                  value={occMileage}
                  onChange={e => setOccMileage(e.target.value)}
                  placeholder="miles"
                  className="w-28 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
                <span className="text-xs text-slate-400">for billing — optional</span>
              </div>
            )}
          </div>

          {occOnSite && (
            <LocationPicker
              companyId={customer?.id || null}
              value={location}
              onChange={setLocation}
            />
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Service Date</label>
            <input
              type="date"
              value={serviceDate}
              onChange={e => setServiceDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>

          <BillingRefsField refs={billingRefs} onChange={setBillingRefs} labels={billingLabels} />
        </div>
      )}

      {/* ============================================================ */}
      {/* OCC HEALTH: Records                                          */}
      {/* ============================================================ */}
      {currentStepId === 'ft_records' && (
        <FitTestEditor
          records={fitTestRecords}
          onChange={setFitTestRecords}
          defaultEmployer={customer?.name}
          services={occServicesArr}
        />
      )}

      {/* ============================================================ */}
      {/* OCC HEALTH: Billing / Line Items                             */}
      {/* ============================================================ */}
      {currentStepId === 'ft_line_items' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-1">Billing</h3>
            <p className="text-sm text-slate-500">Labor is pre-filled — edit the hours and rate, or add fees and parts. On-site mileage is billed from the mileage you entered on the first step.</p>
          </div>
          <LineItemEditor items={lineItems} onChange={setLineItems} division={pickerDivision} priceLevels={priceLevels} />
        </div>
      )}

      {/* ============================================================ */}
      {/* OCC HEALTH: Wrap Up                                          */}
      {/* ============================================================ */}
      {currentStepId === 'ft_wrap_up' && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-3 flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Occ Health Summary
            </h3>
            <div className="space-y-2 text-sm">
              <p><span className="text-slate-500">Customer:</span> <span className="font-medium">{customer?.name}</span></p>
              <p><span className="text-slate-500">Services:</span> <span className="font-medium">
                {occServicesArr.map(s => s === 'fit_test' ? 'Fit Test' : 'Audiometric').join(' + ')}
                {' '}({occOnSite ? `On-Site${occMileage ? ` — ${occMileage} mi` : ''}` : 'In-House'})
              </span></p>
              {(location.pad || location.wells.length > 0) && (
                <p><span className="text-slate-500">Location:</span> <span className="font-medium">
                  {[location.pad?.name, wellsDisplayLabel()].filter(Boolean).join(' > ')}
                </span></p>
              )}
              <p><span className="text-slate-500">Date:</span> <span className="font-medium">{serviceDate}</span></p>
              <p>
                <span className="text-slate-500">Tested:</span>{' '}
                <span className="font-medium">{fitTestRecords.length} people</span>
                {fitTestRecords.filter(r => r.includesFitTest !== false && r.passFail === 'pass').length > 0 && (
                  <span className="ml-2 text-green-600 font-medium">
                    {fitTestRecords.filter(r => r.includesFitTest !== false && r.passFail === 'pass').length} pass
                  </span>
                )}
                {fitTestRecords.filter(r => r.includesFitTest !== false && r.passFail === 'fail').length > 0 && (
                  <span className="ml-2 text-red-600 font-medium">
                    {fitTestRecords.filter(r => r.includesFitTest !== false && r.passFail === 'fail').length} fail
                  </span>
                )}
              </p>
              {poNumber && <p><span className="text-slate-500">PO/AFE:</span> <span className="font-medium">{poNumber}</span></p>}
            </div>
          </div>

          {/* People tested */}
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-2">People Tested</h3>
            <div className="space-y-1">
              {fitTestRecords.map((rec, i) => (
                <div key={rec.id} className="flex items-center gap-2 text-sm py-1">
                  <span className="text-slate-400 font-mono w-5">{i + 1}.</span>
                  <span className="flex-1">{rec.employeeName}</span>
                  {rec.includesAudiometric && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 capitalize">
                      {rec.audiometricResult || 'audio'}
                    </span>
                  )}
                  {rec.includesFitTest !== false && (
                    <span className={cn(
                      'text-xs font-medium px-2 py-0.5 rounded-full',
                      rec.passFail === 'pass' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700',
                    )}>
                      {rec.passFail === 'pass' ? 'PASS' : 'FAIL'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* #11 Daily calibration results — once per roster */}
          {occServices.has('audiometric') && (
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <h3 className="font-medium text-slate-900 mb-1">Daily Calibration Results</h3>
              <p className="text-xs text-slate-500 mb-2">Audiometer daily calibration — one attachment covers the whole roster.</p>
              {occDailyCalFiles.map(f => (
                <div key={f.id} className="flex items-center gap-2 text-sm text-slate-700 py-1">
                  <span className="flex-1 truncate">{f.fileName}</span>
                  <button
                    type="button"
                    onClick={() => setOccDailyCalFiles(prev => prev.filter(x => x.id !== f.id))}
                    className="text-slate-400 hover:text-red-500"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 mt-1 rounded-lg border border-dashed border-slate-300 text-sm text-slate-600 hover:border-blue-400 hover:text-blue-600 cursor-pointer">
                Attach calibration file
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  onChange={e => {
                    const files = Array.from(e.target.files || [])
                    e.target.value = ''
                    files.forEach(file => {
                      const reader = new FileReader()
                      reader.onload = () => {
                        setOccDailyCalFiles(prev => [...prev, {
                          id: `cal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                          fileName: file.name,
                          mimeType: file.type || 'application/octet-stream',
                          dataUrl: String(reader.result),
                        }])
                      }
                      reader.readAsDataURL(file)
                    })
                  }}
                />
              </label>
            </div>
          )}

          <SiteTimesCard arrivedAt={arrivedAt} departedAt={departedAt} onArrivedChange={setArrivedAtManual} onDepartedChange={setDepartedAtManual} />

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <textarea
              value={workNotes}
              onChange={e => setWorkNotes(e.target.value)}
              placeholder="Any additional notes..."
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
            />
          </div>

          {/* Photos */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Photos</label>
            <PhotoCapture photos={photos} onChange={setPhotos} />
          </div>

          {/* Signature */}
          <SignaturePad value={signature} onChange={setSignature} />
        </div>
      )}

      {/* ============================================================ */}
      {/* IH TESTING: Setup                                            */}
      {/* ============================================================ */}
      {currentStepId === 'ih_setup' && (
        <div className="space-y-6">
          <CustomerSearch value={customer} onChange={setCustomer} />
          <CustomerFlagBanners creditHold={customerCreditHold} cashCcOnly={customerCashCcOnly} priceLevel={priceLevel} />

          {/* ADR-0017: division came from the path — Dickinson on/off only. */}
          {division && (
            <DivisionSelector
              division={division}
              isDickinson={isDickinson}
              onChange={(d, dickinson) => { setDivision(d); setIsDickinson(dickinson) }}
              fixedDivision={division}
            />
          )}

          <LocationPicker
            companyId={customer?.id || null}
            value={location}
            onChange={setLocation}
            multiSite
            allActive
          />

          {showsSiteSignEvidence && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
              <div>
                <h3 className="font-medium text-amber-950">
                  Site sign photo {requiresSiteSignEvidence && <span className="text-red-500">*</span>}
                </h3>
                <p className="text-xs text-amber-800 mt-1">
                  {requiresSiteSignEvidence
                    ? 'Required when the location is new, pending review, or not linked to the selected customer. Capture the site sign with GPS enabled.'
                    : 'Optional. This site is already linked to the selected customer in ServicePRO.'}
                </p>
              </div>
              {customerLocationMismatch && selectedLocationOwner && (
                <p className="text-xs font-medium text-amber-900">
                  Site currently belongs to {selectedLocationOwner.name || 'another customer'}; approval will ask whether to assign it to {customer?.name}.
                </p>
              )}
              <PhotoCapture photos={siteSignPhotos} onChange={setSiteSignPhotos} maxPhotos={3} captureLocation />
            </div>
          )}

          {/* #8 IH Subtype Picker — multi-select; each selected type gets its
              own records section on the next step. */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              IH Test Types <span className="font-normal text-slate-400">— select all performed</span>
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {IH_SUBTYPES.map(st => {
                const selected = ihSubtypes.has(st.value)
                return (
                  <button
                    key={st.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      const next = new Set(ihSubtypes)
                      if (selected) {
                        // Deselecting a type discards its records — confirm if any exist.
                        const typed = ihTestRecords.filter(r => r.testType === st.value)
                        if (typed.length > 0 && !confirm(`Remove ${st.label}? ${typed.length} record${typed.length === 1 ? '' : 's'} entered for it will be discarded.`)) return
                        if (typed.length > 0) setIhTestRecords(prev => prev.filter(r => r.testType !== st.value))
                        next.delete(st.value)
                      } else {
                        next.add(st.value)
                      }
                      setIhSubtypes(next)
                      // serviceType mirrors the first selected (legacy single-subtype consumers)
                      const primary = IH_SUBTYPES.map(s => s.value).find(v => next.has(v))
                      setServiceType(primary || '')
                    }}
                    className={cn(
                      'p-4 rounded-lg border-2 text-left transition-colors',
                      selected
                        ? 'border-blue-500 bg-blue-50 text-blue-800'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-sm">{st.label}</p>
                      {selected && <Check className="w-4 h-4 text-blue-600" />}
                    </div>
                    <p className="text-xs mt-0.5 opacity-75">{st.description}</p>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Service Date</label>
            <input
              type="date"
              value={serviceDate}
              onChange={e => setServiceDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>

          <BillingRefsField refs={billingRefs} onChange={setBillingRefs} labels={billingLabels} />

          {/* Call-Out flag for billing */}
          <label className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={isCallOut}
              onChange={e => setIsCallOut(e.target.checked)}
              className="w-5 h-5 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
            />
            <div>
              <p className="font-medium text-sm text-amber-900">Call-Out</p>
              <p className="text-xs text-amber-700">Emergency / not on regular route — adds $150 call-out fee to billing</p>
            </div>
          </label>
        </div>
      )}

      {/* ============================================================ */}
      {/* IH TESTING: Records                                          */}
      {/* ============================================================ */}
      {currentStepId === 'ih_records' && selectedIhSubtypes.length > 0 && (
        <div className="space-y-8">
          {selectedIhSubtypes.map((st, i) => (
            <IhTestingEditor
              key={st}
              records={ihTestRecords.filter(r => r.testType === st)}
              onChange={recs => setIhTestRecords(prev => [...prev.filter(r => r.testType !== st), ...recs])}
              testType={st}
              defaultEmployer={customer?.name}
              isCallOut={i === 0 ? isCallOut : undefined}
            />
          ))}
        </div>
      )}

      {/* ============================================================ */}
      {/* IH TESTING: Additional Line Items (mileage, parts, labor)    */}
      {/* ============================================================ */}
      {currentStepId === 'ih_line_items' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-1">Additional Charges</h3>
            <p className="text-sm text-slate-500">Add mileage, parts, labor, or other line items. Optional — skip if none.</p>
          </div>
          <LineItemEditor items={lineItems} onChange={setLineItems} division={pickerDivision} priceLevels={priceLevels} />
        </div>
      )}

      {/* ============================================================ */}
      {/* IH TESTING: Wrap Up                                          */}
      {/* ============================================================ */}
      {currentStepId === 'ih_wrap_up' && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-3 flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              IH Testing Summary
            </h3>
            <div className="space-y-2 text-sm">
              <p><span className="text-slate-500">Customer:</span> <span className="font-medium">{customer?.name}</span></p>
              {(location.pad || location.wells.length > 0) && (
                <p><span className="text-slate-500">Location:</span> <span className="font-medium">
                  {[location.pad?.name, wellsDisplayLabel()].filter(Boolean).join(' > ')}
                </span></p>
              )}
              <p><span className="text-slate-500">Test Type{selectedIhSubtypes.length > 1 ? 's' : ''}:</span> <span className="font-medium">
                {selectedIhSubtypes.map(v => IH_SUBTYPES.find(s => s.value === v)?.label || v).join(', ') || '—'}
              </span></p>
              <p><span className="text-slate-500">Date:</span> <span className="font-medium">{serviceDate}</span></p>
              <p><span className="text-slate-500">Records:</span> <span className="font-medium">{ihTestRecords.length}</span></p>
              {poNumber && <p><span className="text-slate-500">PO/AFE:</span> <span className="font-medium">{poNumber}</span></p>}
            </div>
          </div>

          <SiteTimesCard arrivedAt={arrivedAt} departedAt={departedAt} onArrivedChange={setArrivedAtManual} onDepartedChange={setDepartedAtManual} />

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <textarea
              value={workNotes}
              onChange={e => setWorkNotes(e.target.value)}
              placeholder="Any additional notes..."
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
            />
          </div>

          {/* Photos */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Photos</label>
            <PhotoCapture photos={photos} onChange={setPhotos} />
          </div>

          {/* Signature */}
          <SignaturePad value={signature} onChange={setSignature} />
        </div>
      )}

      {/* ============================================================ */}
      {/* Training Steps                                               */}
      {/* ============================================================ */}

      {currentStepId === 'tr_setup' && (
        <div className="space-y-6">
          <CustomerSearch value={customer} onChange={setCustomer} />
          <CustomerFlagBanners creditHold={customerCreditHold} cashCcOnly={customerCashCcOnly} priceLevel={priceLevel} />

          {/* ADR-0017: division came from the path — Dickinson on/off only. */}
          {division && (
            <DivisionSelector
              division={division}
              isDickinson={isDickinson}
              onChange={(d, dickinson) => { setDivision(d); setIsDickinson(dickinson) }}
              fixedDivision={division}
            />
          )}

          {/* Trainer Name */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Trainer Name</label>
            <input
              type="text"
              value={trainingTrainerName}
              onChange={e => setTrainingTrainerName(e.target.value)}
              placeholder="Name of trainer / instructor"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Course Type Picker */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Course Type</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {courseOptions.map(ct => (
                <button
                  key={ct.value}
                  type="button"
                  onClick={() => setTrainingCourseName(ct.label)}
                  className={cn(
                    'p-3 rounded-lg border-2 text-sm font-medium text-left transition-colors',
                    trainingCourseName === ct.label
                      ? 'border-blue-500 bg-blue-50 text-blue-800'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300',
                  )}
                >
                  {ct.label}
                </button>
              ))}
            </div>
          </div>

          {/* "Other" free text */}
          {trainingCourseName === 'Other' && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Course Name</label>
              <input
                type="text"
                value={trainingCourseOther}
                onChange={e => setTrainingCourseOther(e.target.value)}
                placeholder="Describe the course..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          )}

          {/* Service Date */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Service Date</label>
            <input
              type="date"
              value={serviceDate}
              onChange={e => setServiceDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* On-site / In-house toggle */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Training Location</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTrainingIsOnSite(false)}
                className={cn(
                  'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                  !trainingIsOnSite
                    ? 'border-blue-500 bg-blue-50 text-blue-800'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300',
                )}
              >
                In-House (Basin Safety)
              </button>
              <button
                type="button"
                onClick={() => setTrainingIsOnSite(true)}
                className={cn(
                  'p-3 rounded-lg border-2 text-sm font-medium transition-colors',
                  trainingIsOnSite
                    ? 'border-blue-500 bg-blue-50 text-blue-800'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300',
                )}
              >
                On-Site
              </button>
            </div>
          </div>

          {/* On-site location — structured picker over the CpLocation address
              book (Basin/Client/Other), replacing the old plain free text */}
          {trainingIsOnSite && (
            <div>
              <TrainingLocationPicker
                value={trainingLocation}
                onChange={loc => {
                  setTrainingLocation(loc)
                  setTrainingLocationText(loc?.name || '')
                }}
              />
              {/* #12 optional mileage for billing */}
              <div className="mt-2 flex items-center gap-2">
                <label className="text-sm text-slate-600">Mileage</label>
                <input
                  type="number"
                  min={0}
                  value={trainingMileage}
                  onChange={e => setTrainingMileage(e.target.value)}
                  placeholder="miles"
                  className="w-28 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
                <span className="text-xs text-slate-400">for billing — optional</span>
              </div>
            </div>
          )}

          {/* PO / AFE / Cost-Code repeater (#3) */}
          <BillingRefsField refs={billingRefs} onChange={setBillingRefs} labels={billingLabels} />
        </div>
      )}

      {currentStepId === 'tr_roster' && (
        <div className="space-y-6">
          {/* #13 QR self-sign-in — students add themselves to this roster from
              their phones. Pass/fail + card issuance stay with the trainer
              below. Hidden once the class is past its open statuses. */}
          {(!isEditMode || ['draft', 'dispatched', 'in_progress'].includes(originalStatus)) && (
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <h3 className="font-medium text-slate-900 mb-1 flex items-center gap-2">
                <QrCode className="w-4 h-4 text-slate-400" />
                Student Sign-In
              </h3>
              <p className="text-xs text-slate-500 mb-3">
                Students scan the QR on their phone and add themselves — name, contact, company.
                Pass/fail and card issuance stay here with you.
              </p>
              {signinQr ? (
                <div className="flex flex-col sm:flex-row items-center gap-4">
                  <img src={signinQr.qrDataUrl} alt="Sign-in QR code" className="w-44 h-44 border border-slate-200 rounded-lg" />
                  <div className="flex-1 min-w-0 space-y-2 text-center sm:text-left">
                    <p className="text-xs font-mono text-slate-500 break-all">{signinQr.url}</p>
                    <div className="flex gap-2 justify-center sm:justify-start">
                      <button
                        type="button"
                        onClick={() => { navigator.clipboard?.writeText(signinQr.url) }}
                        className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50"
                      >
                        Copy link
                      </button>
                      <button
                        type="button"
                        onClick={refreshSignins}
                        disabled={signinRefreshing}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-blue-300 rounded-lg text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                      >
                        <RefreshCw className={cn('w-3.5 h-3.5', signinRefreshing && 'animate-spin')} />
                        Pull in sign-ins
                      </button>
                    </div>
                    {signinNewCount !== null && !signinRefreshing && (
                      <p className="text-xs text-slate-500">
                        {signinNewCount > 0
                          ? `${signinNewCount} new sign-in${signinNewCount === 1 ? '' : 's'} added to the roster below`
                          : 'No new sign-ins yet'}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={openStudentSignin}
                  disabled={signinBusy}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
                >
                  <QrCode className="w-4 h-4" />
                  {signinBusy ? 'Opening…' : 'Open student sign-in (QR)'}
                </button>
              )}
              {signinError && <p className="text-xs text-red-600 mt-2">{signinError}</p>}
            </div>
          )}

          <TrainingClassEditor
            records={trainingRosterRecords}
            onChange={setTrainingRosterRecords}
            defaultEmployer={customer?.name || ''}
            courseName={trainingCourseName === 'Other' ? trainingCourseOther : trainingCourseName}
            cardsOnSite={courseOptions.find(o => o.label === trainingCourseName)?.cardsOnSite}
          />
        </div>
      )}

      {/* ============================================================ */}
      {/* TRAINING: Billing / Line Items                               */}
      {/* ============================================================ */}
      {currentStepId === 'tr_line_items' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-1">Billing</h3>
            <p className="text-sm text-slate-500">Labor is pre-filled — edit the hours and rate, or add per-student course fees and parts. On-site mileage is billed from the mileage you entered on the roster step.</p>
          </div>
          <LineItemEditor items={lineItems} onChange={setLineItems} division={pickerDivision} priceLevels={priceLevels} />
        </div>
      )}

      {currentStepId === 'tr_wrap_up' && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-3 flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Training Summary
            </h3>
            <div className="space-y-2 text-sm">
              <p><span className="text-slate-500">Host Customer:</span> <span className="font-medium">{customer?.name}</span></p>
              {trainingTrainerName && <p><span className="text-slate-500">Trainer:</span> <span className="font-medium">{trainingTrainerName}</span></p>}
              <p><span className="text-slate-500">Course:</span> <span className="font-medium">
                {trainingCourseName === 'Other' ? trainingCourseOther : trainingCourseName}
              </span></p>
              <p><span className="text-slate-500">Date:</span> <span className="font-medium">{serviceDate}</span></p>
              <p><span className="text-slate-500">Location:</span> <span className="font-medium">
                {trainingIsOnSite ? trainingLocationText || 'On-Site' : 'In-House (Basin Safety)'}
              </span></p>
              <p><span className="text-slate-500">Roster:</span> <span className="font-medium">{trainingRosterRecords.length} {trainingRosterRecords.length === 1 ? 'person' : 'people'}</span></p>
              {poNumber && <p><span className="text-slate-500">PO/AFE:</span> <span className="font-medium">{poNumber}</span></p>}
            </div>
          </div>

          {/* Roster grouped by employer */}
          {(() => {
            const grouped = new Map<string, TrainingRosterDraftRecord[]>()
            for (const rec of trainingRosterRecords) {
              const key = rec.employerName || 'Unknown Employer'
              if (!grouped.has(key)) grouped.set(key, [])
              grouped.get(key)!.push(rec)
            }
            return Array.from(grouped.entries()).map(([employer, recs]) => (
              <div key={employer} className="bg-white rounded-lg border border-slate-200 p-4">
                <h3 className="font-medium text-slate-900 mb-2">
                  {employer} <span className="text-slate-400 font-normal">({recs.length})</span>
                </h3>
                <div className="space-y-1">
                  {recs.map((rec, i) => (
                    <div key={rec.id} className="flex items-center gap-2 text-sm py-1">
                      <span className="text-slate-400 font-mono w-5">{i + 1}.</span>
                      <span className="flex-1">{rec.employeeName}</span>
                      <span className={cn(
                        'text-xs font-medium px-2 py-0.5 rounded-full',
                        rec.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700',
                      )}>
                        {rec.passed ? 'PASS' : 'FAIL'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          })()}

          <SiteTimesCard arrivedAt={arrivedAt} departedAt={departedAt} onArrivedChange={setArrivedAtManual} onDepartedChange={setDepartedAtManual} />

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <textarea
              value={workNotes}
              onChange={e => setWorkNotes(e.target.value)}
              placeholder="Any additional notes..."
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
            />
          </div>

          {/* Photos */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Photos</label>
            <PhotoCapture photos={photos} onChange={setPhotos} />
          </div>

          {/* Signature */}
          <SignaturePad value={signature} onChange={setSignature} />
        </div>
      )}

      {/* ============================================================ */}
      {/* START JOB (formerly Rental): pick a dispatched contract       */}
      {/* ============================================================ */}
      {currentStepId === 'rn_setup' && (
        <div className="space-y-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-slate-700">
              <strong>Deploy</strong> — pick the rental contract dispatch already created
              for this customer, then hitch up. You'll add the actual equipment + serials
              on the next step.
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Don't see your rental? Dispatch hits <em>New Rental</em> on the Rentals page
              first. New contracts can't be created from here.
            </p>
          </div>

          {/* ADR-0017: division came from the path — Dickinson on/off only. */}
          {division && (
            <DivisionSelector
              division={division}
              isDickinson={isDickinson}
              onChange={(d, dickinson) => { setDivision(d); setIsDickinson(dickinson) }}
              fixedDivision={division}
            />
          )}


          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Rental job <span className="text-red-500">*</span>
            </label>
            {startJobLoading ? (
              <p className="text-sm text-slate-400 italic">Loading dispatched rentals...</p>
            ) : startJobCandidates.length === 0 ? (
              <div className="px-3 py-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                No scheduled or active rental jobs found. Dispatch needs to create
                a rental job first.
              </div>
            ) : (
              <div className="space-y-2">
                {startJobCandidates.map(r => {
                  const selected = selectedStartJobRentalId === r.id
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => void applyRentalJobToWizard(r, 'start')}
                      className={cn(
                        'w-full text-left p-3 rounded-lg border-2 transition-colors',
                        selected
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-slate-200 bg-white hover:border-slate-300',
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-slate-900">
                          {rentalJobHeader(r)}
                        </span>
                        <span className={cn(
                          'shrink-0 text-xs font-medium px-2 py-0.5 rounded-full',
                          r.status === 'scheduled'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-emerald-100 text-emerald-700',
                        )}>
                          {r.status}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>Customer: {r.companyName || 'Unknown'}</span>
                        <span>Site: {rentalJobSite(r)}</span>
                        <span>Start {formatCalendarDateNumeric(r.startDate)}</span>
                        <span className="capitalize">{r.billingRateType}</span>
                        {r.agreementNumber && <span>RA {r.agreementNumber}</span>}
                        {r.poNumber && <span>PO {r.poNumber}</span>}
                        {r.personCallingName && <span>Caller: {r.personCallingName}</span>}
                        {r.siteContactName && <span>On-site: {r.siteContactName}</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <CustomerSearch value={customer} onChange={setCustomer} />
          <CustomerFlagBanners creditHold={customerCreditHold} cashCcOnly={customerCashCcOnly} priceLevel={priceLevel} />
        </div>
      )}

      {/* ============================================================ */}
      {/* RENTAL: Equipment                                            */}
      {/* ============================================================ */}
      {currentStepId === 'rn_equipment' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Equipment</h2>
            <span className="text-sm text-slate-500">{rentalItems.length} item{rentalItems.length !== 1 ? 's' : ''}</span>
          </div>

          {/* #19 Equipment already on the job (active rentals) */}
          {existingDeployed.length > 0 && (
            <div className="bg-emerald-50/50 border border-emerald-200 rounded-lg p-3 space-y-1">
              <p className="text-sm font-semibold text-emerald-900">Already on this job ({existingDeployed.length})</p>
              {existingDeployed.map(it => (
                <p key={it.id} className="text-xs text-emerald-800">
                  {it.productName} <span className="font-mono opacity-70">{it.serialNumber}</span>
                </p>
              ))}
            </div>
          )}

          {/* #5 Dispatch-ordered composition — scan the spec'd serials per line */}
          {deployComposition && (deployMonitorLines.length > 0 || deployComposition.trailer || (deployComposition.other?.length ?? 0) > 0) && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
              <p className="text-sm font-semibold text-slate-700">Dispatch ordered</p>
              {deployComposition.trailer && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">Trailer ({deployComposition.trailer.manned ? 'Manned' : 'Unmanned'})</span>
                  <span className="text-xs text-slate-400">scan the trailer</span>
                </div>
              )}
              {deployMonitorLines.map(l => (
                <div key={l.id} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{l.label}</span>
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded-full',
                    l.met ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700',
                  )}>
                    {l.scanned} / {l.qty} scanned{l.scanned > l.qty ? ' (extra)' : ''}
                  </span>
                </div>
              ))}
              {(deployComposition.other || []).map(o => (
                <div key={o.id} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{o.qty > 1 ? `${o.qty}× ` : ''}{o.label}</span>
                  <span className="text-xs text-slate-400">scan if serialized</span>
                </div>
              ))}
              {!deployMonitorsMet && (
                <p className="text-xs text-amber-700 pt-1">Doesn't match the dispatch order — you can still continue, but you'll be asked to confirm.</p>
              )}
            </div>
          )}

          {/* Package baseline — what this customer's package covers, counted
              against what's actually been scanned. The tech's job here is to
              see at a glance that the load is right; anything over the baseline
              is called out as billable so nobody is surprised on the invoice. */}
          {deployDiffRows.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">Package baseline</p>
                {deployComposition?.bomPackage?.label && (
                  <span className="text-xs text-slate-400 truncate max-w-[55%]">{deployComposition.bomPackage.label}</span>
                )}
              </div>
              {deployDiffRows.map(r => (
                <div key={r.equipmentCategory} className="flex items-center justify-between text-sm gap-2">
                  <span className="text-slate-700 min-w-0 truncate">{r.label}</span>
                  <span className={cn(
                    'text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0',
                    r.over > 0 ? 'bg-blue-100 text-blue-700'
                      : r.short > 0 ? 'bg-amber-100 text-amber-700'
                      : 'bg-green-100 text-green-700',
                  )}>
                    {r.deployed} / {r.expected}
                    {r.over > 0 ? ` · +${r.over} extra` : r.short > 0 ? ` · ${r.short} short` : ''}
                  </span>
                </div>
              ))}
              {deployExtras.length > 0 && (
                <div className="pt-2 border-t border-slate-100 space-y-1">
                  <p className="text-xs font-medium text-blue-700">Bills on top of the package</p>
                  {deployExtras.map(e => (
                    <div key={e.id} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600 min-w-0 truncate">{e.qty}× {e.label}</span>
                      <span className={cn('flex-shrink-0 font-medium', e.rate == null ? 'text-amber-600' : 'text-slate-700')}>
                        {e.rate == null ? 'rate TBD — office will price' : `$${e.rate.toFixed(2)}/${rateUnitAbbrev(deployRateType)}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {deployShortRows.length > 0 && (
                <div className="pt-2 border-t border-amber-100 space-y-2">
                  <p className="text-xs text-amber-700">
                    Short of the package on {deployShortRows.length} item{deployShortRows.length === 1 ? '' : 's'} — the package still bills in full.
                  </p>
                  <label className="block">
                    <span className="block text-xs font-semibold text-amber-900 mb-1">
                      Reason for short deployment <span className="text-red-500">*</span>
                    </span>
                    <textarea
                      value={deployShortReason}
                      onChange={e => setDeployShortReason(e.target.value)}
                      rows={3}
                      placeholder="Why didn't the full package go out?"
                      className="w-full px-3 py-2 border border-amber-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none text-sm"
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          {/* Equipment list */}
          {rentalItems.length > 0 && (
            <div className="space-y-2">
              {rentalItems.map((item, idx) => (
                <div key={item.id} className="bg-white rounded-lg border border-slate-200 p-4">
                  <div className="flex items-start gap-3">
                    <span className="text-sm font-mono text-slate-400 mt-0.5">{idx + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-slate-900 flex items-center gap-2">
                        {item.productName || 'Unknown Product'}
                        {item.deployInspection && !item.deployInspection.coveredBy && (
                          <span className={cn(
                            'text-[10px] font-semibold px-1.5 py-0.5 rounded-full',
                            item.deployInspection.flagged ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-700',
                          )}>
                            {item.deployInspection.flagged ? 'INSPECTED — FLAGGED' : 'INSPECTED'}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500 font-mono">{item.serialNumber}</p>
                      {item.deployInspection?.flagged && item.deployInspection.notes && (
                        <p className="text-xs text-amber-700 mt-0.5">{item.deployInspection.notes}</p>
                      )}
                      {deployPriced ? (
                        <p className="text-xs text-slate-400 mt-2 italic">Billed via the dispatch order — tracked for return only</p>
                      ) : (
                        <div className="flex items-center gap-2 mt-2">
                          <DollarSign className="w-3 h-3 text-slate-400" />
                          <input
                            type="number"
                            value={item.rate ?? ''}
                            onChange={e => {
                              const val = e.target.value ? parseFloat(e.target.value) : null
                              setRentalItems(prev => prev.map((it, i) => i === idx ? { ...it, rate: val } : it))
                            }}
                            placeholder="Rate"
                            className="w-24 px-2 py-1 border border-slate-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <span className="text-xs text-slate-500">/ {item.rateType || rentalBillingRateType}</span>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setRentalItems(prev => prev.filter((_, i) => i !== idx))}
                      className="p-1 text-slate-400 hover:text-red-500"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add equipment buttons */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setShowEquipmentScanner(true)}
              className="flex-1 flex items-center justify-center gap-2 py-3 border-2 border-dashed border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:border-blue-400 hover:text-blue-600 transition-colors"
            >
              <Package className="w-5 h-5" />
              Add Equipment
            </button>
          </div>

          {rentalItems.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-4">
              Scan or search for equipment to add to this rental agreement.
            </p>
          )}

          {/* Equipment Scanner Modal — allowCreate: a serial not on file can be
              added on the fly (#21); it lands flagged for office review. */}
          {showEquipmentScanner && (
            <EquipmentScanner
              filterStatus="available"
              allowCreate
              onEquipmentFound={async (equip: ScannedEquipment) => {
                // Get the default rate for this product based on billing rate type
                const getRate = (prod: { defaultRentalRateDaily?: number | null; defaultRentalRateWeekly?: number | null; defaultRentalRateMonthly?: number | null }) => {
                  if (rentalBillingRateType === 'daily') return prod.defaultRentalRateDaily ?? null
                  if (rentalBillingRateType === 'weekly') return prod.defaultRentalRateWeekly ?? null
                  if (rentalBillingRateType === 'monthly') return prod.defaultRentalRateMonthly ?? null
                  return null
                }

                // Check for duplicates
                if (rentalItems.some(item => item.serializedEquipmentId === equip.id)) {
                  setShowEquipmentScanner(false)
                  return
                }

                const newItems: OfflineRentalAgreementItem[] = []

                // Add the scanned equipment itself
                newItems.push({
                  id: uuidv4(),
                  rentalAgreementId: '',
                  productId: equip.productId,
                  productName: equip.product.name,
                  serializedEquipmentId: equip.id,
                  serialNumber: equip.serialNumber,
                  rate: getRate(equip.product),
                  rateType: rentalBillingRateType,
                  deployedDate: serviceDate,
                  returnedDate: null,
                  status: 'deployed',
                })

                // Auto-expand assemblies: fetch children from API and add them
                if (equip.product.isAssembly) {
                  try {
                    const childRes = await api.get<{ data: Array<{
                      id: string; serialNumber: string; productId: string; status: string;
                      product: { id: string; partNumber: string; name: string; category: string }
                    }> }>(`/equipment/${equip.id}/children`)
                    for (const child of childRes.data) {
                      if (child.status !== 'available') continue
                      if (rentalItems.some(item => item.serializedEquipmentId === child.id)) continue
                      // Look up child product rates from Dexie
                      const childProd = await db.products.get(child.productId)
                      newItems.push({
                        id: uuidv4(),
                        rentalAgreementId: '',
                        productId: child.productId,
                        productName: child.product.name,
                        serializedEquipmentId: child.id,
                        serialNumber: child.serialNumber,
                        rate: childProd ? getRate(childProd) : null,
                        rateType: rentalBillingRateType,
                        deployedDate: serviceDate,
                        returnedDate: null,
                        status: 'deployed',
                      })
                    }
                  } catch {
                    // Children fetch failed — just add the parent
                  }
                }

                // #20 QA gate: the scanned unit waits for its required
                // inspection before it lands on the job. Children of an
                // assembly are covered by the parent's inspection.
                setShowEquipmentScanner(false)
                setPendingDeploy({
                  items: newItems,
                  category: resolveDeployCategory(equip.product),
                  name: equip.product.name,
                  serial: equip.serialNumber,
                })
              }}
              onClose={() => setShowEquipmentScanner(false)}
            />
          )}

          {/* #20 Required deploy inspection — flagged answers need a note but don't block */}
          {pendingDeploy && (
            <DeployInspectionModal
              equipmentName={pendingDeploy.name}
              serialNumber={pendingDeploy.serial}
              category={pendingDeploy.category}
              inspectedBy={user?.name || null}
              onComplete={result => {
                const [parent, ...children] = pendingDeploy.items
                const stamped: OfflineRentalAgreementItem[] = [
                  { ...parent, deployInspection: result },
                  ...children.map(c => ({
                    ...c,
                    deployInspection: {
                      category: 'general' as const,
                      answers: {},
                      flagged: false,
                      notes: '',
                      inspectedAt: result.inspectedAt,
                      inspectedBy: result.inspectedBy,
                      coveredBy: parent.id,
                    },
                  })),
                ]
                setRentalItems(prev => [...prev, ...stamped])
                setPendingDeploy(null)
              }}
              onCancel={() => setPendingDeploy(null)}
            />
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* RENTAL: Liability Waiver + Site Contact                      */}
      {/* ============================================================ */}
      {currentStepId === 'rn_liability' && (
        <div className="space-y-6">
          {/* Waiver text */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <h3 className="font-semibold text-amber-900 mb-2">Equipment Liability Waiver</h3>
            <p className="text-sm text-amber-800 leading-relaxed">
              By signing below, I acknowledge that I accept full responsibility for the care and
              condition of the rented equipment listed in this agreement. I agree to be liable for
              any damage, loss, or destruction of the equipment beyond normal wear and tear during
              the rental period. I understand that repair or replacement costs will be billed to
              the customer account if equipment is returned in a damaged or non-operational state.
            </p>
          </div>

          {/* Signer name */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Customer Representative Name *</label>
            <input
              type="text"
              value={rentalLiabilitySignedByName}
              onChange={e => setRentalLiabilitySignedByName(e.target.value)}
              placeholder="Full name of person signing"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Acknowledgment checkbox */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={rentalLiabilityAcknowledged}
              onChange={e => setRentalLiabilityAcknowledged(e.target.checked)}
              className="mt-0.5 w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-slate-700">
              I have read and accept the equipment liability waiver above
            </span>
          </label>

          {/* Signature */}
          <SignaturePad
            label="Customer Representative Signature"
            value={rentalLiabilitySignature}
            onChange={setRentalLiabilitySignature}
          />

          {/* Divider */}
          <div className="border-t border-slate-200 pt-4">
            <h3 className="font-medium text-slate-900 mb-3">Site Contact Information</h3>
            <p className="text-xs text-slate-500 mb-3">Who should we contact for on-site equipment issues or questions?</p>

            {/* Same as signer toggle */}
            <label className="flex items-center gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={siteContactSameAsSigner}
                onChange={e => {
                  const checked = e.target.checked
                  setSiteContactSameAsSigner(checked)
                  if (checked) {
                    setRentalSiteContactName(rentalLiabilitySignedByName)
                  }
                }}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-slate-600">Same as signer</span>
            </label>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Name *</label>
                <input
                  type="text"
                  value={rentalSiteContactName}
                  onChange={e => {
                    setRentalSiteContactName(e.target.value)
                    if (siteContactSameAsSigner && e.target.value !== rentalLiabilitySignedByName) {
                      setSiteContactSameAsSigner(false)
                    }
                  }}
                  placeholder="Name"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
                <input
                  type="tel"
                  value={rentalSiteContactPhone}
                  onChange={e => setRentalSiteContactPhone(e.target.value)}
                  placeholder="(701) 555-1234"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input
                  type="email"
                  value={rentalSiteContactEmail}
                  onChange={e => setRentalSiteContactEmail(e.target.value)}
                  placeholder="contact@example.com"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* RENTAL: Review                                               */}
      {/* ============================================================ */}
      {currentStepId === 'rn_review' && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-3 flex items-center gap-2">
              <ClipboardList className="w-4 h-4" />
              Rental Agreement Summary
            </h3>
            <div className="space-y-2 text-sm">
              <p><span className="text-slate-500">Customer:</span> <span className="font-medium">{customer?.name}</span></p>
              {(location.pad || location.wells.length > 0) && (
                <p><span className="text-slate-500">Location:</span> <span className="font-medium">
                  {[location.pad?.name, wellsDisplayLabel()].filter(Boolean).join(' > ')}
                </span></p>
              )}
              <p><span className="text-slate-500">Start Date:</span> <span className="font-medium">{serviceDate}</span></p>
              <p><span className="text-slate-500">Billing:</span> <span className="font-medium capitalize">{rentalBillingRateType}</span></p>
              <p>
                <span className="text-slate-500">Type:</span>{' '}
                <span className={cn('font-medium', rentalIsManned ? 'text-blue-700' : 'text-orange-700')}>
                  {rentalIsManned ? 'Manned' : 'Unmanned'}
                </span>
                {rentalIsRigJob && <span className="ml-2 text-xs px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-medium">Rig Job</span>}
                {rentalMonitorsIncluded && <span className="ml-2 text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-full font-medium">Monitors</span>}
              </p>
              <p><span className="text-slate-500">Equipment:</span> <span className="font-medium">{rentalItems.length} item{rentalItems.length !== 1 ? 's' : ''}</span></p>
              {poNumber && <p><span className="text-slate-500">PO:</span> <span className="font-medium">{poNumber}</span></p>}
              {rentalAfeNumber && <p><span className="text-slate-500">AFE:</span> <span className="font-medium">{rentalAfeNumber}</span></p>}
              {rentalLiabilityAcknowledged && (
                <p><span className="text-slate-500">Liability Waiver:</span>{' '}
                  <span className="font-medium text-green-700">Signed by {rentalLiabilitySignedByName}</span>
                </p>
              )}
              {rentalSiteContactName && (
                <p><span className="text-slate-500">Site Contact:</span>{' '}
                  <span className="font-medium">
                    {rentalSiteContactName}
                    {rentalSiteContactPhone && ` \u00B7 ${rentalSiteContactPhone}`}
                    {rentalSiteContactEmail && ` \u00B7 ${rentalSiteContactEmail}`}
                  </span>
                </p>
              )}
            </div>
          </div>

          {/* Equipment list */}
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900 mb-2">Equipment</h3>
            <div className="space-y-1">
              {rentalItems.map((item, i) => (
                <div key={item.id} className="flex items-center gap-2 text-sm py-1">
                  <span className="text-slate-400 font-mono w-5">{i + 1}.</span>
                  <span className="flex-1">{item.productName} <span className="text-slate-400 font-mono text-xs">({item.serialNumber})</span></span>
                  {item.rate != null && (
                    <span className="text-slate-500">${item.rate}/{item.rateType?.charAt(0) || rentalBillingRateType.charAt(0)}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Notes */}
          {workNotes && (
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <h3 className="font-medium text-slate-900 mb-1">Notes</h3>
              <p className="text-sm text-slate-600">{workNotes}</p>
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* Navigation Footer                                            */}
      {/* ============================================================ */}
      {step > 0 && (
        <div className="flex gap-3 mt-8 pt-4 border-t border-slate-200">
          {/* #5: park an in-progress ticket as a synced draft from ANY step
              once a customer is chosen (server rejects customer-less creates).
              Excluded for the rental flow, which activates an agreement instead
              of creating a normal ticket. */}
          {!isEditMode && step >= 1 && !!customer && workType !== 'rental' && (
            <button
              onClick={handleSaveDraft}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-3 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 transition-colors font-medium disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              Save Draft
            </button>
          )}

          <div className="flex-1" />

          {/* A greyed-out Next with no explanation is a dead end in the field —
              say what's missing. */}
          {currentStepId === 'who_where' && !canAdvance() && (
            <p className="self-center text-xs text-amber-700 text-right max-w-xs">
              {whoWhereBlocker()}
            </p>
          )}
          {currentStepId === 'line_items' && !canAdvance() && (
            <p className="self-center text-xs text-amber-700 text-right max-w-xs">
              {workType === 'd3_combined' ? d3CombinedBlocker() : lineItemsBlocker()}
            </p>
          )}

          {!isLastStep ? (
            <button
              onClick={() => {
                // #5 soft gate: deploying more/less than dispatch ordered is
                // allowed, but only past an explicit "are you sure".
                if (currentStepId === 'rn_equipment' && !confirmDeployMismatch()) return
                setStep(step + 1)
              }}
              disabled={!canAdvance()}
              className={cn(
                'flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors',
                canAdvance()
                  ? 'bg-blue-800 text-white hover:bg-blue-700'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed',
              )}
            >
              Next
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : isEditMode ? (
            <>
              <button
                onClick={() => handleSaveEdit()}
                disabled={saving}
                className="flex items-center gap-2 px-6 py-3 bg-blue-700 text-white rounded-lg hover:bg-blue-600 transition-colors font-medium disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              {['draft', 'dispatched', 'in_progress', 'completed'].includes(originalStatus) && (
                <button
                  onClick={() => handleSaveEdit('supervisor_review')}
                  disabled={saving}
                  className="flex items-center gap-2 px-6 py-3 bg-green-700 text-white rounded-lg hover:bg-green-600 transition-colors font-medium disabled:opacity-50"
                >
                  <Check className="w-5 h-5" />
                  {saving ? 'Saving...' : 'Save & Complete'}
                </button>
              )}
            </>
          ) : workType === 'rental' ? (
            <button
              onClick={submitRentalAgreement}
              disabled={saving}
              className="flex items-center gap-2 px-6 py-3 bg-green-700 text-white rounded-lg hover:bg-green-600 transition-colors font-medium disabled:opacity-50"
            >
              <Check className="w-5 h-5" />
              {saving ? 'Creating...' : 'Create Rental Agreement'}
            </button>
          ) : (
            <button
              onClick={submitTicket}
              disabled={saving || !arrivedAt || !departedAt}
              title={!arrivedAt || !departedAt ? 'Arrival + departure times required' : undefined}
              className="flex items-center gap-2 px-6 py-3 bg-green-700 text-white rounded-lg hover:bg-green-600 transition-colors font-medium disabled:opacity-50"
            >
              <Check className="w-5 h-5" />
              {saving ? 'Submitting...' : 'Complete & Submit'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
