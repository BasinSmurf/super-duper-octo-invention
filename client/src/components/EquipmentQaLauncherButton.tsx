import { useEffect, useState } from 'react'
import { MessageSquare, X, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/cn'

// Optional Equipment Q&A sidecar (separate web app, not part of Sundog).
// Gated on VITE_EQUIPMENT_QA_URL: unset → this component renders nothing.
// When set, we health-check once per page load and only show the button on
// a 200 — if the sidecar is down or unreachable, no button, no errors.
// To remove this feature entirely: delete this file + its one render line
// in ShopOrderDetailPage.
const QA_URL = ((import.meta.env.VITE_EQUIPMENT_QA_URL as string | undefined) || '').replace(/\/+$/, '')

// One health check shared by every button instance (there's one per WO item).
let healthPromise: Promise<boolean> | null = null
function sidecarIsUp(): Promise<boolean> {
  if (!QA_URL) return Promise.resolve(false)
  if (!healthPromise) {
    healthPromise = (async () => {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 2500)
        const res = await fetch(`${QA_URL}/api/health`, { signal: ctrl.signal })
        clearTimeout(timer)
        return res.ok
      } catch {
        return false
      }
    })()
  }
  return healthPromise
}

interface Props {
  serialNumber: string
  equipmentCategory: string
  equipmentDescription: string | null
  fexBrand: string | null
  fexSize: string | null
  fexType: string | null
}

export function EquipmentQaLauncherButton({
  serialNumber, equipmentCategory, equipmentDescription, fexBrand, fexSize, fexType,
}: Props) {
  const [available, setAvailable] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    sidecarIsUp().then(ok => { if (alive && ok) setAvailable(true) })
    return () => { alive = false }
  }, [])

  if (!available) return null

  const description = equipmentDescription || [fexBrand, fexSize, fexType].filter(Boolean).join(' ')
  const params = new URLSearchParams()
  if (description) params.set('description', description)
  if (equipmentCategory) params.set('category', equipmentCategory)
  if (serialNumber) params.set('serial', serialNumber)
  const qaHref = `${QA_URL}/qa?${params.toString()}`

  return (
    <>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        title="Ask about this equipment — manuals & specs"
        className={cn(
          'relative flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold',
          'bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 hover:border-blue-300 transition-colors',
          // speech-bubble tail
          "after:content-[''] after:absolute after:-bottom-[5px] after:left-2.5 after:w-2 after:h-2",
          'after:rotate-45 after:bg-inherit after:border-b after:border-r after:border-inherit',
        )}
      >
        <MessageSquare className="w-3 h-3" />
        Ask
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-3xl h-[85vh] flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 shrink-0">
              <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-blue-600" />
                Equipment Q&amp;A
                {serialNumber && <span className="text-xs font-normal text-slate-500">S/N {serialNumber}</span>}
              </h2>
              <div className="flex items-center gap-3">
                <a
                  href={qaHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-400 hover:text-slate-600"
                  title="Open in new tab"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
                <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600" aria-label="Close">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <iframe src={qaHref} title="Equipment Q&A" className="flex-1 w-full border-0" />
          </div>
        </div>
      )}
    </>
  )
}
