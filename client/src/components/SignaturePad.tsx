import { useRef, useEffect, useState } from 'react'
import { Eraser, Check } from 'lucide-react'

interface SignaturePadProps {
  value: string | null  // base64 data URL
  onChange: (dataUrl: string | null) => void
  label?: string
}

export function SignaturePad({ value, onChange, label = 'Customer Signature' }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [hasStrokes, setHasStrokes] = useState(false)
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas size to match display size
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * 2  // retina
    canvas.height = rect.height * 2
    ctx.scale(2, 2)

    // White background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, rect.width, rect.height)

    // Signature line
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(20, rect.height - 30)
    ctx.lineTo(rect.width - 20, rect.height - 30)
    ctx.stroke()

    // "X" mark
    ctx.fillStyle = '#94a3b8'
    ctx.font = '14px sans-serif'
    ctx.fillText('✕', 10, rect.height - 20)

    // Drawing style
    ctx.strokeStyle = '#1e293b'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }, [isOpen])

  function getPos(e: React.TouchEvent | React.MouseEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()

    if ('touches' in e) {
      const touch = e.touches[0]
      if (!touch) return null
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top }
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top }
  }

  function startDrawing(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault()
    const pos = getPos(e)
    if (!pos) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.beginPath()
    ctx.moveTo(pos.x, pos.y)
    setIsDrawing(true)
    setHasStrokes(true)
  }

  function draw(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault()
    if (!isDrawing) return
    const pos = getPos(e)
    if (!pos) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.lineTo(pos.x, pos.y)
    ctx.stroke()
  }

  function stopDrawing(e: React.TouchEvent | React.MouseEvent) {
    e.preventDefault()
    setIsDrawing(false)
  }

  function clear() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const rect = canvas.getBoundingClientRect()
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, rect.width, rect.height)

    // Redraw signature line
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(20, rect.height - 30)
    ctx.lineTo(rect.width - 20, rect.height - 30)
    ctx.stroke()

    ctx.fillStyle = '#94a3b8'
    ctx.font = '14px sans-serif'
    ctx.fillText('✕', 10, rect.height - 20)

    // Restore drawing style
    ctx.strokeStyle = '#1e293b'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    setHasStrokes(false)
  }

  function accept() {
    const canvas = canvasRef.current
    if (!canvas) return
    const dataUrl = canvas.toDataURL('image/png')
    onChange(dataUrl)
    setIsOpen(false)
  }

  // Compact display when not editing
  if (!isOpen) {
    return (
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
        {value ? (
          <div className="relative border border-slate-200 rounded-lg overflow-hidden bg-white">
            <img src={value} alt="Signature" className="w-full h-20 object-contain" />
            <button
              type="button"
              onClick={() => { onChange(null); setIsOpen(true); setHasStrokes(false) }}
              className="absolute top-1 right-1 px-2 py-1 bg-white/80 rounded text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              Redo
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            className="w-full py-4 border-2 border-dashed border-slate-300 rounded-lg text-slate-400 hover:text-slate-600 hover:border-slate-400 transition-colors flex items-center justify-center gap-2"
          >
            <span className="text-lg">✍️</span>
            <span className="text-sm font-medium">Tap to sign</span>
          </button>
        )}
      </div>
    )
  }

  // Full signature modal
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full sm:max-w-lg bg-white sm:rounded-xl rounded-t-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-medium text-slate-900">{label}</h3>
          <button type="button" onClick={() => setIsOpen(false)} className="text-sm text-slate-500">Cancel</button>
        </div>

        <div className="p-4">
          <canvas
            ref={canvasRef}
            className="w-full h-48 border border-slate-200 rounded-lg cursor-crosshair touch-none"
            onMouseDown={startDrawing}
            onMouseMove={draw}
            onMouseUp={stopDrawing}
            onMouseLeave={stopDrawing}
            onTouchStart={startDrawing}
            onTouchMove={draw}
            onTouchEnd={stopDrawing}
          />
        </div>

        <div className="px-4 pb-4 flex gap-3">
          <button
            type="button"
            onClick={clear}
            className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50 font-medium text-sm"
          >
            <Eraser className="w-4 h-4" />
            Clear
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={accept}
            disabled={!hasStrokes}
            className="flex items-center gap-2 px-6 py-2 bg-blue-800 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Check className="w-4 h-4" />
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
