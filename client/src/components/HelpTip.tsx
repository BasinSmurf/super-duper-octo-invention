import { useEffect, useId, useState } from 'react'
import { CircleHelp } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { helpTipsVisible } from '@/lib/helpTips'

/** Place beside a control, never inside another button or a select. */
export function HelpTip({ text }: { text: string }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now)
  const id = useId()
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  if (!user || !helpTipsVisible(user.helpTipsStartedAt, user.helpTipsEnabled, now)) return null
  return (
    <span className="relative inline-flex align-middle ml-1 font-normal" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label="Help" aria-describedby={open ? id : undefined}
        aria-expanded={open} onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }}
        className="inline-flex items-center justify-center w-7 h-7 rounded-full text-slate-400 hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500">
        <CircleHelp className="w-4 h-4" />
      </button>
      {open && <span id={id} role="tooltip" className="absolute left-0 top-full z-50 w-56 max-w-[75vw] rounded-lg bg-slate-900 p-3 text-left text-xs leading-relaxed text-white shadow-lg">{text}</span>}
    </span>
  )
}

