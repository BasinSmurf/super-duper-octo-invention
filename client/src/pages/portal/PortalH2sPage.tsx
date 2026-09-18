import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { api } from '@/lib/api'

interface Reading {
  ticketId: string
  ticketNumber: string
  serviceDate: string
  value: number
  context: string
  readingType: string
}
interface Location {
  locationKey: string
  locationName: string
  locationType: string
  readings: Reading[]
}
interface Analytics { locations: Location[] }
const COLORS = ['#2563eb', '#0d9488', '#9333ea', '#ea580c', '#db2777', '#475569']
const inputClass = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500'
const dateLabel = (value: string | number) => new Date(typeof value === 'string' ? `${value}T00:00:00Z` : value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export function PortalH2sPage() {
  const [data, setData] = useState<Analytics | null>(null)
  const [keys, setKeys] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [compare, setCompare] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const invalidRange = !!(dateFrom && dateTo && dateFrom > dateTo)

  useEffect(() => {
    if (invalidRange) return
    let ignore = false
    setLoading(true)
    setError('')
    const query = new URLSearchParams()
    if (dateFrom) query.set('dateFrom', dateFrom)
    if (dateTo) query.set('dateTo', dateTo)
    api.get<Analytics>(`/portal/h2s?${query}`).then(result => {
      if (ignore) return
      setData(result)
      setKeys(previous => {
        const retained = previous.filter(key => result.locations.some(loc => loc.locationKey === key))
        return retained.length ? retained : result.locations.slice(0, 1).map(loc => loc.locationKey)
      })
    }).catch(err => { if (!ignore) setError(err.message || 'Could not load test history.') })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [dateFrom, dateTo, invalidRange])

  const selected = useMemo(() => keys.flatMap(key => data?.locations.find(loc => loc.locationKey === key) ?? []), [keys, data])
  const rows = useMemo(() => selected.flatMap(loc => loc.readings.map(reading => ({ ...reading, locationName: loc.locationName })))
    .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate)), [selected])
  const tickets = useMemo(() => {
    const grouped = new Map<string, { ticketId: string; ticketNumber: string; date: string; location: string; count: number; max: number }>()
    for (const row of rows) {
      const previous = grouped.get(row.ticketId)
      if (previous) { previous.count++; previous.max = Math.max(previous.max, row.value) }
      else grouped.set(row.ticketId, { ticketId: row.ticketId, ticketNumber: row.ticketNumber, date: row.serviceDate, location: row.locationName, count: 1, max: row.value })
    }
    return [...grouped.values()]
  }, [rows])
  const visible = (data?.locations ?? []).filter(loc => loc.locationName.toLowerCase().includes(search.trim().toLowerCase()))

  function select(key: string) {
    setKeys(previous => !compare ? [key] : previous.includes(key) ? previous.filter(item => item !== key) : previous.length < 6 ? [...previous, key] : previous)
  }
  function download() {
    const cell = (value: unknown) => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`
    const csv = [['Location', 'Service date', 'Ticket', 'H2S (ppm)', 'Sample point', 'Reading type'], ...rows.map(row => [row.locationName, row.serviceDate, row.ticketNumber, row.value, row.context, row.readingType])]
      .map(row => row.map(cell).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'h2s-test-history.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Testing insights</p><h1 className="mt-1 text-2xl font-bold text-slate-900">H₂S test history</h1><p className="mt-1 text-sm text-slate-600">Explore a well’s readings, compare locations, and open the original service tickets.</p></div>
      <button onClick={download} disabled={!rows.length || loading || !!error || invalidRange} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-40">Export selected readings</button>
    </div>
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <label className="text-sm text-slate-600">From <input aria-label="From date" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={inputClass} /></label>
      <label className="text-sm text-slate-600">To <input aria-label="To date" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={inputClass} /></label>
      {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(''); setDateTo('') }} className="text-sm font-semibold text-blue-700">All dates</button>}
      <span className="text-xs text-slate-500">Dates reflect the ticket’s service date.</span>
    </div>
    {invalidRange ? <p role="alert" className="text-red-700">The end date must be on or after the start date.</p> : loading ? <p role="status" className="py-16 text-center text-slate-500">Loading test history…</p> : error ? <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-700">{error}</p> : !data?.locations.length ? <p className="py-16 text-center text-slate-500">No H₂S readings found{dateFrom || dateTo ? ' in this date range' : ''}.</p> : <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="self-start rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="font-semibold text-slate-900">Wells & locations</h2>
        <input aria-label="Search wells and locations" placeholder="Search wells and locations…" value={search} onChange={e => setSearch(e.target.value)} className={`${inputClass} mt-3 w-full`} />
        <label className="my-3 flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={compare} onChange={e => { setCompare(e.target.checked); if (!e.target.checked) setKeys(previous => previous.slice(0, 1)) }} />Compare locations</label>
        {compare && <p className="mb-3 text-xs text-slate-500">Choose up to 6 locations ({keys.length}/6 selected).</p>}
        <div className="max-h-[540px] space-y-1 overflow-y-auto">
          {visible.map(loc => <button key={loc.locationKey} aria-pressed={keys.includes(loc.locationKey)} disabled={compare && keys.length >= 6 && !keys.includes(loc.locationKey)} onClick={() => select(loc.locationKey)} className={`w-full rounded-lg border p-3 text-left disabled:opacity-40 ${keys.includes(loc.locationKey) ? 'border-blue-200 bg-blue-50' : 'border-transparent hover:bg-slate-50'}`}>
            <span className="block break-words text-sm font-semibold text-slate-900">{keys.includes(loc.locationKey) ? '✓ ' : ''}{loc.locationName}</span><span className="text-xs capitalize text-slate-500">{loc.locationType} · {loc.readings.length} readings</span>
          </button>)}
          {!visible.length && <p className="py-4 text-sm text-slate-500">No matching locations. Try another name.</p>}
        </div>
      </aside>
      <div className="min-w-0 space-y-5">
        <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
          <h2 className="text-lg font-semibold text-slate-900">{selected.length === 1 ? selected[0].locationName : 'Location comparison'}</h2>
          {!selected.length ? <p className="py-16 text-center text-slate-500">Select a location to see its test history.</p> : <>
            <p className="mt-1 text-sm text-slate-500">{rows.length} readings · {tickets.length} tickets · {selected.length} locations</p>
            <div className="mt-4 flex flex-wrap gap-2">{selected.map((loc, i) => <button key={loc.locationKey} onClick={() => setKeys(previous => previous.filter(key => key !== loc.locationKey))} aria-label={`Remove ${loc.locationName}`} className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold" style={{ color: COLORS[i] }}>{loc.locationName} ×</button>)}</div>
            <div className="mt-5 h-[420px] w-full" role="img" aria-label="H2S history: horizontal axis is service date; vertical axis is ppm. Related tickets are listed below.">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 12, right: 20, bottom: 25, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 5" stroke="#e2e8f0" />
                  <XAxis type="number" dataKey="timestamp" name="Service date" domain={['dataMin - 86400000', 'dataMax + 86400000']} tickFormatter={dateLabel} tick={{ fontSize: 11 }} minTickGap={35} label={{ value: 'Service date', position: 'bottom', offset: 8 }} />
                  <YAxis type="number" dataKey="value" name="H₂S" domain={[0, 'auto']} tick={{ fontSize: 11 }} width={60} label={{ value: 'H₂S (ppm)', angle: -90, position: 'insideLeft' }} />
                  <Tooltip content={({ active, payload }) => {
                    const point = payload?.[0]?.payload
                    return active && point ? <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg"><p className="font-semibold">{point.locationName}</p><p>{dateLabel(point.serviceDate)} · {point.value} ppm</p><p>{point.ticketNumber} · {point.context}</p></div> : null
                  }} />
                  {selected.map((loc, i) => <Scatter key={loc.locationKey} name={loc.locationName} data={loc.readings.map(reading => ({ ...reading, locationName: loc.locationName, timestamp: Date.parse(`${reading.serviceDate}T00:00:00Z`) }))} fill={COLORS[i]} line={{ stroke: COLORS[i], strokeWidth: 2 }} lineType="joint" isAnimationActive={false} />)}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-500">Each point is a recorded reading. Lines connect readings in service-date order, including different sample points; they do not represent continuous monitoring. Hover for the sample point and ticket.</p>
          </>}
        </section>
        {!!tickets.length && <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 p-4"><h2 className="font-semibold text-slate-900">Related tickets</h2><p className="text-xs text-slate-500">For the selected locations and date range · newest first</p></div>
          <div className="max-h-[480px] overflow-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="p-3">Ticket / location</th><th className="p-3">Service date</th><th className="p-3">Readings</th><th className="p-3">Peak ppm</th></tr></thead><tbody className="divide-y divide-slate-100">{tickets.map(ticket => <tr key={ticket.ticketId} className="hover:bg-slate-50"><td className="p-3"><Link to={`/portal/tickets/${ticket.ticketId}`} className="font-semibold text-blue-700 hover:underline">{ticket.ticketNumber || 'View ticket'} →</Link><p className="text-xs text-slate-500">{ticket.location}</p></td><td className="whitespace-nowrap p-3">{dateLabel(ticket.date)}</td><td className="p-3">{ticket.count}</td><td className="p-3 font-semibold">{ticket.max}</td></tr>)}</tbody></table></div>
        </section>}
      </div>
    </div>}
  </div>
}
