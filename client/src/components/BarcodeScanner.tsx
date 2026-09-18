import { useRef, useState, useEffect, useCallback } from 'react'
import { Html5Qrcode, Html5QrcodeScannerState, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import { X, Keyboard, Camera } from 'lucide-react'

interface BarcodeScannerProps {
  onScan: (value: string) => void
  onClose: () => void
  label?: string
}

const SCANNER_ID = 'sundog-barcode-reader'

// All common 1D + 2D barcode formats
const SUPPORTED_FORMATS = [
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.CODABAR,
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
]

export function BarcodeScanner({ onScan, onClose, label = 'Scan Serial Number' }: BarcodeScannerProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const [error, setError] = useState('')
  const [manualMode, setManualMode] = useState(false)
  const [manualValue, setManualValue] = useState('')
  const [cameraReady, setCameraReady] = useState(false)
  const hasScannedRef = useRef(false)

  const stopScanner = useCallback(async () => {
    try {
      const scanner = scannerRef.current
      if (scanner) {
        const state = scanner.getState()
        if (state === Html5QrcodeScannerState.SCANNING || state === Html5QrcodeScannerState.PAUSED) {
          await scanner.stop()
        }
        scanner.clear()
        scannerRef.current = null
      }
    } catch {
      // Ignore cleanup errors
    }
  }, [])

  useEffect(() => {
    if (manualMode) return

    let cancelled = false

    async function startScanner() {
      try {
        const scanner = new Html5Qrcode(SCANNER_ID, {
          formatsToSupport: SUPPORTED_FORMATS,
          verbose: false,
        })
        scannerRef.current = scanner

        // Use facingMode constraint directly — more reliable than camera ID on iOS
        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 15,
            // Big scan region — nearly full viewfinder so barcodes read at arm's length
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              const width = Math.min(Math.floor(viewfinderWidth * 0.85), 700)
              const height = Math.min(Math.floor(viewfinderHeight * 0.6), 400)
              return { width, height }
            },
            // Request high resolution from iPad camera
            videoConstraints: {
              facingMode: 'environment',
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
          },
          (decodedText) => {
            if (hasScannedRef.current) return
            hasScannedRef.current = true

            stopScanner().then(() => {
              onScan(decodedText)
            })
          },
          () => {
            // No match this frame — expected, ignore
          },
        )

        if (!cancelled) {
          setCameraReady(true)
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('BarcodeScanner start error:', msg)
          if (msg.includes('NotAllowedError') || msg.includes('Permission')) {
            setError('Camera permission denied. Use manual entry.')
          } else if (msg.includes('NotFoundError') || msg.includes('DevicesNotFound')) {
            setError('No camera found. Use manual entry.')
          } else {
            setError(`Camera error: ${msg.slice(0, 80)}`)
          }
          setManualMode(true)
        }
      }
    }

    startScanner()

    return () => {
      cancelled = true
      stopScanner()
    }
  }, [manualMode, stopScanner, onScan])

  function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (manualValue.trim()) {
      stopScanner()
      onScan(manualValue.trim())
    }
  }

  function handleClose() {
    stopScanner()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 shrink-0">
        <h3 className="text-white font-medium">{label}</h3>
        <button type="button" onClick={handleClose} className="w-10 h-10 flex items-center justify-center">
          <X className="w-6 h-6 text-white" />
        </button>
      </div>

      {manualMode ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <form onSubmit={handleManualSubmit} className="w-full max-w-sm space-y-4">
            <div>
              <label className="block text-sm font-medium text-white mb-2">Enter Serial Number</label>
              <input
                type="text"
                value={manualValue}
                onChange={e => setManualValue(e.target.value)}
                placeholder="Type or paste serial number"
                autoFocus
                className="w-full px-4 py-3 rounded-lg text-lg font-mono bg-white/10 text-white border border-white/30 focus:border-white focus:ring-2 focus:ring-white/50 outline-none placeholder-white/40"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { setManualMode(false); setError(''); hasScannedRef.current = false }}
                className="flex-1 py-3 rounded-lg bg-white/10 text-white font-medium flex items-center justify-center gap-2"
              >
                <Camera className="w-4 h-4" />
                Try Camera
              </button>
              <button
                type="submit"
                disabled={!manualValue.trim()}
                className="flex-1 py-3 rounded-lg bg-blue-600 text-white font-medium disabled:opacity-40"
              >
                Confirm
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <div className="flex-1 relative overflow-hidden">
            {/* html5-qrcode mounts its video + canvas inside this div */}
            <div
              id={SCANNER_ID}
              className="w-full h-full"
            />

            {!cameraReady && !error && (
              <div className="absolute inset-0 flex items-center justify-center bg-black">
                <div className="text-white/60 text-sm animate-pulse">Starting camera...</div>
              </div>
            )}

            {/* Instruction text */}
            {cameraReady && (
              <div className="absolute top-4 left-0 right-0 text-center">
                <span className="bg-black/60 text-white/80 text-xs px-3 py-1 rounded-full">
                  Center barcode in the box
                </span>
              </div>
            )}

            {error && (
              <div className="absolute bottom-4 left-4 right-4 p-3 bg-amber-500/90 text-white text-sm rounded-lg text-center">
                {error}
              </div>
            )}
          </div>

          <div className="p-4 shrink-0">
            <button
              type="button"
              onClick={() => { stopScanner(); setManualMode(true) }}
              className="w-full py-3 rounded-lg bg-white/10 text-white font-medium flex items-center justify-center gap-2"
            >
              <Keyboard className="w-4 h-4" />
              Type Manually
            </button>
          </div>
        </>
      )}
    </div>
  )
}
