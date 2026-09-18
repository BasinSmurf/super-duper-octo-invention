/**
 * UnitCloseState — WI-05, the 48 hours between "done" and "final".
 *
 * The countdown is the point. A tech who can see "final in 6h" behaves
 * differently from one who thinks the record is already set in stone, and the
 * whole feature exists to make the difference actionable.
 *
 * The badge is deliberately quiet during the window and loud only when the
 * record is locked, because "you can still fix this" is the normal state and
 * normal states should not shout.
 */

import { useEffect, useState } from 'react'
import { Lock, Unlock, Clock, Loader2 } from 'lucide-react'

export interface CloseState {
  state: 'open' | 'soft' | 'hard'
  hardClosesAt: string | null
  msRemaining: number
  closedById: string | null
  unlockCount: number
  unlockReason: string | null
  canEdit: boolean
}

/** "6h 12m" / "48m" / "under a minute" — coarse on purpose; nobody acts on seconds. */
function humanizeRemaining(ms: number): string {
  if (ms <= 0) return 'any moment'
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return 'under a minute'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

interface Props {
  close: CloseState
  /** Platform admins only; absent for everyone else. */
  onUnlock?: (reason: string) => Promise<void>
}

export function UnitCloseState({ close, onUnlock }: Props) {
  // Recompute locally so the countdown moves without refetching the order.
  const [remaining, setRemaining] = useState(close.msRemaining)
  const [unlocking, setUnlocking] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    setRemaining(close.msRemaining)
    if (close.state !== 'soft') return
    const t = setInterval(() => setRemaining((r) => Math.max(0, r - 60_000)), 60_000)
    return () => clearInterval(t)
  }, [close.msRemaining, close.state])

  if (close.state === 'open') return null

  if (close.state === 'soft') {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
        <Clock className="w-3.5 h-3.5 shrink-0" />
        <span>
          Closed — editable for <span className="font-semibold">{humanizeRemaining(remaining)}</span>
          {close.unlockCount > 0 && (
            <span className="text-amber-600"> · reopened {close.unlockCount}×</span>
          )}
        </span>
      </div>
    )
  }

  // Hard closed.
  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-1.5 text-slate-600 bg-slate-100 border border-slate-200 rounded-md px-2 py-1">
        <Lock className="w-3.5 h-3.5 shrink-0" />
        <span>
          Closed — record is final
          {close.unlockCount > 0 && <span className="text-slate-500"> · reopened {close.unlockCount}×</span>}
        </span>
        {onUnlock && !promptOpen && (
          <button
            type="button"
            onClick={() => setPromptOpen(true)}
            className="ml-auto flex items-center gap-1 text-blue-700 hover:text-blue-800 font-medium"
          >
            <Unlock className="w-3 h-3" /> Reopen
          </button>
        )}
      </div>

      {promptOpen && onUnlock && (
        <div className="mt-1.5 p-2.5 rounded-md border border-blue-200 bg-blue-50 space-y-2">
          <p className="text-blue-900">
            Reopening gives this unit another 48 hours. The reason is stored on the record.
          </p>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why does this need reopening?"
            className="w-full px-2 py-1.5 border border-blue-200 rounded text-xs bg-white"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!reason.trim() || unlocking}
              onClick={async () => {
                setUnlocking(true)
                try {
                  await onUnlock(reason.trim())
                  setPromptOpen(false)
                  setReason('')
                } finally {
                  setUnlocking(false)
                }
              }}
              className="px-3 py-1.5 rounded text-xs font-semibold bg-blue-700 text-white hover:bg-blue-600 disabled:opacity-40"
            >
              {unlocking ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Reopen for 48h'}
            </button>
            <button
              type="button"
              onClick={() => { setPromptOpen(false); setReason('') }}
              className="px-2.5 py-1.5 rounded text-xs font-medium border border-slate-300 text-slate-600 bg-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export interface IdentityCandidate {
  itemId: string
  serialNumber: string
  candidateEquipmentId: string
  candidateLastSeenAt: string | null
  candidateCategory: string | null
  candidateCustomerName: string | null
}

/**
 * WI-05's one interruption: "you've worked on this unit before — is this the
 * same one?"
 *
 * Shown only for the ambiguous case. A serial with no existing record was
 * created silently at close and never reaches this component, because a prompt
 * whose only sane answer is "yes" just teaches people to dismiss prompts.
 */
export function IdentityPrompt({
  candidate,
  onResolve,
}: {
  candidate: IdentityCandidate
  onResolve: (sameUnit: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  async function answer(sameUnit: boolean) {
    setBusy(true)
    try { await onResolve(sameUnit) } finally { setBusy(false) }
  }

  const lastSeen = candidate.candidateLastSeenAt
    ? new Date(candidate.candidateLastSeenAt).toLocaleDateString()
    : null

  return (
    <div className="p-3 rounded-lg border border-indigo-200 bg-indigo-50 space-y-2">
      <p className="text-xs font-semibold text-indigo-900">
        You&rsquo;ve worked on <span className="font-mono">{candidate.serialNumber}</span> before —
        is this the same one?
      </p>
      <p className="text-[11px] text-indigo-800">
        There is an existing record for this serial
        {candidate.candidateCategory && <> ({candidate.candidateCategory})</>}
        {candidate.candidateCustomerName && <>, last held by {candidate.candidateCustomerName}</>}
        {lastSeen && <>, last updated {lastSeen}</>}.
        {' '}Saying yes adds this job to that unit&rsquo;s history.
      </p>
      <div className="flex gap-2">
        <button
          type="button" disabled={busy} onClick={() => answer(true)}
          className="px-3 py-2 rounded-lg text-xs font-semibold bg-indigo-700 text-white hover:bg-indigo-600 disabled:opacity-40"
        >
          Yes — same unit
        </button>
        <button
          type="button" disabled={busy} onClick={() => answer(false)}
          className="px-3 py-2 rounded-lg text-xs font-medium border border-indigo-300 text-indigo-800 bg-white hover:bg-indigo-100 disabled:opacity-40"
        >
          No — different unit
        </button>
      </div>
    </div>
  )
}
