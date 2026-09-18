import { useState, useEffect } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { SignaturePad } from '@/components/SignaturePad'
import { GraduationCap, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

interface ClassInfo {
  courseName: string
  trainerName: string | null
  companyName: string | null
  serviceDate: string
  signedInCount: number
}

/**
 * #13 Public training sign-in — students land here from the class QR code.
 * No login: the route is keyed by the unguessable per-class token and only
 * works while the class is open. Name + signature land on the roster.
 */
export function TrainSignInPage() {
  const { token } = useParams<{ token: string }>()
  // Kiosk mode: reached from the classroom wall board's "Sign in here" button.
  // After a successful sign-in we bounce back to the board so the next student
  // can pick their class.
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const kioskMode = params.get('kiosk') === '1'
  const [info, setInfo] = useState<ClassInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [name, setName] = useState('')
  const [employer, setEmployer] = useState('')
  const [phone, setPhone] = useState('')
  const [signature, setSignature] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!token) return
    ;(async () => {
      try {
        const data = await api.get<ClassInfo>(`/train/${token}`)
        setInfo(data)
      } catch {
        setLoadError('This sign-in link is invalid or the class is closed. See the trainer.')
      }
      setLoading(false)
    })()
  }, [token])

  // On a wall kiosk, auto-return to the class board a few seconds after a
  // successful sign-in so the display doesn't sit on one student's screen.
  useEffect(() => {
    if (!done || !kioskMode) return
    const t = setTimeout(() => navigate(-1), 4000)
    return () => clearTimeout(t)
  }, [done, kioskMode, navigate])

  async function handleSubmit() {
    if (!name.trim() || !signature || submitting) return
    setSubmitting(true)
    setSubmitError('')
    try {
      await api.post(`/train/${token}`, {
        employeeName: name.trim(),
        employerName: employer.trim() || undefined,
        contactPhone: phone.trim() || undefined,
        signature,
      })
      setDone(true)
    } catch (e: any) {
      setSubmitError(e?.message || 'Could not sign in — try again or see the trainer.')
    }
    setSubmitting(false)
  }

  function resetForNext() {
    setName('')
    setEmployer('')
    setPhone('')
    setSignature(null)
    setSubmitError('')
    setDone(false)
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <div className="min-h-screen bg-slate-100 flex items-start justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg my-6 overflow-hidden">
        {/* Header */}
        <div className="bg-blue-800 text-white px-5 py-4">
          <div className="flex items-center gap-2.5">
            <GraduationCap className="w-6 h-6" />
            <div>
              <h1 className="font-bold text-lg leading-tight">Class Sign-In</h1>
              <p className="text-xs text-blue-200">Basin Safety</p>
            </div>
          </div>
        </div>

        <div className="p-5">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
            </div>
          ) : loadError ? (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800">{loadError}</p>
            </div>
          ) : done ? (
            <div className="text-center py-10">
              <CheckCircle2 className="w-14 h-14 text-green-500 mx-auto mb-3" />
              <p className="text-lg font-semibold text-slate-900">You're signed in!</p>
              <p className="text-sm text-slate-500 mt-1">{info?.courseName} — {today}</p>
              {kioskMode ? (
                <>
                  <button
                    type="button"
                    onClick={() => navigate(-1)}
                    className="mt-6 px-5 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-600"
                  >
                    Back to classes
                  </button>
                  <p className="text-xs text-slate-400 mt-3">Returning to the board…</p>
                </>
              ) : (
                <button
                  type="button"
                  onClick={resetForNext}
                  className="mt-6 px-5 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-600"
                >
                  Sign in another person
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Class info */}
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="font-semibold text-slate-900">{info?.courseName}</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {today}
                  {info?.trainerName && <> · Trainer: {info.trainerName}</>}
                  {info?.companyName && <> · {info.companyName}</>}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Your Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="First and last name"
                  autoComplete="name"
                  className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Employer</label>
                <input
                  type="text"
                  value={employer}
                  onChange={e => setEmployer(e.target.value)}
                  placeholder="Company you work for"
                  autoComplete="organization"
                  className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Phone <span className="text-slate-400 font-normal">— for your card</span></label>
                <input
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="Optional"
                  autoComplete="tel"
                  className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-base focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>

              <SignaturePad value={signature} onChange={setSignature} label="Sign here" />

              {submitError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{submitError}</p>
              )}

              <button
                type="button"
                onClick={handleSubmit}
                disabled={!name.trim() || !signature || submitting}
                className="w-full py-3.5 rounded-xl bg-blue-800 text-white font-semibold disabled:opacity-40 hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Sign In to Class
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
