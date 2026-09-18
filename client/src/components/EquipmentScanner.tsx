import { useState, useCallback, useEffect, useRef } from 'react'
import { BarcodeScanner } from './BarcodeScanner'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import type { OfflineEquipment, OfflineProduct } from '@/lib/db-types'
import { AlertCircle, Search, Barcode, Camera, X, Loader2, Package, RotateCcw } from 'lucide-react'

export interface ScannedEquipment extends OfflineEquipment {
  product: OfflineProduct
}

interface EquipmentScannerProps {
  onEquipmentFound: (equip: ScannedEquipment) => void
  onClose: () => void
  /** Only accept equipment with this status (default: 'available') */
  filterStatus?: string
  /** When true, the not-found state offers a "build on the fly" form
   *  that mints a Product + SerializedEquipment from manufacturer + model
   *  + serial. Counter-floor stop-gap until proper inventory tooling lands. */
  allowCreate?: boolean
}

type Phase =
  | 'search'          // default: manual entry + search results
  | 'scanning'        // camera barcode scanner
  | 'ocr_capture'     // OCR camera preview
  | 'ocr_processing'  // OCR running
  | 'ocr_result'      // OCR result confirmation
  | 'not_found'       // serial not found anywhere
  | 'wrong_status'    // found but wrong status
  | 'create_form'     // quick-create: build the unit on the fly

interface SearchResult {
  equipment: OfflineEquipment
  product: OfflineProduct
}

export function EquipmentScanner({ onEquipmentFound, onClose, filterStatus = 'available', allowCreate = false }: EquipmentScannerProps) {
  const [phase, setPhase] = useState<Phase>('search')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [errorSerial, setErrorSerial] = useState('')
  const [errorStatus, setErrorStatus] = useState('')
  const [errorProductName, setErrorProductName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ocrText, setOcrText] = useState('')
  const [ocrProgress, setOcrProgress] = useState(0)

  // Quick-create form state
  const [createManufacturer, setCreateManufacturer] = useState('')
  const [createModel, setCreateModel] = useState('')
  const [createCategory, setCreateCategory] = useState('monitor_personal')
  const [createDate, setCreateDate] = useState('')
  const [createSubmitting, setCreateSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  async function handleQuickCreate() {
    if (!errorSerial || !createManufacturer.trim() || !createModel.trim()) return
    setCreateSubmitting(true)
    setCreateError(null)
    try {
      const created = await api.post<ScannedEquipment>('/equipment/quick-create', {
        manufacturer: createManufacturer.trim(),
        model: createModel.trim(),
        serialNumber: errorSerial,
        category: createCategory,
        purchaseDate: createDate || undefined,
      })
      onEquipmentFound(created)
    } catch (err: any) {
      setCreateError(err?.message || 'Failed to add equipment')
    } finally {
      setCreateSubmitting(false)
    }
  }

  // --- OCR handlers ---
  const startOcrCapture = useCallback(async () => {
    setPhase('ocr_capture')
    setOcrText('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
      }
    } catch {
      setPhase('search')
    }
  }, [])

  const captureAndOcr = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setPhase('ocr_processing')
    setOcrProgress(0)
    try {
      const Tesseract = await import('tesseract.js')
      const result = await Tesseract.recognize(canvas, 'eng', {
        logger: (m: any) => {
          if (m.status === 'recognizing text') setOcrProgress(Math.round((m.progress || 0) * 100))
        },
      })
      const text = result.data.text.trim()
      const candidates = text.split(/[\n\r]+/).map(l => l.trim())
        .filter(l => l.length >= 3 && l.length <= 40)
        .map(l => l.replace(/[^A-Za-z0-9\-_.\/]/g, ''))
        .filter(l => l.length >= 3)
      setOcrText(candidates[0] || text.substring(0, 60))
      setPhase('ocr_result')
    } catch {
      setPhase('search')
    }
  }, [])

  // Look up a single serial (exact match — used by barcode scan + OCR)
  const lookupSerial = useCallback(async (serial: string): Promise<SearchResult | null> => {
    const trimmed = serial.trim()
    if (!trimmed) return null

    // Try Dexie first — case-insensitive by lowering both sides
    const allEquip = await db.equipment.toArray()
    const equip = allEquip.find(e => e.serialNumber?.toLowerCase() === trimmed.toLowerCase())

    if (equip) {
      const product = await db.products.get(equip.productId)
      if (product) return { equipment: equip, product }
    }

    // Fallback to API if not found locally
    try {
      const apiResult = await api.get<{ data: any[] }>(`/equipment?search=${encodeURIComponent(trimmed)}`)
      if (apiResult?.data?.length > 0) {
        const e = apiResult.data[0]
        // Cache it in Dexie for future lookups
        const equipRecord: OfflineEquipment = {
          id: e.id,
          productId: e.productId,
          serialNumber: e.serialNumber,
          ownership: e.ownership || 'company_owned',
          status: e.status,
          currentPadId: e.currentPadId || null,
          currentWellId: e.currentWellId || null,
          currentFacilityId: e.currentFacilityId || null,
          currentCustomerId: e.currentCustomerId || null,
          currentRentalId: e.currentRentalId || null,
          calibrationDueDate: e.calibrationDueDate || null,
          lastCalibrationDate: e.lastCalibrationDate || null,
          bumpTestDueDate: e.bumpTestDueDate || null,
          conditionNotes: e.conditionNotes || null,
          updatedAt: e.updatedAt,
        }
        await db.equipment.put(equipRecord)

        // Get product
        let product = await db.products.get(e.productId)
        if (!product && e.product) {
          product = {
            id: e.product.id,
            partNumber: e.product.partNumber || '',
            name: e.product.name,
            description: e.product.description || '',
            category: e.product.category || '',
            productType: e.product.productType || '',
            unitOfMeasure: e.product.unitOfMeasure || '',
            defaultSellPrice: e.product.defaultSellPrice || null,
            defaultRentalRateDaily: e.product.defaultRentalRateDaily || null,
            defaultRentalRateWeekly: e.product.defaultRentalRateWeekly || null,
            defaultRentalRateMonthly: e.product.defaultRentalRateMonthly || null,
            isSerialized: e.product.isSerialized ?? false,
            isAssembly: e.product.isAssembly ?? false,
            isActive: e.product.isActive ?? true,
            updatedAt: e.product.updatedAt || new Date().toISOString(),
          } as OfflineProduct
          await db.products.put(product)
        }

        if (product) return { equipment: equipRecord, product }
      }
    } catch {
      // API unavailable — offline
    }

    return null
  }, [])

  const acceptOcr = useCallback(async () => {
    setQuery(ocrText)
    setPhase('search')
    // Auto-lookup the OCR result
    const result = await lookupSerial(ocrText)
    if (!result) { setErrorSerial(ocrText); setPhase('not_found'); return }
    if (result.equipment.status !== filterStatus) {
      setErrorSerial(ocrText); setErrorStatus(result.equipment.status)
      setErrorProductName(result.product.name); setPhase('wrong_status'); return
    }
    onEquipmentFound({ ...result.equipment, product: result.product })
  }, [ocrText, lookupSerial, filterStatus, onEquipmentFound])

  const cancelOcr = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setPhase('search')
    setOcrText('')
  }, [])

  // Auto-focus search input on mount
  useEffect(() => {
    if (phase === 'search') {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [phase])

  // Search equipment — broad, forgiving match across serial AND product
  // metadata (name, part #, category, description). Multi-word queries match
  // when every word appears somewhere, so "manned trailer" or "h2s monitor"
  // work. Pickable (correct-status) units sort to the top.
  const handleSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return

    setSearching(true)
    setHasSearched(true)

    try {
      const [allEquip, allProducts] = await Promise.all([
        db.equipment.toArray(),
        db.products.toArray(),
      ])
      const productById = new Map(allProducts.map(p => [p.id, p]))
      const tokens = q.toLowerCase().split(/\s+/).filter(Boolean)

      const matches: SearchResult[] = []
      for (const equip of allEquip) {
        const product = productById.get(equip.productId)
        if (!product) continue
        const haystack = [
          equip.serialNumber,
          equip.safeCoreSerial,
          product.name,
          product.partNumber,
          product.category,
          product.description,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (tokens.every(t => haystack.includes(t))) {
          matches.push({ equipment: equip, product })
        }
      }

      // Surface units that can actually be picked (matching the requested
      // status) before ones that would error on select.
      matches.sort((a, b) => {
        const aOk = a.equipment.status === filterStatus ? 0 : 1
        const bOk = b.equipment.status === filterStatus ? 0 : 1
        return aOk - bOk
      })

      setResults(matches.slice(0, 20))
    } catch {
      setResults([])
    }

    setSearching(false)
  }, [query, filterStatus])

  // Handle barcode scan result
  const handleBarcodeScan = useCallback(async (serial: string) => {
    const result = await lookupSerial(serial)

    if (!result) {
      setErrorSerial(serial.trim())
      setPhase('not_found')
      return
    }

    if (result.equipment.status !== filterStatus) {
      setErrorSerial(serial.trim())
      setErrorStatus(result.equipment.status)
      setErrorProductName(result.product.name)
      setPhase('wrong_status')
      return
    }

    onEquipmentFound({ ...result.equipment, product: result.product })
  }, [lookupSerial, filterStatus, onEquipmentFound])

  // Select an equipment from search results
  const handleSelectResult = useCallback((result: SearchResult) => {
    if (result.equipment.status !== filterStatus) {
      setErrorSerial(result.equipment.serialNumber)
      setErrorStatus(result.equipment.status)
      setErrorProductName(result.product.name)
      setPhase('wrong_status')
      return
    }
    onEquipmentFound({ ...result.equipment, product: result.product })
  }, [filterStatus, onEquipmentFound])

  // Scanning phase — show BarcodeScanner overlay
  if (phase === 'scanning') {
    return (
      <BarcodeScanner
        onScan={handleBarcodeScan}
        onClose={() => setPhase('search')}
        label="Scan Equipment Serial"
      />
    )
  }

  // OCR camera capture
  if (phase === 'ocr_capture') {
    return (
      <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
        <div className="flex items-center justify-between p-4 shrink-0">
          <h3 className="text-white font-medium">Photo OCR — Serial Number</h3>
          <button type="button" onClick={cancelOcr} className="w-10 h-10 flex items-center justify-center">
            <X className="w-6 h-6 text-white" />
          </button>
        </div>
        <div className="flex-1 relative overflow-hidden">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          <div className="absolute top-4 left-0 right-0 text-center">
            <span className="bg-black/60 text-white/80 text-xs px-3 py-1 rounded-full">Center serial number label in frame</span>
          </div>
        </div>
        <div className="p-4 shrink-0">
          <button type="button" onClick={captureAndOcr} className="w-full py-4 rounded-lg bg-blue-600 text-white font-semibold text-lg flex items-center justify-center gap-2 active:scale-[0.98]">
            <Camera className="w-5 h-5" />
            Capture & Read
          </button>
        </div>
        <canvas ref={canvasRef} className="hidden" />
      </div>
    )
  }

  // OCR processing
  if (phase === 'ocr_processing') {
    return (
      <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 text-blue-400 animate-spin mx-auto" />
          <p className="text-white font-medium">Reading text... {ocrProgress}%</p>
          <div className="w-48 h-1.5 bg-white/10 rounded-full mx-auto overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${ocrProgress}%` }} />
          </div>
        </div>
        <canvas ref={canvasRef} className="hidden" />
      </div>
    )
  }

  // OCR result confirmation
  if (phase === 'ocr_result') {
    return (
      <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-4">
          <p className="text-white/60 text-sm text-center">OCR detected:</p>
          <input type="text" value={ocrText} onChange={e => setOcrText(e.target.value)} autoFocus
            className="w-full px-4 py-3 rounded-lg text-lg font-mono bg-white/10 text-white border border-white/30 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/50 outline-none text-center" />
          <p className="text-white/40 text-xs text-center">Edit if needed, then confirm to look up</p>
          <div className="flex gap-3">
            <button type="button" onClick={() => { setOcrText(''); startOcrCapture() }}
              className="flex-1 py-3 rounded-lg bg-white/10 text-white font-medium flex items-center justify-center gap-2">
              <RotateCcw className="w-4 h-4" /> Retry
            </button>
            <button type="button" onClick={acceptOcr} disabled={!ocrText.trim()}
              className="flex-1 py-3 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-40">
              Look Up
            </button>
          </div>
          <button type="button" onClick={cancelOcr} className="w-full py-2 text-white/50 text-sm hover:text-white/80">Cancel</button>
        </div>
      </div>
    )
  }

  // Main search view + error states
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/95 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 shrink-0 border-b border-white/10">
        <h3 className="text-white font-semibold text-lg">Add Equipment</h3>
        <button type="button" onClick={onClose} className="text-white/60 hover:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {/* Error: Not Found */}
        {phase === 'not_found' && (
          <div className="mb-4 p-4 bg-amber-900/30 border border-amber-700/50 rounded-lg">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-300">Not Found</p>
                <p className="text-xs text-amber-300/70 mt-1">
                  No equipment with serial <span className="font-mono text-white">{errorSerial}</span> was found.
                  {!allowCreate && <> Make sure you've synced recently.</>}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {allowCreate && (
                    <button
                      type="button"
                      onClick={() => {
                        setCreateManufacturer('')
                        setCreateModel('')
                        setCreateCategory('monitor_personal')
                        setCreateDate('')
                        setCreateError(null)
                        setPhase('create_form')
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                    >
                      <Package className="w-3.5 h-3.5" />
                      Add this serial
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPhase('search')}
                    className="text-xs text-amber-400 underline underline-offset-2"
                  >
                    Try again
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Quick-create form */}
        {phase === 'create_form' && (
          <div className="mb-4 p-4 bg-emerald-900/20 border border-emerald-700/40 rounded-lg space-y-3">
            <div>
              <p className="text-sm font-semibold text-emerald-200">Add new unit</p>
              <p className="text-xs text-emerald-200/70 mt-0.5">
                Serial <span className="font-mono text-white">{errorSerial}</span> isn't on file. Enter make + model to add it.
              </p>
            </div>

            {createError && (
              <div className="px-3 py-2 rounded bg-red-900/30 border border-red-700/50 text-xs text-red-200">
                {createError}
              </div>
            )}

            <div className="space-y-2">
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-emerald-200/70 mb-1">Manufacturer *</label>
                <input
                  type="text"
                  value={createManufacturer}
                  onChange={e => setCreateManufacturer(e.target.value)}
                  placeholder="e.g. RAE Systems"
                  autoFocus
                  className="w-full px-3 py-2 rounded-md text-sm bg-white/10 text-white border border-white/20 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/30 outline-none placeholder-white/40"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-emerald-200/70 mb-1">Model *</label>
                <input
                  type="text"
                  value={createModel}
                  onChange={e => setCreateModel(e.target.value)}
                  placeholder="e.g. MultiRAE Lite"
                  className="w-full px-3 py-2 rounded-md text-sm bg-white/10 text-white border border-white/20 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/30 outline-none placeholder-white/40"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-emerald-200/70 mb-1">Type *</label>
                <select
                  value={createCategory}
                  onChange={e => setCreateCategory(e.target.value)}
                  className="w-full px-3 py-2 rounded-md text-sm bg-white/10 text-white border border-white/20 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/30 outline-none [&>option]:bg-slate-800"
                >
                  <option value="monitor_personal">Personal Monitor</option>
                  <option value="monitor_area">Area Monitor</option>
                  <option value="supplied_air_component">Supplied-Air Component</option>
                  <option value="sensor">Sensor</option>
                  <option value="accessory">Accessory</option>
                  <option value="misc">Other / Misc</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-emerald-200/70 mb-1">Serial</label>
                  <input
                    type="text"
                    value={errorSerial}
                    readOnly
                    className="w-full px-3 py-2 rounded-md text-sm font-mono bg-white/5 text-white/80 border border-white/10"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-emerald-200/70 mb-1">In-Service Date</label>
                  <input
                    type="date"
                    value={createDate}
                    onChange={e => setCreateDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-md text-sm bg-white/10 text-white border border-white/20 focus:border-emerald-400 outline-none [color-scheme:dark]"
                  />
                </div>
              </div>
              <p className="text-[11px] text-emerald-200/60 leading-snug">
                Owned by Basin Safety, status available — flagged for office review.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleQuickCreate}
                disabled={createSubmitting || !createManufacturer.trim() || !createModel.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium"
              >
                {createSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Add & Use
              </button>
              <button
                type="button"
                onClick={() => setPhase('not_found')}
                disabled={createSubmitting}
                className="px-3 py-2 text-xs text-white/60 hover:text-white"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Error: Wrong Status */}
        {phase === 'wrong_status' && (
          <div className="mb-4 p-4 bg-amber-900/30 border border-amber-700/50 rounded-lg">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-300">Not Available</p>
                <p className="text-xs text-amber-300/70 mt-1">
                  <span className="font-mono text-white">{errorSerial}</span> ({errorProductName}) is currently{' '}
                  <span className="font-semibold text-amber-400">{errorStatus}</span>.
                  Only <span className="font-semibold">{filterStatus}</span> equipment can be added.
                </p>
                <button
                  type="button"
                  onClick={() => setPhase('search')}
                  className="mt-2 text-xs text-amber-400 underline underline-offset-2"
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Search input — hidden while the quick-create form has focus */}
        {phase !== 'create_form' && (
        <div className="space-y-3">
          <form
            onSubmit={e => {
              e.preventDefault()
              handleSearch()
            }}
          >
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Type serial number or product name..."
                className="w-full pl-10 pr-4 py-3 rounded-lg text-base font-mono bg-white/10 text-white border border-white/20 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30 outline-none placeholder-white/40"
              />
            </div>

            <div className="flex gap-3 mt-3">
              <button
                type="submit"
                disabled={!query.trim() || searching}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-40 transition-colors"
              >
                {searching ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
                Search
              </button>
              <button
                type="button"
                onClick={() => setPhase('scanning')}
                className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-white/10 text-white font-medium hover:bg-white/20 transition-colors border border-white/20"
              >
                <Barcode className="w-5 h-5" />
                Scan
              </button>
              <button
                type="button"
                onClick={startOcrCapture}
                className="flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-white/10 text-white font-medium hover:bg-white/20 transition-colors border border-white/20"
                title="Photo OCR"
              >
                <Camera className="w-5 h-5" />
                OCR
              </button>
            </div>
          </form>
        </div>
        )}

        {/* Search Results */}
        {hasSearched && (
          <div className="mt-4">
            {results.length === 0 ? (
              <div className="text-center py-8 text-white/40">
                <Package className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No equipment found locally.</p>
                <p className="text-xs mt-1">Try syncing, or enter the exact serial and search again.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-white/50 mb-2">{results.length} result{results.length !== 1 ? 's' : ''}</p>
                {results.map(r => {
                  const isAvailable = r.equipment.status === filterStatus
                  return (
                    <button
                      key={r.equipment.id}
                      type="button"
                      onClick={() => handleSelectResult(r)}
                      disabled={!isAvailable}
                      className={`w-full text-left p-3 rounded-lg border transition-colors ${
                        isAvailable
                          ? 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20'
                          : 'bg-white/5 border-white/5 opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-white truncate">{r.product.name}</p>
                          <p className="text-xs text-white/60 font-mono">{r.equipment.serialNumber}</p>
                        </div>
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ml-2 shrink-0 ${
                          r.equipment.status === 'available' ? 'bg-green-900/50 text-green-400' :
                          r.equipment.status === 'rented' ? 'bg-blue-900/50 text-blue-400' :
                          'bg-amber-900/50 text-amber-400'
                        }`}>
                          {r.equipment.status}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
