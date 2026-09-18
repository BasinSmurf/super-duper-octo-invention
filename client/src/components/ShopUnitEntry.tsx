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

export function isMonitor(cat: string) {
  return cat === 'area_monitor' || cat === 'personal_monitor'
}

/** Convert a drafted unit into the shape POST /shop-orders (and /:id/items) expects. */
export function buildShopItemPayload(item: IntakeItem) {
  const isMon = isMonitor(item.equipmentCategory)
  const isScba = item.equipmentCategory === 'scba'
  const isFa = item.equipmentCategory === 'fall_arrest'
  const isOther = item.equipmentCategory === 'other'

  // Build SCBA components array from named fields.
  //
  // WI-07 bug fix: the CASE serial was collected here, echoed back in the review
  // list so the counter person believed it was recorded, and then never sent to
  // the server. It only ever existed in form state. It is a constituent part
  // like any other, so it becomes a child item like the others -- which is also
  // what makes it a child record in VaultPRO.
  let components: any[] | undefined
  if (isScba) {
    const comps: any[] = []
    if (item.scbaCaseSerial) comps.push({ type: 'case', serialNumber: item.scbaCaseSerial, serviceType: item.serviceType })
    if (item.scbaRegulatorSerial) comps.push({ type: 'regulator', serialNumber: item.scbaRegulatorSerial, serviceType: item.serviceType })
    if (item.scbaMaskSerial) comps.push({ type: 'mask', serialNumber: item.scbaMaskSerial, serviceType: item.serviceType })
    if (item.scbaHarnessSerial) comps.push({ type: 'harness', serialNumber: item.scbaHarnessSerial, serviceType: item.serviceType })
    for (const bs of item.scbaBottleSerials) {
      if (bs) comps.push({ type: 'bottle', serialNumber: bs, serviceType: item.serviceType })
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
  }

  return {
    serialNumber: item.serialNumber,
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
  occupiedBins?: Map<string, { workOrderNumber: string; itemId: string }>
}

function validCategory(category: string | null | undefined): string | null {
  return category && CATEGORIES.some(c => c.value === category) ? category : null
}

export function ShopUnitEntry({ items, onChange, defaultCategory, occupiedBins }: ShopUnitEntryProps) {
  const [entryMode, setEntryMode] = useState<'single' | 'paste'>('single')
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

  function addItem() {
    const isScba = newCategory === 'scba'
    // For SCBA, use case serial as the main serial if serial field is empty
    const serial = isScba
      ? (newSerial.trim() || newScbaCaseSerial.trim())
      : newSerial.trim()
    if (!serial) return

    const resolvedFexSize = newFexSize === 'other' ? newFexSizeOther.trim() : newFexSize
    const resolvedBin = newBinLocation === 'other' ? newBinLocationOther.trim() : newBinLocation
    const isFex = newCategory === 'fire_extinguisher'
    const isMon = isMonitor(newCategory)
    const isFa = newCategory === 'fall_arrest'
    const isOther = newCategory === 'other'
    const isPersonalMon = newCategory === 'personal_monitor'

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
      scbaCaseSerial: isScba ? newScbaCaseSerial.trim() : '',
      scbaRegulatorSerial: isScba ? newScbaRegulatorSerial.trim() : '',
      scbaMaskSerial: isScba ? newScbaMaskSerial.trim() : '',
      scbaHarnessSerial: isScba ? newScbaHarnessSerial.trim() : '',
      scbaBottleSerials: isScba ? newScbaBottleSerials.map(s => s.trim()).filter(Boolean) : [],
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
    }
    // Keep category + service type + FEX/Monitor defaults for rapid batch entry
    setTimeout(() => serialInputRef.current?.focus(), 50)
  }

  function addItemsFromPaste() {
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
      {/* Entry mode tabs */}
      <div className="flex gap-2">
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
          <label className="block text-xs font-medium text-slate-500 mb-1">Service Type</label>
          <select
            value={newServiceType}
            onChange={e => setNewServiceType(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
          >
            {SERVICE_TYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      </div>

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
                    <option key={b} value={b} disabled={!!hit}>
                      {hit ? `${b} — in use (${hit.workOrderNumber})` : b}
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
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-blue-700 mb-1">Case #</label>
              <input
                type="text"
                value={newScbaCaseSerial}
                onChange={e => setNewScbaCaseSerial(e.target.value)}
                placeholder="Case serial"
                className="w-full px-2 py-1.5 border border-blue-200 rounded text-sm font-mono bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-blue-700 mb-1">Regulator</label>
              <input
                type="text"
                value={newScbaRegulatorSerial}
                onChange={e => setNewScbaRegulatorSerial(e.target.value)}
                placeholder="Regulator serial"
                className="w-full px-2 py-1.5 border border-blue-200 rounded text-sm font-mono bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-blue-700 mb-1">Mask</label>
              <input
                type="text"
                value={newScbaMaskSerial}
                onChange={e => setNewScbaMaskSerial(e.target.value)}
                placeholder="Mask serial"
                className="w-full px-2 py-1.5 border border-blue-200 rounded text-sm font-mono bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-blue-700 mb-1">Harness</label>
              <input
                type="text"
                value={newScbaHarnessSerial}
                onChange={e => setNewScbaHarnessSerial(e.target.value)}
                placeholder="Harness serial"
                className="w-full px-2 py-1.5 border border-blue-200 rounded text-sm font-mono bg-white"
              />
            </div>
          </div>
          {/* Bottle serials */}
          <div>
            <label className="block text-xs font-medium text-blue-700 mb-1">Bottle(s)</label>
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
          </div>
        </div>
      )}

      {/* Single entry form */}
      {entryMode === 'single' && (
        <div className="flex gap-2">
          <input
            ref={serialInputRef}
            type="text"
            value={newSerial}
            onChange={e => setNewSerial(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addItem() }}
            placeholder={newCategory === 'scba' ? 'Serial # (or leave blank to use Case #)' : 'Serial number'}
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
            onClick={addItem}
            disabled={newCategory === 'scba' ? !(newSerial.trim() || newScbaCaseSerial.trim()) : !newSerial.trim()}
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
            onClick={addItemsFromPaste}
            disabled={!pasteText.trim()}
            className="mt-2 px-4 py-2 bg-blue-800 text-white rounded-lg text-sm font-medium disabled:opacity-40"
          >
            Add {pasteText.split('\n').filter(l => l.trim()).length} items
          </button>
        </div>
      )}

      {/* Item count */}
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
              <span className="font-mono text-sm font-medium text-slate-900 flex-1">{item.serialNumber}</span>
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
            {item.equipmentCategory === 'scba' && (item.scbaCaseSerial || item.scbaRegulatorSerial || item.scbaMaskSerial || item.scbaHarnessSerial || item.scbaBottleSerials.length > 0) && (
              <div className="ml-8 mt-1 space-y-0.5 text-[10px] text-blue-600">
                {item.scbaCaseSerial && <div>Case: <span className="font-mono">{item.scbaCaseSerial}</span></div>}
                {item.scbaRegulatorSerial && <div>Reg: <span className="font-mono">{item.scbaRegulatorSerial}</span></div>}
                {item.scbaMaskSerial && <div>Mask: <span className="font-mono">{item.scbaMaskSerial}</span></div>}
                {item.scbaHarnessSerial && <div>Harness: <span className="font-mono">{item.scbaHarnessSerial}</span></div>}
                {item.scbaBottleSerials.map((bs, i) => (
                  <div key={i}>Bottle {i + 1}: <span className="font-mono">{bs}</span></div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
