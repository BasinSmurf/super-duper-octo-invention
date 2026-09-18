import { useEffect, useState } from 'react'
import { useSync } from '@/contexts/SyncContext'
import { cn } from '@/lib/cn'
import { db } from '@/lib/db'
import { nukeAndResync } from '@/lib/syncEngine'
import { localOnlyAttachmentCount } from '@/lib/attachments'
import type { MutationQueueEntry } from '@/lib/db-types'
import {
  RefreshCw,
  CloudUpload,
  Bug,
  Trash2,
  Bomb,
  Camera,
  AlertTriangle,
} from 'lucide-react'

/**
 * Compact sync status indicator for the AppShell sidebar.
 * Shows online/offline state, last sync time, pending mutations,
 * and a manual "Sync Now" button.
 */
export function SyncStatusBar() {
  const { syncState, isOnline, syncNow } = useSync()
  const { status, lastSyncedAt, pendingMutations, error, pushWarnings } = syncState
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugMutations, setDebugMutations] = useState<MutationQueueEntry[]>([])
  const [nuking, setNuking] = useState(false)
  const [localOnlyFiles, setLocalOnlyFiles] = useState(0)

  // Re-counted whenever the queue moves, so the number tracks reality rather
  // than whatever it was at mount.
  useEffect(() => {
    let cancelled = false
    localOnlyAttachmentCount()
      .then(n => { if (!cancelled) setLocalOnlyFiles(n) })
      .catch(() => { /* a count is not worth an error state */ })
    return () => { cancelled = true }
  }, [pendingMutations, status])

  const isSyncing = status === 'syncing'

  async function handleNuke() {
    if (!confirm('Clear ALL offline data and re-sync from server?\n\nThis wipes tickets, drafts, and cached data. Server data is not affected.')) return
    setNuking(true)
    try {
      await nukeAndResync()
    } finally {
      setNuking(false)
      setDebugOpen(false)
    }
  }

  // Format last sync time
  let lastSyncLabel = 'Never synced'
  if (lastSyncedAt) {
    const ago = timeSince(lastSyncedAt)
    lastSyncLabel = `Synced ${ago}`
  }

  async function showDebug() {
    const all = await db.mutationQueue.toArray()
    setDebugMutations(all)
    setDebugOpen(true)
  }

  async function purgeAll() {
    await db.mutationQueue.clear()
    setDebugMutations([])
    setDebugOpen(false)
    // Trigger a count update
    syncNow()
  }

  async function purgeSingle(queueId: number) {
    await db.mutationQueue.delete(queueId)
    const all = await db.mutationQueue.toArray()
    setDebugMutations(all)
    if (all.length === 0) setDebugOpen(false)
    syncNow()
  }

  return (
    <div className="space-y-2">
      {/* Connection + sync status row */}
      <div className="flex items-center gap-2">
        {/* Online/offline dot */}
        <div
          className={cn(
            'w-2 h-2 rounded-full shrink-0',
            isOnline ? 'bg-green-400' : 'bg-red-400',
          )}
        />
        <span className="text-xs text-slate-400 flex-1 truncate">
          {!isOnline ? 'Offline' : status === 'error' ? error || 'Sync error' : lastSyncLabel}
        </span>

        {/* Sync now button */}
        <button
          onClick={() => syncNow()}
          disabled={isSyncing || !isOnline}
          className={cn(
            'p-1 rounded transition-colors',
            isSyncing ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300',
            (!isOnline || isSyncing) && 'opacity-50 cursor-not-allowed',
          )}
          title="Sync now"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', isSyncing && 'animate-spin')} />
        </button>
      </div>

      {/* Nuke & Resync — clear offline cache and pull fresh */}
      <button
        onClick={handleNuke}
        disabled={nuking || isSyncing}
        className={cn(
          'flex items-center gap-1.5 text-xs w-full rounded px-1.5 py-1 transition-colors',
          nuking ? 'text-orange-400 bg-orange-900/20' : 'text-slate-500 hover:text-orange-400 hover:bg-slate-800',
          (nuking || isSyncing) && 'opacity-60 cursor-not-allowed',
        )}
        title="Clear all offline data and re-sync from server"
      >
        <Bomb className={cn('w-3 h-3', nuking && 'animate-pulse')} />
        <span>{nuking ? 'Clearing & re-syncing...' : 'Clear Cache & Resync'}</span>
      </button>

      {/* Pending mutations badge — tap to show debug */}
      {pendingMutations > 0 && (
        <button
          onClick={showDebug}
          className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 w-full"
        >
          <CloudUpload className="w-3 h-3" />
          <span>{pendingMutations} pending upload{pendingMutations !== 1 ? 's' : ''}</span>
          <Bug className="w-3 h-3 ml-auto opacity-50" />
        </button>
      )}

      {/* Files this device still holds the ONLY copy of.
          Called out separately from the generic pending count on purpose: a
          queued ticket edit that fails can be re-typed, and a photo of a
          condemned cylinder cannot. §3.2 asks for queue depth to be visible to
          the tech, and this is the part of the queue worth interrupting for. */}
      {localOnlyFiles > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-amber-300 w-full">
          <Camera className="w-3 h-3" />
          <span>
            {localOnlyFiles} file{localOnlyFiles !== 1 ? 's' : ''} on this device only
          </span>
        </div>
      )}

      {/* Mutations the server ACCEPTED but flagged. Not an error state — the
          record landed and there is nothing to retry — so it can't live on the
          status line above, which is about whether the queue is moving. Today
          this is a field-inspection work order whose return-shop pick never
          became a transfer, i.e. gear that no shop is expecting. The tech
          reading this is the one person who knows where it physically went. */}
      {pushWarnings.length > 0 && (
        <div className="space-y-1">
          {pushWarnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-1.5 text-xs text-amber-200 bg-amber-950/40 border border-amber-800/60 rounded p-2"
            >
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="break-words">{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Debug panel */}
      {debugOpen && (
        <div className="bg-slate-800 border border-slate-600 rounded-lg p-3 text-xs space-y-2 max-h-64 overflow-y-auto">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-300">
              Mutation Queue ({debugMutations.length})
            </span>
            <div className="flex gap-1">
              <button
                onClick={purgeAll}
                className="text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded bg-red-900/30 text-[10px]"
              >
                Purge All
              </button>
              <button
                onClick={() => setDebugOpen(false)}
                className="text-slate-400 hover:text-slate-300 px-1.5 py-0.5 text-[10px]"
              >
                ✕
              </button>
            </div>
          </div>
          {debugMutations.length === 0 && (
            <p className="text-slate-500 italic">Queue is empty</p>
          )}
          {debugMutations.map(m => (
            <div key={m.queueId} className="bg-slate-900 rounded p-2 space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-mono text-slate-300">
                  #{m.queueId} <span className="text-slate-500">{m.table}</span> <span className="text-slate-400">{m.action}</span>
                </span>
                <button
                  onClick={() => purgeSingle(m.queueId!)}
                  className="text-red-400 hover:text-red-300 p-0.5"
                  title="Delete this mutation"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              <div className="text-slate-500">
                status: <span className={cn(
                  'font-medium',
                  m.status === 'pending' && 'text-amber-400',
                  m.status === 'uploading' && 'text-blue-400',
                  m.status === 'error' && 'text-red-400',
                  m.status === 'done' && 'text-green-400',
                )}>{m.status}</span>
                {' · '}retries: {m.retryCount}
              </div>
              {m.errorMessage && (
                <div className="text-red-400 break-all">{m.errorMessage}</div>
              )}
              <div className="text-slate-600 font-mono break-all text-[10px]">
                entityId: {m.entityId}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeSince(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)

  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
