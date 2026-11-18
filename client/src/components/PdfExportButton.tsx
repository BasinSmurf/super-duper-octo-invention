import { useState } from 'react'
import { FileDown, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'

interface Props {
  url: string
  fileName: string
  label?: string
  iconOnly?: boolean
  onError?: (message: string) => void
}

export function PdfExportButton({ url, fileName, label = 'Export PDF', iconOnly, onError = window.alert }: Props) {
  const [busy, setBusy] = useState(false)
  const [attachmentCount, setAttachmentCount] = useState<number | null>(null)

  async function download(includeAttachments: boolean) {
    setAttachmentCount(null)
    setBusy(true)
    try {
      const token = localStorage.getItem('sundog_token')
      const res = await fetch(`${url}${includeAttachments ? '?includeAttachments=true' : ''}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error((typeof data?.error === 'string' ? data.error : data?.error?.message) || data?.message || 'PDF export failed')
      }
      const blobUrl = URL.createObjectURL(await res.blob())
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = fileName
      link.click()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'PDF export failed')
    } finally { setBusy(false) }
  }

  async function requestExport() {
    setBusy(true)
    try {
      const { count } = await api.get<{ count: number }>(`${url.replace(/^\/api(?=\/)/, '').replace(/\/(?:occ-health-)?pdf$/, '')}/pdf-attachments`)
      if (count > 0) setAttachmentCount(count)
      else await download(false)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not check attachments')
    } finally { setBusy(false) }
  }

  return <>
    <button type="button" onClick={() => void requestExport()} disabled={busy || attachmentCount !== null}
      title={label} aria-label={label}
      className={iconOnly ? 'p-2 text-slate-500 hover:text-blue-600 disabled:opacity-40' : 'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40'}>
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
      {!iconOnly && label}
    </button>
    {attachmentCount !== null && <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onKeyDown={event => { if (event.key === 'Escape') setAttachmentCount(null) }}>
      <div role="dialog" aria-modal="true" aria-label="Include attachments?" className="bg-white rounded-xl shadow-xl p-5 max-w-md w-full space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">Include attachments?</h2>
        <p className="text-sm text-slate-600">This record has {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}. Include pictures, testing documents, and other files in one PDF?</p>
        <p className="text-xs text-slate-500">Pictures and PDFs become additional pages. Other file types include a summary page and the embedded original.</p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button type="button" onClick={() => setAttachmentCount(null)} className="px-3 py-2 text-sm text-slate-600">Cancel</button>
          <button type="button" onClick={() => void download(false)} className="px-3 py-2 text-sm border rounded-lg text-slate-700">Without attachments</button>
          <button type="button" autoFocus onClick={() => void download(true)} className="px-3 py-2 text-sm rounded-lg bg-blue-600 text-white">Include attachments</button>
        </div>
      </div>
    </div>}
  </>
}
