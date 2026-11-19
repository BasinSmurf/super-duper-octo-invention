import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'

export interface LineageTicket {
  ticketId: string
  ticketNumber: string
}

export function LineageDownloadButton({ tickets }: { tickets: LineageTicket[] }) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [failures, setFailures] = useState<LineageTicket[]>([])
  const [message, setMessage] = useState('')
  const [excluded, setExcluded] = useState<string[]>([])
  const [combined, setCombined] = useState(false)
  const uniqueTickets = [...new Map(tickets.map(ticket => [ticket.ticketId, ticket])).values()]
  const selected = uniqueTickets.filter(ticket => !excluded.includes(ticket.ticketId))

  function savePdf(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  async function download(batch = selected) {
    setBusy(true)
    setProgress(0)
    setFailures([])
    setMessage('')
    if (combined) {
      try {
        const token = localStorage.getItem('sundog_token')
        const response = await fetch('/api/tickets/pdf-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ ticketIds: batch.map(ticket => ticket.ticketId) }),
        })
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(typeof body?.error === 'string' ? body.error : 'Combined PDF export failed. Please retry.')
        }
        savePdf(await response.blob(), 'billing-lineage-tickets.pdf')
        setMessage(`Combined PDF download started (${batch.length} tickets).`)
      } catch (error) {
        setFailures(batch)
        setMessage(error instanceof Error ? error.message : 'Combined PDF export failed. Please retry.')
      } finally { setBusy(false) }
      return
    }
    const failed: LineageTicket[] = []
    for (const [index, ticket] of batch.entries()) {
      try {
        const token = localStorage.getItem('sundog_token')
        const response = await fetch(`/api/tickets/${encodeURIComponent(ticket.ticketId)}/pdf`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!response.ok) throw new Error('Ticket PDF export failed')
        savePdf(await response.blob(), `${ticket.ticketNumber.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`)
      } catch {
        failed.push(ticket)
      }
      setProgress(index + 1)
    }
    setFailures(failed)
    setMessage(`${batch.length - failed.length} PDF download${batch.length - failed.length === 1 ? '' : 's'} started.${failed.length ? ` Could not export: ${failed.map(ticket => ticket.ticketNumber).join(', ')}.` : ''}`)
    setBusy(false)
  }

  return <div className="space-y-1">
    <fieldset disabled={busy} className="space-y-2 mb-3">
      <legend className="text-sm font-medium text-slate-700">Tickets to download ({selected.length} of {uniqueTickets.length})</legend>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={uniqueTickets.length > 0 && selected.length === uniqueTickets.length}
          onChange={event => { setExcluded(event.target.checked ? [] : uniqueTickets.map(ticket => ticket.ticketId)); setFailures([]); setMessage('') }} />
        Select all tickets
      </label>
      <div className="max-h-48 overflow-y-auto space-y-1">
        {uniqueTickets.map(ticket => <label key={ticket.ticketId} className="flex items-center gap-2 text-sm font-mono text-slate-600">
          <input type="checkbox" aria-label={`Select ${ticket.ticketNumber}`} checked={!excluded.includes(ticket.ticketId)}
            onChange={event => { setExcluded(event.target.checked ? excluded.filter(id => id !== ticket.ticketId) : [...excluded, ticket.ticketId]); setFailures([]); setMessage('') }} />
          {ticket.ticketNumber}
        </label>)}
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">Download format
        <select aria-label="Download format" value={combined ? 'combined' : 'separate'}
          onChange={event => { setCombined(event.target.value === 'combined'); setFailures([]); setMessage('') }}
          className="border border-slate-300 rounded-lg px-2 py-1">
          <option value="separate">Separate PDFs</option>
          <option value="combined">All in one PDF</option>
        </select>
      </label>
    </fieldset>
    <button type="button" onClick={() => void download()} disabled={busy || selected.length === 0}
      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40">
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
      {busy ? (combined ? 'Preparing combined PDF…' : `Downloading… ${progress}`) : `Download tickets (${selected.length})`}
    </button>
    <p className="text-xs text-slate-500">{combined ? 'All selected tickets in one PDF, in the order shown.' : 'One PDF per selected ticket, named by serial. Allow multiple downloads if your browser asks.'}</p>
    {message && <p role="status" className={`text-xs ${failures.length ? 'text-red-600' : 'text-slate-600'}`}>{message}</p>}
    {failures.length > 0 && <button type="button" disabled={busy} onClick={() => void download(failures)}
      className="text-xs text-blue-700 hover:underline disabled:opacity-40">Retry failed downloads</button>}
  </div>
}
