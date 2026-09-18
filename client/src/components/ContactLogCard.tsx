/**
 * ContactLogCard — WI-10. One component, both parties.
 *
 * "Communicated to Customer" and "Communicated with Vendor" are the same card
 * with a different `party`. Building two would have meant two places to fix the
 * next time an entry needs a field, and they would have drifted by the second
 * one.
 *
 * APPEND-ONLY, VISIBLY. There is no edit affordance because there is no edit
 * path — the database refuses it. A supervisor can remove an entry, and has to
 * say why; the row survives, marked, and simply stops being listed here.
 *
 * THE FOLLOW-UP DATE IS THE POINT OF THE WHOLE FEATURE. "Waiting 30 days" is a
 * much smaller fire when the card says somebody rang on Tuesday and the vendor
 * promised the 1st. It is optional because plenty of calls make no promise, and
 * a required date would be answered with a guess.
 */

import { useState } from 'react'
import { Loader2, Phone, Trash2, CalendarClock } from 'lucide-react'
import type { ContactParty, ShopContactLogEntry, ShopContactMethod } from '@/lib/db-types'

const METHOD_LABEL: Record<string, string> = {
  call: 'Called',
  email: 'Emailed',
  text: 'Texted',
  in_person: 'In person',
  other: 'Other',
}

const PARTY_COPY: Record<ContactParty, { title: string; blurb: string; placeholder: string }> = {
  customer: {
    title: 'Communicated to Customer',
    blurb: 'Record each time you reach out — this never changes the status.',
    placeholder: 'Left voicemail, no answer, …',
  },
  vendor: {
    title: 'Communicated with Vendor',
    blurb: 'Chasing an outside repair — log the call and the ETA you were given.',
    placeholder: 'Called DFE about this job, ETA 9/1',
  },
}

/** Local-midnight `YYYY-MM-DDTHH:mm` for a datetime-local max attribute. */
function localNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function overdueLabel(iso: string): { text: string; overdue: boolean } {
  const due = new Date(iso).getTime()
  const ms = Date.now() - due
  if (ms < 0) return { text: `follow up ${new Date(iso).toLocaleDateString()}`, overdue: false }
  const days = Math.floor(ms / 86_400_000)
  if (days === 0) return { text: 'follow-up due today', overdue: true }
  return { text: `follow-up ${days} day${days === 1 ? '' : 's'} overdue`, overdue: true }
}

interface Props {
  party: ContactParty
  entries: ShopContactLogEntry[]
  /** Supervisors only; absent for everyone else, so no delete affordance renders. */
  onDelete?: (entryId: string, reason: string) => Promise<void>
  onAdd: (input: {
    party: ContactParty
    method: ShopContactMethod
    note: string
    contactedAt: string
    followUpAt: string | null
  }) => Promise<void>
}

export function ContactLogCard({ party, entries, onAdd, onDelete }: Props) {
  const [method, setMethod] = useState<ShopContactMethod>('call')
  const [note, setNote] = useState('')
  const [when, setWhen] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteReason, setDeleteReason] = useState('')

  const copy = PARTY_COPY[party]
  const mine = entries
    .filter(e => e.party === party && !e.deletedAt)
    .sort((a, b) => b.contactedAt.localeCompare(a.contactedAt))

  async function add() {
    if (!note.trim()) { setError('A note is required — what was said is the point of the entry.'); return }
    setSaving(true)
    setError('')
    try {
      await onAdd({
        party,
        method,
        note: note.trim(),
        contactedAt: when ? new Date(when).toISOString() : new Date().toISOString(),
        followUpAt: followUp ? new Date(followUp).toISOString() : null,
      })
      setNote(''); setWhen(''); setFollowUp('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the entry')
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete(entryId: string) {
    if (!deleteReason.trim() || !onDelete) return
    setSaving(true)
    try {
      await onDelete(entryId, deleteReason.trim())
      setDeleting(null); setDeleteReason('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the entry')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <h3 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
        <Phone className="w-3.5 h-3.5 text-slate-400" />
        {copy.title}
      </h3>
      <p className="text-xs text-slate-500 mb-3">{copy.blurb}</p>

      {mine.length > 0 ? (
        <div className="space-y-2 mb-3">
          {mine.map(e => {
            const fu = e.followUpAt ? overdueLabel(e.followUpAt) : null
            return (
              <div key={e.id} className="flex items-start gap-2 text-sm border-b border-slate-50 pb-2">
                <span className="shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 mt-0.5">
                  {METHOD_LABEL[e.method] ?? e.method}
                </span>
                <div className="flex-1 min-w-0">
                  {e.note && <p className="text-slate-800">{e.note}</p>}
                  <p className="text-xs text-slate-400">
                    {new Date(e.contactedAt).toLocaleString()}
                    {e.enteredByName ? ` · ${e.enteredByName}` : ''}
                  </p>
                  {fu && (
                    <p className={`text-[11px] mt-0.5 inline-flex items-center gap-1 ${
                      fu.overdue ? 'text-amber-700 font-medium' : 'text-slate-500'
                    }`}>
                      <CalendarClock className="w-3 h-3" />
                      {fu.text}
                    </p>
                  )}

                  {deleting === e.id && (
                    <div className="mt-1.5 p-2 rounded border border-red-200 bg-red-50 space-y-1.5">
                      <p className="text-[11px] text-red-900">
                        The entry is kept and marked removed, with your reason, so the trail stays intact.
                      </p>
                      <input
                        autoFocus
                        value={deleteReason}
                        onChange={ev => setDeleteReason(ev.target.value)}
                        placeholder="Why is this being removed?"
                        className="w-full px-2 py-1 border border-red-200 rounded text-xs bg-white"
                      />
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          disabled={!deleteReason.trim() || saving}
                          onClick={() => confirmDelete(e.id)}
                          className="px-2.5 py-1 rounded text-[11px] font-semibold bg-red-700 text-white disabled:opacity-40"
                        >
                          Remove entry
                        </button>
                        <button
                          type="button"
                          onClick={() => { setDeleting(null); setDeleteReason('') }}
                          className="px-2 py-1 rounded text-[11px] border border-slate-300 text-slate-600 bg-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {onDelete && deleting !== e.id && (
                  <button
                    type="button"
                    title="Remove (reason required)"
                    onClick={() => { setDeleting(e.id); setDeleteReason('') }}
                    className="shrink-0 text-slate-300 hover:text-red-600"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-xs text-slate-400 italic mb-3">Nothing logged yet.</p>
      )}

      <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 space-y-2">
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={method}
            onChange={e => setMethod(e.target.value as ShopContactMethod)}
            className="px-2 py-1.5 border border-slate-300 rounded text-sm bg-white"
          >
            <option value="call">Called</option>
            <option value="email">Emailed</option>
            <option value="text">Texted</option>
            <option value="in_person">In-person</option>
            <option value="other">Other</option>
          </select>
          <input
            type="datetime-local"
            value={when}
            max={localNow()}
            onChange={e => setWhen(e.target.value)}
            title="When (defaults to now)"
            className="px-2 py-1.5 border border-slate-300 rounded text-sm bg-white"
          />
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder={copy.placeholder}
            className="flex-1 min-w-[10rem] px-2 py-1.5 border border-slate-300 rounded text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <label className="text-[11px] text-slate-500 flex items-center gap-1.5">
            <CalendarClock className="w-3.5 h-3.5 text-slate-400" />
            Follow up / ETA
            <span className="text-slate-400">(optional)</span>
          </label>
          <input
            type="date"
            value={followUp}
            onChange={e => setFollowUp(e.target.value)}
            className="px-2 py-1.5 border border-slate-300 rounded text-sm bg-white"
          />
          <button
            type="button"
            onClick={add}
            disabled={saving}
            className="ml-auto px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Log it
          </button>
        </div>
        {error && <p className="text-xs text-red-700">{error}</p>}
      </div>
    </div>
  )
}
