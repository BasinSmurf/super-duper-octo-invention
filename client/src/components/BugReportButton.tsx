import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Bug, X, Loader2, Check } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useSync } from '@/contexts/SyncContext'
import { getRecentLogs } from '@/lib/consoleBuffer'

type ReportType = 'bug' | 'feature'
type Phase = 'idle' | 'capturing' | 'form' | 'sending' | 'done' | 'error'

/**
 * Self-contained "Report Bug / Request Feature" control for the sidebar.
 *
 * Deliberately decoupled from the offline sync layer: the report fires via a
 * plain authenticated fetch (api.post), NOT the Dexie mutation queue or service
 * worker, so it still works when sync is wedged. The screenshot is captured via
 * html2canvas, lazy-imported only on click so it never touches the main bundle
 * or runs unless used — and if capture fails, the report still sends without it.
 */
export function BugReportButton() {
  const { user } = useAuth()
  const { isOnline, syncState } = useSync()

  const [phase, setPhase] = useState<Phase>('idle')
  const [type, setType] = useState<ReportType>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')

  async function open() {
    setType('bug')
    setTitle('')
    setDescription('')
    setScreenshot(null)
    setErrorMsg('')
    setPhase('capturing')
    // Capture the current view BEFORE the modal covers it.
    try {
      const { default: html2canvas } = await import('html2canvas-pro')
      // Crop to the VIEWPORT, not the whole document. Rendering all of
      // document.body paints position:fixed chrome (sidebar, header) at
      // document coordinates instead of where it floats on screen, which
      // smears the shell across the content. windowWidth/Height must match the
      // live window too — html2canvas lays its clone out at that size, and
      // clientWidth (scrollbar excluded) is narrow enough to trip a responsive
      // breakpoint, giving you two layouts composited at different offsets.
      const canvas = await html2canvas(document.body, {
        logging: false,
        useCORS: true,
        scale: Math.min(window.devicePixelRatio || 1, 1.5),
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
      })
      setScreenshot(canvas.toDataURL('image/jpeg', 0.7))
    } catch (e) {
      // Capture failed — proceed without a screenshot, but log it so it rides
      // along in the report's own captured logs for diagnosis.
      console.warn('[bug-report] screenshot capture failed', e)
      setScreenshot(null)
    }
    setPhase('form')
  }

  function close() {
    setPhase('idle')
  }

  async function submit() {
    if (!title.trim()) return
    setPhase('sending')
    setErrorMsg('')

    const payload = {
      type,
      title: title.trim(),
      description: description.trim(),
      screenshot, // data URL or null
      context: {
        url: window.location.href,
        route: window.location.pathname + window.location.search,
        userName: user?.name,
        userRole: user?.role,
        isOnline,
        sync: {
          status: syncState.status,
          pendingMutations: syncState.pendingMutations,
          lastSyncedAt: syncState.lastSyncedAt,
          error: syncState.error,
        },
        userAgent: navigator.userAgent,
        screen: `${window.innerWidth}x${window.innerHeight}`,
        appVersion: (import.meta as { env?: Record<string, string> }).env?.VITE_APP_VERSION,
        capturedAt: new Date().toISOString(),
      },
      logs: getRecentLogs(),
    }

    try {
      // Direct authenticated fetch — intentionally NOT through the sync queue.
      const token = localStorage.getItem('sundog_token')
      const res = await fetch('/api/bug-reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Failed (${res.status})`)
      }
      setPhase('done')
      setTimeout(close, 1800)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send report')
      setPhase('error')
    }
  }

  return (
    <>
      <button
        onClick={open}
        disabled={phase === 'capturing'}
        className="flex items-center gap-2 px-3 py-2 text-sm text-slate-400 hover:text-white transition-colors w-full rounded-lg hover:bg-slate-800 disabled:opacity-60"
      >
        {phase === 'capturing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bug className="w-4 h-4" />}
        Report Bug / Request Feature
      </button>

      {(phase === 'form' || phase === 'sending' || phase === 'done' || phase === 'error') && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto text-slate-900">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-base font-semibold">Report Bug / Request Feature</h2>
              <button onClick={close} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            {phase === 'done' ? (
              <div className="px-5 py-10 flex flex-col items-center gap-3 text-center">
                <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                  <Check className="w-6 h-6 text-green-600" />
                </div>
                <p className="font-medium">Thanks — your report was sent.</p>
              </div>
            ) : (
              <div className="px-5 py-4 space-y-4">
                {/* Type toggle */}
                <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                  {(['bug', 'feature'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setType(t)}
                      className={
                        'flex-1 py-2 text-sm font-medium transition-colors ' +
                        (type === t ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50')
                      }
                    >
                      {t === 'bug' ? '🐞 Bug' : '💡 Feature request'}
                    </button>
                  ))}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">
                    {type === 'bug' ? 'What went wrong?' : 'What would you like?'} <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={type === 'bug' ? 'Short summary' : 'Short summary'}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Details</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={4}
                    placeholder="Steps, what you expected, anything else helpful…"
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  />
                </div>

                {/* Screenshot preview */}
                <div>
                  <p className="text-xs font-medium text-slate-500 mb-1">
                    Screenshot {screenshot ? '(attached)' : '(not captured)'}
                  </p>
                  {screenshot ? (
                    <img src={screenshot} alt="screenshot preview" className="w-full rounded-lg border border-slate-200" />
                  ) : (
                    <p className="text-xs text-slate-400">No screenshot was captured. Your report will still send.</p>
                  )}
                </div>

                {phase === 'error' && <p className="text-sm text-red-600">{errorMsg}</p>}

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={close}
                    className="flex-1 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submit}
                    disabled={!title.trim() || phase === 'sending'}
                    className="flex-1 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {phase === 'sending' && <Loader2 className="w-4 h-4 animate-spin" />}
                    {phase === 'sending' ? 'Sending…' : 'Send report'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
