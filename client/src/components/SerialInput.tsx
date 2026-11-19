/**
 * SerialInput — unified serial number capture component.
 *
 * Flow: Tap scan → try barcode first → if no decode, offer "Try Photo OCR"
 * which captures a photo and runs tesseract.js on it.
 *
 * Usage:
 *   <SerialInput
 *     value={serial}
 *     onChange={setSerial}
 *     label="S/N Installed"
 *     placeholder="Scan or type serial number"
 *   />
 */

import { useState, useRef, useCallback } from 'react'
import { BarcodeScanner } from './BarcodeScanner'
import { ScanBarcode, Camera, Loader2, X, RotateCcw } from 'lucide-react'

interface SerialInputProps {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
}

type Phase = 'idle' | 'barcode' | 'ocr_capture' | 'ocr_processing' | 'ocr_result'

export function SerialInput({
  value,
  onChange,
  label = 'Serial Number',
  placeholder = 'Scan or type serial number',
}: SerialInputProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [ocrText, setOcrText] = useState('')
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrError, setOcrError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  // --- Barcode scan success ---
  const handleBarcodeScan = useCallback((scanned: string) => {
    onChange(scanned)
    setPhase('idle')
  }, [onChange])

  // --- Barcode close → offer OCR ---
  const handleBarcodeClose = useCallback(() => {
    setPhase('idle')
  }, [])

  // --- Start OCR capture (camera preview) ---
  const startOcrCapture = useCallback(async () => {
    setPhase('ocr_capture')
    setOcrError('')
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
      setOcrError('Camera access denied')
      setPhase('idle')
    }
  }, [])

  // --- Capture photo and run OCR ---
  const captureAndOcr = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    // Capture frame
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)

    // Stop camera
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null

    setPhase('ocr_processing')
    setOcrProgress(0)

    try {
      // Dynamic import — tesseract.js is ~2MB, only load when needed
      const Tesseract = await import('tesseract.js')

      const result = await Tesseract.recognize(canvas, 'eng', {
        logger: (m: any) => {
          if (m.status === 'recognizing text') {
            setOcrProgress(Math.round((m.progress || 0) * 100))
          }
        },
      })

      const text = result.data.text.trim()
      if (text) {
        // Try to extract something that looks like a serial number
        // Serial numbers are typically alphanumeric, possibly with dashes
        const candidates = text
          .split(/[\n\r]+/)
          .map(line => line.trim())
          .filter(line => line.length >= 3 && line.length <= 40)
          .map(line => line.replace(/[^A-Za-z0-9\-_.\/]/g, ''))
          .filter(line => line.length >= 3)

        if (candidates.length > 0) {
          setOcrText(candidates[0])
          setPhase('ocr_result')
        } else {
          setOcrText(text.substring(0, 60))
          setPhase('ocr_result')
        }
      } else {
        setOcrError('No text detected. Try again with better lighting.')
        setPhase('idle')
      }
    } catch (err) {
      console.error('OCR error:', err)
      setOcrError('OCR failed. Try entering manually.')
      setPhase('idle')
    }
  }, [])

  // --- Accept OCR result ---
  const acceptOcr = useCallback(() => {
    onChange(ocrText)
    setPhase('idle')
    setOcrText('')
  }, [ocrText, onChange])

  // --- Cancel / cleanup ---
  const cancel = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setPhase('idle')
    setOcrText('')
    setOcrError('')
  }, [])

  // --- Barcode scanner overlay ---
  if (phase === 'barcode') {
    return (
      <BarcodeScanner
        label={label}
        onScan={handleBarcodeScan}
        onClose={handleBarcodeClose}
      />
    )
  }

  // --- OCR camera capture overlay ---
  if (phase === 'ocr_capture') {
    return (
      <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
        <div className="flex items-center justify-between p-4 shrink-0">
          <h3 className="text-white font-medium">Photo OCR — {label}</h3>
          <button type="button" onClick={cancel} className="w-10 h-10 flex items-center justify-center">
            <X className="w-6 h-6 text-white" />
          </button>
        </div>

        <div className="flex-1 relative overflow-hidden">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          <div className="absolute top-4 left-0 right-0 text-center">
            <span className="bg-black/60 text-white/80 text-xs px-3 py-1 rounded-full">
              Center serial number label in frame
            </span>
          </div>
        </div>

        <div className="p-4 shrink-0">
          <button
            type="button"
            onClick={captureAndOcr}
            className="w-full py-4 rounded-lg bg-blue-600 text-white font-semibold text-lg flex items-center justify-center gap-2 active:scale-[0.98]"
          >
            <Camera className="w-5 h-5" />
            Capture & Read
          </button>
        </div>

        <canvas ref={canvasRef} className="hidden" />
      </div>
    )
  }

  // --- OCR processing overlay ---
  if (phase === 'ocr_processing') {
    return (
      <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 text-blue-400 animate-spin mx-auto" />
          <div>
            <p className="text-white font-medium">Reading text...</p>
            <p className="text-white/60 text-sm mt-1">{ocrProgress}%</p>
          </div>
          <div className="w-48 h-1.5 bg-white/10 rounded-full mx-auto overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${ocrProgress}%` }}
            />
          </div>
        </div>
        <canvas ref={canvasRef} className="hidden" />
      </div>
    )
  }

  // --- OCR result confirmation overlay ---
  if (phase === 'ocr_result') {
    return (
      <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-4">
          <p className="text-white/60 text-sm text-center">OCR detected:</p>
          <input
            type="text"
            value={ocrText}
            onChange={e => setOcrText(e.target.value)}
            autoFocus
            className="w-full px-4 py-3 rounded-lg text-lg font-mono bg-white/10 text-white border border-white/30 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/50 outline-none text-center"
          />
          <p className="text-white/40 text-xs text-center">Edit if needed, then confirm</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setOcrText(''); startOcrCapture() }}
              className="flex-1 py-3 rounded-lg bg-white/10 text-white font-medium flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Retry
            </button>
            <button
              type="button"
              onClick={acceptOcr}
              disabled={!ocrText.trim()}
              className="flex-1 py-3 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-40"
            >
              Confirm
            </button>
          </div>
          <button
            type="button"
            onClick={cancel}
            className="w-full py-2 text-white/50 text-sm hover:text-white/80"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // --- Default: inline input + scan button ---
  return (
    <div>
      {label && <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>}
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
        <button
          type="button"
          onClick={() => setPhase('barcode')}
          className="px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors"
          title="Scan barcode"
        >
          <ScanBarcode className="w-5 h-5 text-slate-600" />
        </button>
        <button
          type="button"
          onClick={startOcrCapture}
          className="px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors"
          title="Photo OCR"
        >
          <Camera className="w-5 h-5 text-slate-600" />
        </button>
      </div>
      {ocrError && (
        <p className="text-xs text-amber-600 mt-1">{ocrError}</p>
      )}
    </div>
  )
}
