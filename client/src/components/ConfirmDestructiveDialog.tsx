import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

interface Props {
  open: boolean
  /** 'void' = recoverable soft cancel (reason optional). 'delete' = permanent (reason required). */
  mode: 'void' | 'delete'
  title: string
  /** Optional context line under the title. */
  message?: string
  confirmLabel?: string
  /** Show an "override safety locks" checkbox + warning (e.g. invoice already in QuickBooks). */
  showOverride?: boolean
  overrideLabel?: string
  busy?: boolean
  onConfirm: (opts: { reason: string; override: boolean }) => void
  onClose: () => void
}

/**
 * One dialog for every cancel/void/delete across the app. Replaces the scattered
 * window.confirm/prompt calls. Delete mode forces a non-empty reason (any text);
 * void mode treats the reason as optional. The override checkbox lets a permitted
 * role bypass lifecycle locks, with a clear warning.
 */
export function ConfirmDestructiveDialog({
  open, mode, title, message, confirmLabel, showOverride, overrideLabel, busy, onConfirm, onClose,
}: Props) {
  const [reason, setReason] = useState('')
  const [override, setOverride] = useState(false)

  if (!open) return null

  const isDelete = mode === 'delete'
  const reasonRequired = isDelete
  const canConfirm = !busy && (!reasonRequired || reason.trim().length > 0)

  function handleConfirm() {
    if (!canConfirm) return
    onConfirm({ reason: reason.trim(), override })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-start justify-between px-5 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className={isDelete ? 'w-5 h-5 text-red-600' : 'w-5 h-5 text-amber-600'} />
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pb-4 space-y-3">
          {message && <p className="text-sm text-slate-600">{message}</p>}
          {isDelete && (
            <p className="text-sm text-red-700 font-medium">This is permanent and cannot be undone.</p>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Reason {reasonRequired ? <span className="text-red-600">(required)</span> : <span className="text-slate-400">(optional)</span>}
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder={isDelete ? 'Why is this being deleted?' : 'Optional note…'}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {showOverride && (
            <label className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-200 bg-amber-50 cursor-pointer">
              <input
                type="checkbox"
                checked={override}
                onChange={e => setOverride(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-amber-600"
              />
              <span className="text-xs text-amber-800">
                {overrideLabel || 'Override safety locks (e.g. already in QuickBooks, or closed). Downstream cleanup may be required manually.'}
              </span>
            </label>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className={
              isDelete
                ? 'px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50'
                : 'px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50'
            }
          >
            {busy ? 'Working…' : (confirmLabel || (isDelete ? 'Delete' : 'Void'))}
          </button>
        </div>
      </div>
    </div>
  )
}
