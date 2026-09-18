/**
 * UnitAttachments — per-unit evidence capture (WI-04).
 *
 * "Issue with unit 2" goes INTO unit 2. This panel hangs off one shop-work-order
 * item, so a photo taken here can only ever land on that unit — the old failure
 * mode was a pile of photos on the ticket with nothing saying which of five
 * identical cylinders each one showed.
 *
 * OFFLINE IS THE NORMAL CASE. Every capture goes through lib/attachments
 * `captureAttachment`, which writes the bytes and their checksum to Dexie before
 * anything is queued. The tech sees the photo immediately, walks away, and the
 * sync engine pushes it when there is signal. Nothing here awaits a network.
 *
 * The list MERGES two sources on purpose: what the server has (including
 * captures by other techs on other devices) and what this device is still
 * holding. Showing only the server list would make a tech's own just-taken photo
 * vanish until it synced, which reads as "it didn't save" and gets it re-taken.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, FileText, Loader2, Trash2, CloudUpload, Check, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { compressImage } from '@/lib/compressImage'
import { runFullSync } from '@/lib/syncEngine'
import {
  captureAttachment,
  attachmentsFor,
  deleteAttachment,
  type AttachmentKind,
} from '@/lib/attachments'
import { BENCH_CAPTURE, type CaptureOption } from '@/lib/attachmentCapture'

interface ServerAttachment {
  id: string
  kind: string
  fileName: string
  mimeType: string | null
  fileSizeBytes: number | null
  storageState: string
  capturedAt: string
  serialNumber: string | null
  uploadedBy?: { id: string; name: string } | null
}

interface Row {
  id: string
  kind: string
  fileName: string
  capturedAt: string
  /** local = this device still holds the only copy. */
  state: 'local' | 'buffered' | 'remote' | 'failed'
  by?: string | null
  local: boolean
  fileSizeBytes: number | null
}

const KIND_LABEL: Record<string, string> = {
  photo: 'Photo',
  ue_report: 'UE Report',
  pozi_report: 'Posi-Check',
  vendor_invoice: 'Vendor Invoice',
  packing_slip: 'Packing Slip',
  test_paperwork: 'Test Paperwork',
  signature: 'Signature',
  document: 'Document',
  other: 'Other',
}

/** dataUrl → Blob. The checksum must be taken over the bytes we actually send,
 *  so compression has to happen BEFORE capture, not after. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(',')
  const mime = /:(.*?);/.exec(header)?.[1] || 'application/octet-stream'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

interface Props {
  shopItemId: string
  serialNumber: string
  /** Notifies the parent so it can enable/disable the condemn action. */
  onCountChange?: (count: number) => void
  disabled?: boolean
  /** Capture buttons to offer. Defaults to the bench set. */
  capture?: CaptureOption[]
  /** Separate ticket paperwork from serial evidence in the receive dialog. */
  scope?: 'ticket' | 'serial'
  onSavedKindsChange?: (kinds: string[]) => void
}

export function UnitAttachments({ shopItemId, serialNumber, onCountChange, disabled, capture = BENCH_CAPTURE, scope, onSavedKindsChange }: Props) {
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const docInput = useRef<HTMLInputElement>(null)
  const pendingKind = useRef<AttachmentKind>('photo')

  const refresh = useCallback(async () => {
    // Local first: it is instant, always available, and is the only source that
    // knows about a capture taken thirty seconds ago on a dead connection.
    let local: Row[] = []
    try {
      const localRows = await attachmentsFor({ shopItemId })
      local = localRows.map(a => ({
        id: a.id,
        kind: a.kind,
        fileName: a.fileName,
        capturedAt: a.capturedAt,
        state: (a.storageState ?? 'local') as Row['state'],
        local: true,
        fileSizeBytes: a.fileSizeBytes ?? null,
      }))
    } catch { /* Dexie unavailable — the server list still renders */ }

    let server: Row[] = []
    try {
      const res = await api.get<{ attachments: ServerAttachment[] }>(
        `/attachments?shopItemId=${encodeURIComponent(shopItemId)}`,
      )
      server = res.attachments.map(a => ({
        id: a.id,
        kind: a.kind,
        fileName: a.fileName,
        capturedAt: a.capturedAt,
        state: a.storageState as Row['state'],
        by: a.uploadedBy?.name,
        local: false,
        fileSizeBytes: a.fileSizeBytes,
      }))
    } catch { /* offline — the local list stands on its own */ }

    // Server wins on id collision: once it has the row, its state is the truth.
    const merged = new Map<string, Row>()
    for (const r of local) merged.set(r.id, r)
    for (const r of server) merged.set(r.id, r)
    const list = [...merged.values()].filter(a => {
      const ticketDocument = a.kind === 'vendor_invoice' || a.kind === 'packing_slip'
      return !scope || (scope === 'ticket' ? ticketDocument : !ticketDocument)
    }).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    setRows(list)
    onCountChange?.(list.length)
    onSavedKindsChange?.(server.filter(a => (a.fileSizeBytes ?? 0) > 0 && list.some(r => r.id === a.id)).map(a => a.kind))
  }, [shopItemId, onCountChange, scope, onSavedKindsChange])

  useEffect(() => { void refresh() }, [refresh])

  // The receive gate opens only after the server acknowledges the queued file.
  useEffect(() => {
    if (!onSavedKindsChange) return
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => clearInterval(timer)
  }, [refresh, onSavedKindsChange])

  async function handleFiles(files: FileList | null, kind: AttachmentKind) {
    if (!files || files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      for (const file of Array.from(files)) {
        if (file.size === 0) throw new Error('The selected file is empty. Choose a document with content.')
        // Photos are compressed first: an iPad still shoots 3–5 MB a frame, and
        // every one of those bytes is paid for twice — once over a shop's
        // uplink, once a month in object storage.
        let payload: Blob = file
        let fileName = file.name || `${kind}.bin`
        if (kind === 'photo' && file.type.startsWith('image/')) {
          payload = dataUrlToBlob(await compressImage(file, 1920, 0.7))
          fileName = file.name?.replace(/\.[^.]+$/, '.jpg') || 'photo.jpg'
        }
        await captureAttachment({
          id: crypto.randomUUID(),
          parent: { shopItemId },
          kind,
          file: payload,
          fileName,
          serialNumber,
        })
      }
      await refresh()
      if (onSavedKindsChange) void runFullSync().then(refresh)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the file')
    } finally {
      setBusy(false)
      if (photoInput.current) photoInput.current.value = ''
      if (docInput.current) docInput.current.value = ''
    }
  }

  async function handleDelete(row: Row) {
    if (!confirm(`Remove ${row.fileName}?`)) return
    setBusy(true)
    try {
      if (row.local) await deleteAttachment(row.id)
      else await api.delete(`/attachments/${row.id}`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the file')
    } finally {
      setBusy(false)
    }
  }

  function pickDoc(kind: AttachmentKind) {
    pendingKind.current = kind
    docInput.current?.click()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-medium text-slate-500">
          Attachments {rows.length > 0 && <span className="text-slate-400">({rows.length})</span>}
        </p>
      </div>

      {!disabled && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {/* capture="environment" opens the camera straight to the rear lens on
              an iPad instead of the photo library — WI-04 is iPad-first. */}
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={e => handleFiles(e.target.files, 'photo')}
          />
          <input
            ref={docInput}
            type="file"
            accept="application/pdf,image/*"
            multiple
            className="hidden"
            onChange={e => handleFiles(e.target.files, pendingKind.current)}
          />
          {capture.map(opt => (
            <ActionButton
              key={opt.kind}
              icon={opt.camera ? Camera : FileText}
              label={opt.label}
              onClick={() => {
                if (opt.camera) { photoInput.current?.click(); return }
                pickDoc(opt.kind)
              }}
              busy={busy}
            />
          ))}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-600 mb-2 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-xs text-slate-400 italic">
          {scope === 'ticket' ? 'No return documents on this ticket yet.' : 'No attachments on this unit yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
          {rows.map(row => (
            <li key={row.id} className="flex items-center gap-2 px-2.5 py-2 bg-white">
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 shrink-0">
                {KIND_LABEL[row.kind] ?? row.kind}
                {(row.kind === 'vendor_invoice' || row.kind === 'packing_slip') && ' · Ticket'}
              </span>
              <a
                href={row.local ? undefined : `/api/attachments/${row.id}/content`}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  'text-xs truncate flex-1',
                  row.local ? 'text-slate-700' : 'text-blue-700 hover:underline',
                )}
              >
                {row.fileName}
              </a>
              <SyncBadge state={row.state} />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleDelete(row)}
                  disabled={busy}
                  className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ActionButton({ icon: Icon, label, onClick, busy }: {
  icon: React.ElementType; label: string; onClick: () => void; busy: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-slate-300 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-40"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      {label}
    </button>
  )
}

/**
 * Where this file's bytes currently live. Worth showing rather than hiding: a
 * tech who knows the photo is still only on their iPad behaves differently
 * about wiping the browser than one who thinks it is filed.
 */
function SyncBadge({ state }: { state: Row['state'] }) {
  if (state === 'remote') {
    return (
      <span title="Stored and verified" className="text-emerald-600 shrink-0">
        <Check className="w-3.5 h-3.5" />
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span title="Upload keeps failing — still retrying, copy is safe" className="text-amber-600 shrink-0">
        <AlertTriangle className="w-3.5 h-3.5" />
      </span>
    )
  }
  return (
    <span
      title={state === 'local' ? 'On this device only — will upload when online' : 'On the server, uploading to storage'}
      className={cn('shrink-0', state === 'local' ? 'text-amber-600' : 'text-slate-400')}
    >
      <CloudUpload className="w-3.5 h-3.5" />
    </span>
  )
}
