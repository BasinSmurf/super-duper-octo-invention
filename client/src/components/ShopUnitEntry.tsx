import { SharedBinConfirmation } from './SharedBinConfirmation'
import { useEffect, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { cn } from '@/lib/cn'
import { BarcodeScanner } from '@/components/BarcodeScanner'
import { Plus, Trash2, ScanLine, ScanBarcode, FileText } from 'lucide-react'

// Shared unit-entry for shop work orders: used by the intake wizard (step 2)
// and the "Add units" dialog on the work-order detail page.

export interface IntakeItem {
  id: string
  serialNumber: string
  equipmentCategory: string
  serviceType: string
  reportedIssue: string
  // FEX-specific
  fexBrand: string
  fexSize: string
  fexType: string
  // Monitor-specific (area_monitor | personal_monitor)
  monitorBrand: string
  monitorModel: string
  monitorGasTypes: string[]
  // Personal-monitor only: which shop bin the unit is stored in
  binLocation: string
  // Fall Arrest-specific
  fallArrestBrand: string
  fallArrestModel: string
  // Other — description so we know what it is
  otherDescription: string
  // SCBA named serial fields
  scbaCaseSerial: string
  scbaRegulatorSerial: string
  scbaMaskSerial: string
  scbaHarnessSerial: string
  scbaBottleSerials: string[]
  /** Part types the customer did not bring in ('regulator', 'mask', …). */
  scbaNotIncluded?: string[]
  // Legacy components array (kept for server payload conversion)
  components: Array<{
    id: string
    type: string
    serialNumber: string
    serviceType: string
  }>
}

export const CATEGORIES = [
  { value: 'fire_extinguisher', label: 'Fire Extinguisher' },
  { value: 'area_monitor', label: 'Area Monitor' },
  { value: 'personal_monitor', label: 'Personal Monitor' },
  { value: 'fall_arrest', label: 'Fall Arrest' },
  { value: 'scba', label: 'SCBA' },
  { value: 'ue_cylinder', label: 'UE Cylinder' },
  { value: 'other', label: 'Other' },
]

export const SERVICE_TYPES = [
  { value: 'repair', label: 'Repair' },
  { value: 'recharge', label: 'Recharge' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'test', label: 'Test' },
  { value: 'calibrate', label: 'Calibrate' },
  { value: 'bump_test', label: 'Bump Test' },
  { value: 'warranty_repair', label: 'Warranty Repair' },
  { value: 'ue_testing', label: 'UE Testing' },
  { value: 'sensor_replace', label: 'Sensor Replace' },
  { value: 'general', label: 'General' },
]

const FEX_SIZES = [
  { value: '2.5#', label: '2.5#' },
  { value: '5#', label: '5#' },
  { value: '10#', label: '10#' },
  { value: '20#', label: '20#' },
  { value: '30#', label: '30#' },
  { value: 'other', label: 'Other' },
]

const FEX_TYPES = [
  { value: 'ABC', label: 'ABC' },
  { value: 'D', label: 'D' },
  { value: 'E', label: 'E' },
  { value: 'Halon', label: 'Halon' },
  { value: 'Purple K', label: 'Purple K' },
  { value: 'CO2', label: 'CO₂' },
  { value: 'Water', label: 'Water' },
  { value: 'Wet Chemical', label: 'Wet Chemical' },
  { value: 'Clean Agent', label: 'Clean Agent' },
  { value: 'Other', label: 'Other' },
]

// Personal-monitor storage bins. Numbered 1–22 plus a free-text "other".
const BIN_LOCATIONS = Array.from({ length: 22 }, (_, i) => `Bin ${i + 1}`)

const GAS_TYPES = [
  'LEL/O2',
  'H2S',
  'CO',
  'SO2',
  'Multi-gas',
  'PID/VOC',
  'Other',
]

// The parts of an SCBA / EEBA assembly. Customers routinely bring in only some
// of them (a lone cylinder, a lone regulator), so each can be marked absent.
export const SCBA_PARTS = [
  { value: 'case', label: 'Case' },
  { value: 'regulator', label: 'Regulator' },
  { value: 'mask', label: 'Mask' },
  { value: 'harness', label: 'Harness' },
  { value: 'bottle', label: 'Bottle' },
]

export function partLabel(type: string) {
  return SCBA_PARTS.find(p => p.value === type)?.label ?? type
}

// What people type when there is nothing to type. Mirrors PLACEHOLDERS in
// server/src/services/serialQuality.ts — none of these identify a unit.
const PLACEHOLDER_SERIALS = new Set([
  'N/A', 'NA', 'NONE', 'NO SERIAL', 'NOSERIAL', 'NOSN', 'NO SN', 'UNKNOWN',
  'UNK', 'TBD', 'PENDING', 'MISSING', 'X', 'XX', 'XXX', 'XXXX', '0', '00',
  '000', '0000', '-', '--', '.', '?',
])

export function isPlaceholderSerial(raw: string) {
  return PLACEHOLDER_SERIALS.has(raw.trim().replace(/\s+/g, ' ').toUpperCase())
}

/**
 * Settle an SCBA draft: a part ticked "Not included" — or "filled in" with N/A
 * — has no serial and is recorded as absent. The unit's own serial falls back
 * to the case, then to whichever part actually came in, so a lone cylinder is
 * identified by the cylinder.
 */
export function resolveScbaParts(draft: {
  serial: string; caseSerial: string; regulatorSerial: string; maskSerial: string
  harnessSerial: string; bottleSerials: string[]; notIncluded: string[]
}) {
  const missing = new Set(draft.notIncluded)
  const part = (type: string, raw: string) => {
    const value = raw.trim()
    if (missing.has(type)) return ''
    if (value && isPlaceholderSerial(value)) { missing.add(type); return '' }
    return value
  }
  const caseSerial = part('case', draft.caseSerial)
  const regulatorSerial = part('regulator', draft.regulatorSerial)
  const maskSerial = part('mask', draft.maskSerial)
  const harnessSerial = part('harness', draft.harnessSerial)
  const typedBottles = missing.has('bottle') ? [] : draft.bottleSerials.map(s => s.trim()).filter(Boolean)
  const bottleSerials = typedBottles.filter(s => !isPlaceholderSerial(s))
  if (typedBottles.length > 0 && bottleSerials.length === 0) missing.add('bottle')
  const typedSerial = draft.serial.trim()
  const serial = (isPlaceholderSerial(typedSerial) ? '' : typedSerial)
    || caseSerial || bottleSerials[0] || regulatorSerial || maskSerial || harnessSerial || ''
  return {
    serial, caseSerial, regulatorSerial, maskSerial, harnessSerial, bottleSerials,
    notIncluded: SCBA_PARTS.map(p => p.value).filter(v => missing.has(v)),
  }
}

export function isMonitor(cat: string) {
  return cat === 'area_monitor' || cat === 'personal_monitor'
}

/** Convert a drafted unit into the shape POST /shop-orders (and /:id/items) expects. */
export function buildShopItemPayload(item: IntakeItem) {
  const isMon = isMonitor(item.equipmentCategory)
  const isScba = item.equipmentCategory === 'scba'
  const isFa = item.equipmentCategory === 'fall_arrest'
  const isOther = item.equipmentCategory === 'other'
  const serialNumber = item.serialNumber.trim() || (isScba ? item.scbaCaseSerial.trim() : '')

  // Build SCBA components array from named fields.
  // When a part supplies the unit identity (the case, or the lone cylinder a
  // customer dropped off), the parent already records that serial — a child
  // item with the same serial would be a duplicate unit. Only separately
  // numbered parts get a child item and their own label.
  let components: any[] | undefined
  let unitSerialPart: string | undefined
  if (isScba) {
    const comps: any[] = []
    const add = (type: string, raw: string) => {
      const partSerial = raw.trim()
      if (!partSerial) return
      // Exactly ONE part can be the unit's identity. A second part carrying the
      // same serial is a keying mistake and stays in the payload so the server
      // rejects it as a duplicate instead of it vanishing silently.
      if (!unitSerialPart && partSerial.toLowerCase() === serialNumber.toLowerCase()) { unitSerialPart = type; return }
      comps.push({ type, serialNumber: partSerial, serviceType: item.serviceType })
    }
    add('case', item.scbaCaseSerial)
    add('regulator', item.scbaRegulatorSerial)
    add('mask', item.scbaMaskSerial)
    add('harness', item.scbaHarnessSerial)
    for (const bs of item.scbaBottleSerials) add('bottle', bs)
    // Parts the customer did not bring in. The server records these on the
    // parent unit (customData.partsNotIncluded) and creates no child for them.
    for (const type of item.scbaNotIncluded ?? []) {
      comps.push({ type, notIncluded: true, serviceType: item.serviceType })
    }
    if (comps.length > 0) components = comps
  }

  // Build customData for monitors, fall arrest, other
  let customData: any = undefined
  if (isMon && (item.monitorBrand || item.monitorModel || item.monitorGasTypes.length > 0 || item.binLocation)) {
    customData = {
      monitorBrand: item.monitorBrand || null,
      monitorModel: item.monitorModel || null,
      monitorGasTypes: item.monitorGasTypes.length > 0 ? item.monitorGasTypes : null,
      binLocation: item.binLocation || null,
    }
  } else if (isFa && (item.fallArrestBrand || item.fallArrestModel)) {
    customData = {
      fallArrestBrand: item.fallArrestBrand || null,
      fallArrestModel: item.fallArrestModel || null,
    }
  } else if (isOther && item.otherDescription) {
    customData = {
      otherDescription: item.otherDescription,
    }
  } else if (isScba && unitSerialPart) {
    // Which part the unit's serial was read off, so QA knows what it is holding.
    customData = { unitSerialPart }
  }

  return {
    serialNumber,
    equipmentCategory: item.equipmentCategory,
    serviceType: item.serviceType,
    reportedIssue: item.reportedIssue || null,
    fexBrand: item.fexBrand || null,
    fexSize: item.fexSize || null,
    fexType: item.fexType || null,
    customData,
    components,
  }
}

interface ShopUnitEntryProps {
  items: IntakeItem[]
  onChange: (items: IntakeItem[]) => void
  /** WO-level primary category seeds the per-unit category picker for faster intake. */
  defaultCategory?: string | null
  /** Bins held by other active items — disables them in the picker below. */
  allowMassIntake?: boolean
  workOrderId?: string
  occupiedBins?: Map<string, { workOrderNumber: string; workOrderId?: string; itemId: string }>
}

function validCategory(category: string | null | undefined): string | null {
  return category && CATEGORIES.some(c => c.value === category) ? category : null
}

export function ShopUnitEntry({ items, onChange, defaultCategory, occupiedBins, workOrderId, allowMassIntake }: ShopUnitEntryProps) {
  const [entryMode, setEntryMode] = useState<'single' | 'paste' | 'mass'>('single')
  const [massCount, setMassCount] = useState('11')
  const validMassCount = Number.isInteger(Number(massCount)) && Number(massCount) > 10 && items.length + Number(massCount) <= 1000

  function acceptMassIntake() {
    if (!validMassCount) return
    const units: IntakeItem[] = Array.from({ length: Number(massCount) }, () => ({
      id: uuidv4(), serialNumber: '', equipmentCategory: newCategory, serviceType: newServiceType,
      reportedIssue: '', fexBrand: '', fexSize: '', fexType: '', monitorBrand: '', monitorModel: '',
      monitorGasTypes: [], binLocation: '', fallArrestBrand: '', fallArrestModel: '', otherDescription: '',
      scbaCaseSerial: '', scbaRegulatorSerial: '', scbaMaskSerial: '', scbaHarnessSerial: '',
      scbaBottleSerials: [], components: [],
    }))
    onChange([...items, ...units])
  }
  const [newSerial, setNewSerial] = useState('')
  const [newCategory, setNewCategory] = useState(() => validCategory(defaultCategory) ?? 'other')
  const [newServiceType, setNewServiceType] = useState('general')
  const [newIssue, setNewIssue] = useState('')
  const [pasteText, setPasteText] = useState('')
  // FEX fields
  const [newFexBrand, setNewFexBrand] = useState('')
  const [newFexSize, setNewFexSize] = useState('')
  const [newFexType, setNewFexType] = useState('')
  const [newFexSizeOther, setNewFexSizeOther] = useState('')
  // Monitor fields
  const [newMonitorBrand, setNewMonitorBrand] = useState('')
  const [newMonitorModel, setNewMonitorModel] = useState('')
  const [newMonitorGasTypes, setNewMonitorGasTypes] = useState<string[]>([])
  // Personal-monitor bin: dropdown value ('Bin 1'..'Bin 22' | 'other' | '') + free text when "other"
  const [newBinLocation, setNewBinLocation] = useState('')
  const [newBinLocationOther, setNewBinLocationOther] = useState('')
  // Fall Arrest fields
  const [newFallArrestBrand, setNewFallArrestBrand] = useState('')
  const [newFallArrestModel, setNewFallArrestModel] = useState('')
  // Other — description
  const [newOtherDescription, setNewOtherDescription] = useState('')
  // SCBA fields
  const [newScbaCaseSerial, setNewScbaCaseSerial] = useState('')
  const [newScbaRegulatorSerial, setNewScbaRegulatorSerial] = useState('')
  const [newScbaMaskSerial, setNewScbaMaskSerial] = useState('')
  const [newScbaHarnessSerial, setNewScbaHarnessSerial] = useState('')
  const [newScbaBottleSerials, setNewScbaBottleSerials] = useState<string[]>([''])
  const [newScbaNotIncluded, setNewScbaNotIncluded] = useState<string[]>([])
  const scbaDraft = resolveScbaParts({
    serial: newSerial, caseSerial: newScbaCaseSerial, regulatorSerial: newScbaRegulatorSerial,
    maskSerial: newScbaMaskSerial, harnessSerial: newScbaHarnessSerial,
    bottleSerials: newScbaBottleSerials, notIncluded: newScbaNotIncluded,
  })
  const scbaPartInputs: Array<[string, string, (v: string) => void]> = [
    ['case', newScbaCaseSerial, setNewScbaCaseSerial],
    ['regulator', newScbaRegulatorSerial, setNewScbaRegulatorSerial],
    ['mask', newScbaMaskSerial, setNewScbaMaskSerial],
    ['harness', newScbaHarnessSerial, setNewScbaHarnessSerial],
  ]

  function toggleScbaNotIncluded(type: string) {
    setNewScbaNotIncluded(prev => prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type])
  }

  /** "Not included" checkbox shown beside each SCBA part label. */
  function notIncludedToggle(type: string) {
    return (
      <label className="flex items-center gap-1 text-[11px] font-normal text-blue-700 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={newScbaNotIncluded.includes(type)}
          onChange={() => toggleScbaNotIncluded(type)}
          aria-label={`${partLabel(type)} not included`}
          className="rounded border-blue-300"
        />
        Not included
      </label>
    )
  }

  const serialInputRef = useRef<HTMLInputElement>(null)
  const [showScanner, setShowScanner] = useState(false)

  useEffect(() => {
    const next = validCategory(defaultCategory)
    if (next && items.length === 0) setNewCategory(next)
  }, [defaultCategory, items.length])

  function toggleGasType(gas: string) {
    setNewMonitorGasTypes(prev =>
      prev.includes(gas) ? prev.filter(g => g !== gas) : [...prev, gas]
    )
  }

  const [binConfirmation, setBinConfirmation] = useState<{ bin: string; confirm: () => void } | null>(null)

  function confirmSharedBin(bin: string, count: number, confirm: () => void): boolean {
    if (newCategory !== 'personal_monitor' || !bin) return false
    const alreadyInDraft = items.some(item => item.equipmentCategory === 'personal_monitor' && item.binLocation.trim() === bin)
    const occupied = occupiedBins?.get(bin)
    if (count > 1 || alreadyInDraft || (workOrderId && occupied?.workOrderId === workOrderId)) {
      setBinConfirmation({ bin, confirm })
      return true
    }
    return false
  }

  function addItem(confirmed = false) {
    const isScba = newCategory === 'scba'
    // For SCBA with no unit serial, fall back to the case, then to whichever
    // part actually came in.
    const serial = isScba ? scbaDraft.serial : newSerial.trim()
    if (!serial) return

    const resolvedFexSize = newFexSize === 'other' ? newFexSizeOther.trim() : newFexSize
    const resolvedBin = newBinLocation === 'other' ? newBinLocationOther.trim() : newBinLocation
    const isFex = newCategory === 'fire_extinguisher'
    const isMon = isMonitor(newCategory)
    const isFa = newCategory === 'fall_arrest'
    const isOther = newCategory === 'other'
    const isPersonalMon = newCategory === 'personal_monitor'

    if (!confirmed && confirmSharedBin(resolvedBin, 1, () => addItem(true))) return

    const item: IntakeItem = {
      id: uuidv4(),
      serialNumber: serial,
      equipmentCategory: newCategory,
      serviceType: newServiceType,
      reportedIssue: newIssue.trim(),
      fexBrand: isFex ? newFexBrand.trim() : '',
      fexSize: isFex ? resolvedFexSize : '',
      fexType: isFex ? newFexType : '',
      monitorBrand: isMon ? newMonitorBrand.trim() : '',
      monitorModel: isMon ? newMonitorModel.trim() : '',
      monitorGasTypes: isMon ? [...newMonitorGasTypes] : [],
      binLocation: isPersonalMon ? resolvedBin : '',
      fallArrestBrand: isFa ? newFallArrestBrand.trim() : '',
      fallArrestModel: isFa ? newFallArrestModel.trim() : '',
      otherDescription: isOther ? newOtherDescription.trim() : '',
      scbaCaseSerial: isScba ? scbaDraft.caseSerial : '',
      scbaRegulatorSerial: isScba ? scbaDraft.regulatorSerial : '',
      scbaMaskSerial: isScba ? scbaDraft.maskSerial : '',
      scbaHarnessSerial: isScba ? scbaDraft.harnessSerial : '',
      scbaBottleSerials: isScba ? scbaDraft.bottleSerials : [],
      scbaNotIncluded: isScba ? scbaDraft.notIncluded : [],
      components: [],
    }

    onChange([...items, item])
    setNewSerial('')
    setNewIssue('')
    // Reset SCBA fields after adding
    if (isScba) {
      setNewScbaCaseSerial('')
      setNewScbaRegulatorSerial('')
      setNewScbaMaskSerial('')
      setNewScbaHarnessSerial('')
      setNewScbaBottleSerials([''])
      setNewScbaNotIncluded([])
    }
    // Keep category + service type + FEX/Monitor defaults for rapid batch entry
    setTimeout(() => serialInputRef.current?.focus(), 50)
  }

  function addItemsFromPaste(confirmed = false) {
    const lines = pasteText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)

    if (lines.length === 0) return

    const isFex = newCategory === 'fire_extinguisher'
    const isMon = isMonitor(newCategory)
    const isFa = newCategory === 'fall_arrest'
    const isOther = newCategory === 'other'
    const isPersonalMon = newCategory === 'personal_monitor'
    const resolvedFexSize = newFexSize === 'other' ? newFexSizeOther.trim() : newFexSize
    const resolvedBin = newBinLocation === 'other' ? newBinLocationOther.trim() : newBinLocation

    if (!confirmed && confirmSharedBin(resolvedBin, lines.length, () => addItemsFromPaste(true))) return

    const newItems: IntakeItem[] = lines.map(serial => ({
      id: uuidv4(),
      serialNumber: serial,
      equipmentCategory: newCategory,
      serviceType: newServiceType,
      reportedIssue: '',
      fexBrand: isFex ? newFexBrand.trim() : '',
      fexSize: isFex ? resolvedFexSize : '',
      fexType: isFex ? newFexType : '',
      monitorBrand: isMon ? newMonitorBrand.trim() : '',
      monitorModel: isMon ? newMonitorModel.trim() : '',
      monitorGasTypes: isMon ? [...newMonitorGasTypes] : [],
      binLocation: isPersonalMon ? resolvedBin : '',
      fallArrestBrand: isFa ? newFallArrestBrand.trim() : '',
      fallArrestModel: isFa ? newFallArrestModel.trim() : '',
      otherDescription: isOther ? newOtherDescription.trim() : '',
      scbaCaseSerial: '',
      scbaRegulatorSerial: '',
      scbaMaskSerial: '',
      scbaHarnessSerial: '',
      scbaBottleSerials: [],
      components: [],
    }))

    onChange([...items, ...newItems])
    setPasteText('')
  }

  function removeItem(id: string) {
    onChange(items.filter(i => i.id !== id))
  }

  return (
    <div className="space-y-4">
      {binConfirmation && <SharedBinConfirmation bin={binConfirmation.bin} onCancel={() => setBinConfirmation(null)} onConfirm={() => { const action = binConfirmation.confirm; setBinConfirmation(null); action() }} />}
      {/* Entry mode tabs */}
      <div className="flex gap-2">
        {allowMassIntake && (
          <button type="button" onClick={() => {
            setEntryMode('mass')
            setNewCategory(validCategory(defaultCategory) ?? 'ue_cylinder')
            setNewServiceType('ue_testing')
          }} className={cn('px-4 py-2 rounded-lg text-sm font-medium border', entryMode === 'mass' ? 'bg-blue-100 border-blue-300 text-blue-800' : 'bg-white border-slate-200 text-slate-600')}>
            Mass Intake
          </button>
        )}
        <button
          type="button"
          onClick={() => setEntryMode('single')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
            entryMode === 'single' ? 'bg-blue-100 border-blue-300 text-blue-800' : 'bg-white border-slate-200 text-slate-600',
          )}
        >
          <ScanLine className="w-4 h-4" />
          Single Entry
        </button>
        <button
          type="button"
          onClick={() => setEntryMode('paste')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
            entryMode === 'paste' ? 'bg-blue-100 border-blue-300 text-blue-800' : 'bg-white border-slate-200 text-slate-600',
          )}
        >
          <FileText className="w-4 h-4" />
          Paste List
        </button>
      </div>

      {/* Defaults for batch */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Category</label>
          <select
            value={newCategory}
            onChange={e => setNewCategory(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
          >
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">{entryMode === 'mass' ? 'Work Type' : 'Service Type'}</label>
          <select
            value={newServiceType}
            onChange={e => setNewServiceType(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
          >
            {SERVICE_TYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      </div>

      {entryMode === 'mass' && (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg space-y-3">
          <p className="text-sm text-blue-900">Receive more than 10 pieces by count. Record and confirm every serial during QA, including failed or condemned pieces, before closing or returning equipment.</p>
          <label className="block text-sm font-medium text-slate-700">Number of pieces
            <input type="number" min={11} max={1000} step={1} value={massCount} onChange={e => setMassCount(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-lg" />
          </label>
          <button type="button" disabled={!validMassCount} onClick={acceptMassIntake} className="px-4 py-2 bg-blue-800 text-white rounded-lg disabled:opacity-40">Accept {validMassCount ? massCount : ''} pieces</button>
        </div>
      )}

      {entryMode !== 'mass' && <>
      {/* FEX-specific fields */}
      {newCategory === 'fire_extinguisher' && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 space-y-3">
          <p className="text-xs font-semibold text-orange-800 uppercase tracking-wide">FEX Details</p>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs font-medium text-orange-700 mb-1">Brand</label>
              <input
                type="text"
                value={newFexBrand}
                onChange={e => setNewFexBrand(e.target.value)}
                placeholder="e.g. Amerex"
                className="w-full px-2 py-1.5 border border-orange-200 rounded text-sm bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-orange-700 mb-1">Size</label>
              <select
                value={newFexSize}
                onChange={e => setNewFexSize(e.target.value)}
                className="w-full px-2 py-1.5 border border-orange-200 rounded text-sm bg-white"
              >
                <option value="">Select size</option>
                {FEX_SIZES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              {newFexSize === 'other' && (
                <input
                  type="text"
                  value={newFexSizeOther}
                  onChange={e => setNewFexSizeOther(e.target.value)}
                  placeholder="Custom size"
                  className="w-full mt-1 px-2 py-1.5 border border-orange-200 rounded text-sm bg-white"
                />
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-orange-700 mb-1">Type</label>
              <select
                value={newFexType}
                onChange={e => setNewFexType(e.target.value)}
                className="w-full px-2 py-1.5 border border-orange-200 rounded text-sm bg-white"
              >
                <option value="">Select type</option>
                {FEX_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Monitor-specific fields (Area Monitor / Personal Monitor) */}
      {isMonitor(newCategory) && (
        <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 space-y-3">
          <p className="text-xs font-semibold text-teal-800 uppercase tracking-wide">Monitor Details</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-teal-700 mb-1">Brand</label>
              <input
                type="text"
                value={newMonitorBrand}
                onChange={e => setNewMonitorBrand(e.target.value)}
                placeholder="e.g. RAE Systems"
                className="w-full px-2 py-1.5 border border-teal-200 rounded text-sm bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-teal-700 mb-1">Model</label>
              <input
                type="text"
                value={newMonitorModel}
                onChange={e => setNewMonitorModel(e.target.value)}
                placeholder="e.g. MiniRAE 3000"
                className="w-full px-2 py-1.5 border border-teal-200 rounded text-sm bg-white"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-teal-700 mb-1.5">Gas Type(s)</label>
            <div className="flex flex-wrap gap-1.5">
              {GAS_TYPES.map(gas => (
                <button
                  key={gas}
                  type="button"
                  onClick={() => toggleGasType(gas)}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
                    newMonitorGasTypes.includes(gas)
                      ? 'bg-teal-600 text-white border-teal-600'
                      : 'bg-white text-teal-700 border-teal-300 hover:bg-teal-100',
                  )}
                >
                  {gas}
                </button>
              ))}
            </div>
          </div>
          {/* Bin Location — personal monitors only (where it lives in the shop) */}
          {newCategory === 'personal_monitor' && (
            <div>
              <label className="block text-xs font-medium text-teal-700 mb-1">Bin Location</label>
              <select
                value={newBinLocation}
                onChange={e => setNewBinLocation(e.target.value)}
                className="w-full px-2 py-1.5 border border-teal-200 rounded text-sm bg-white"
              >
                <option value="">Select bin…</option>
                {BIN_LOCATIONS.map(b => {
                  const hit = occupiedBins?.get(b)
                  return (
                    <option key={b} value={b} disabled={!!hit && (!workOrderId || hit.workOrderId !== workOrderId)}>
                      {hit && (!workOrderId || hit.workOrderId !== workOrderId) ? `${b} — in use (${hit.workOrderNumber})` : b}
                    </option>
                  )
                })}
                <option value="other">Other…</option>
              </select>
              {newBinLocation === 'other' && (
                <input
                  type="text"
                  value={newBinLocationOther}
                  onChange={e => setNewBinLocationOther(e.target.value)}
                  placeholder="OK, where did you put it?"
                  className="w-full mt-1 px-2 py-1.5 border border-teal-200 rounded text-sm bg-white"
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* Fall Arrest-specific fields */}
      {newCategory === 'fall_arrest' && (
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-3">
          <p className="text-xs font-semibold text-purple-800 uppercase tracking-wide">Fall Arrest Details</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-purple-700 mb-1">Brand</label>
              <input
                type="text"
                value={newFallArrestBrand}
                onChange={e => setNewFallArrestBrand(e.target.value)}
                placeholder="e.g. 3M / DBI-Sala"
                className="w-full px-2 py-1.5 border border-purple-200 rounded text-sm bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-purple-700 mb-1">Model</label>
              <input
                type="text"
                value={newFallArrestModel}
                onChange={e => setNewFallArrestModel(e.target.value)}
                placeholder="e.g. ExoFit NEX"
                className="w-full px-2 py-1.5 border border-purple-200 rounded text-sm bg-white"
              />
            </div>
          </div>
        </div>
      )}

      {/* Other — description box */}
      {newCategory === 'other' && (
        <div className="bg-slate-50 border border-slate-300 rounded-lg p-3 space-y-2">
          <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Equipment Description</p>
          <textarea
            value={newOtherDescription}
            onChange={e => setNewOtherDescription(e.target.value)}
            rows={2}
            placeholder="What is this equipment? (e.g. tripod rescue system, winch, air compressor...)"
            className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm bg-white resize-none"
          />
        </div>
      )}

      {/* SCBA-specific fields */}
      {newCategory === 'scba' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-3">
          <p className="text-xs font-semibold text-blue-800 uppercase tracking-wide">SCBA Component Serials</p>
          <p className="text-xs text-blue-700">Didn&apos;t get a part? Tick <span className="font-semibold">Not included</span> instead of typing N/A.</p>
          <div className="grid grid-cols-2 gap-2">
            {scbaPartInputs.map(([type, value, setValue]) => {
              const absent = newScbaNotIncluded.includes(type)
              return (
                <div key={type}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-blue-700">{type === 'case' ? 'Case #' : partLabel(type)}</span>
                    {notIncludedToggle(type)}
                  </div>
                  <input
                    type="text"
                    value={absent ? '' : value}
                    disabled={absent}
                    onChange={e => setValue(e.target.value)}
                    placeholder={absent ? 'Not included' : `${partLabel(type)} serial`}
                    aria-label={`${partLabel(type)} serial`}
                    className="w-full px-2 py-1.5 border border-blue-200 rounded text-sm font-mono bg-white disabled:bg-blue-100/60 disabled:placeholder:text-blue-400"
                  />
                </div>
              )
            })}
          </div>
          {/* Bottle serials */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-blue-700">Bottle(s)</span>
              {notIncludedToggle('bottle')}
            </div>
            {!newScbaNotIncluded.includes('bottle') && (
            <div className="space-y-1.5">
              {newScbaBottleSerials.map((bs, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={bs}
                    onChange={e => {
                      const updated = [...newScbaBottleSerials]
                      updated[idx] = e.target.value
                      setNewScbaBottleSerials(updated)
                    }}
                    placeholder={`Bottle ${idx + 1} serial`}
                    className="flex-1 px-2 py-1.5 border border-blue-200 rounded text-sm font-mono bg-white"
                  />
                  {newScbaBottleSerials.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setNewScbaBottleSerials(prev => prev.filter((_, i) => i !== idx))}
                      className="p-1 text-blue-300 hover:text-red-500"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setNewScbaBottleSerials(prev => [...prev, ''])}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> Add Bottle
              </button>
            </div>
            )}
          </div>
        </div>
      )}

      </>}
      {/* Single entry form */}
      {entryMode === 'single' && (
        <div className="flex gap-2">
          <input
            ref={serialInputRef}
            type="text"
            value={newSerial}
            onChange={e => setNewSerial(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addItem() }}
            placeholder={newCategory === 'scba' ? 'Serial # (blank = use Case # or part serial)' : 'Serial number'}
            className="flex-1 px-3 py-2.5 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            autoFocus
          />
          <button
            type="button"
            onClick={() => setShowScanner(true)}
            className="px-3 py-2.5 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors"
            title="Scan barcode"
          >
            <ScanBarcode className="w-5 h-5 text-slate-600" />
          </button>
          <button
            type="button"
            onClick={() => addItem()}
            disabled={newCategory === 'scba' ? !scbaDraft.serial : !newSerial.trim()}
            className="px-4 py-2.5 bg-blue-800 text-white rounded-lg font-medium text-sm disabled:opacity-40"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>
      )}

      {showScanner && (
        <BarcodeScanner
          label="Scan Serial Number"
          onScan={(serial) => { setNewSerial(serial); setShowScanner(false) }}
          onClose={() => setShowScanner(false)}
        />
      )}

      {/* Paste mode */}
      {entryMode === 'paste' && (
        <div>
          <textarea
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            rows={6}
            placeholder="Paste serial numbers (one per line)..."
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono resize-none"
          />
          <button
            type="button"
            onClick={() => addItemsFromPaste()}
            disabled={!pasteText.trim()}
            className="mt-2 px-4 py-2 bg-blue-800 text-white rounded-lg text-sm font-medium disabled:opacity-40"
          >
            Add {pasteText.split('\n').filter(l => l.trim()).length} items
          </button>
        </div>
      )}

      {/* Item count */}
      {items.some(item => !item.serialNumber.trim()) && items.length <= 10 && (
        <p className="text-sm text-amber-800">Mass intake requires more than 10 pieces. Add pieces or enter each serial through single entry.</p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-700">
          {items.length} item{items.length !== 1 ? 's' : ''}
        </p>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-red-500 hover:text-red-700 font-medium"
          >
            Clear All
          </button>
        )}
      </div>

      {/* Item list */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {items.map((item, idx) => (
          <div key={item.id} className="bg-white border border-slate-200 rounded-lg p-3">
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400 font-mono w-6 shrink-0">{idx + 1}</span>
              <span className="font-mono text-sm font-medium text-slate-900 flex-1">{item.serialNumber || 'Serial required at QA'}</span>
              <span className="text-[10px] text-slate-400">{CATEGORIES.find(c => c.value === item.equipmentCategory)?.label}</span>
              <button
                type="button"
                onClick={() => removeItem(item.id)}
                className="p-1 text-slate-300 hover:text-red-500"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* FEX details */}
            {item.equipmentCategory === 'fire_extinguisher' && (item.fexBrand || item.fexSize || item.fexType) && (
              <div className="ml-8 mt-1 flex items-center gap-2 text-[10px] text-orange-600">
                {item.fexBrand && <span>{item.fexBrand}</span>}
                {item.fexSize && <span>{item.fexSize}</span>}
                {item.fexType && <span>{item.fexType}</span>}
              </div>
            )}

            {/* Monitor details */}
            {isMonitor(item.equipmentCategory) && (item.monitorBrand || item.monitorModel || item.monitorGasTypes.length > 0) && (
              <div className="ml-8 mt-1 text-[10px] text-teal-600">
                {[item.monitorBrand, item.monitorModel].filter(Boolean).join(' ')}
                {item.monitorGasTypes.length > 0 && (
                  <span className="ml-1">({item.monitorGasTypes.join(', ')})</span>
                )}
              </div>
            )}

            {/* Personal-monitor bin */}
            {item.equipmentCategory === 'personal_monitor' && item.binLocation && (
              <div className="ml-8 mt-1 text-[10px] font-medium text-teal-700">{item.binLocation}</div>
            )}

            {/* Fall Arrest details */}
            {item.equipmentCategory === 'fall_arrest' && (item.fallArrestBrand || item.fallArrestModel) && (
              <div className="ml-8 mt-1 text-[10px] text-purple-600">
                {[item.fallArrestBrand, item.fallArrestModel].filter(Boolean).join(' ')}
              </div>
            )}

            {/* Other description */}
            {item.equipmentCategory === 'other' && item.otherDescription && (
              <div className="ml-8 mt-1 text-[10px] text-slate-500 italic">
                {item.otherDescription}
              </div>
            )}

            {/* SCBA component serials */}
            {item.equipmentCategory === 'scba' && (item.scbaCaseSerial || item.scbaRegulatorSerial || item.scbaMaskSerial || item.scbaHarnessSerial || item.scbaBottleSerials.length > 0 || (item.scbaNotIncluded?.length ?? 0) > 0) && (
              <div className="ml-8 mt-1 space-y-0.5 text-[10px] text-blue-600">
                {item.scbaCaseSerial && <div>Case: <span className="font-mono">{item.scbaCaseSerial}</span></div>}
                {item.scbaRegulatorSerial && <div>Reg: <span className="font-mono">{item.scbaRegulatorSerial}</span></div>}
                {item.scbaMaskSerial && <div>Mask: <span className="font-mono">{item.scbaMaskSerial}</span></div>}
                {item.scbaHarnessSerial && <div>Harness: <span className="font-mono">{item.scbaHarnessSerial}</span></div>}
                {item.scbaBottleSerials.map((bs, i) => (
                  <div key={i}>Bottle {i + 1}: <span className="font-mono">{bs}</span></div>
                ))}
                {(item.scbaNotIncluded?.length ?? 0) > 0 && (
                  <div className="text-amber-700">Not included: {item.scbaNotIncluded!.map(partLabel).join(', ')}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
