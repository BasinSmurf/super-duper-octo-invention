import { useEffect, useState } from 'react'
import { CalendarDays, ClipboardList, PackageCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { formatCalendarDate } from '@/lib/dates'
import { titleCase } from './portalUtils'

interface RentalItem {
  id: string
  status: string
  deployedDate: string
  returnedDate: string | null
  product: { name: string; category: string } | null
  serializedEquipment: { serialNumber: string } | null
}

interface RentalLog {
  logDate: string
  equipmentPresent: boolean
  equipmentStatus: string
  notes: string | null
}

interface RentalAgreement {
  id: string
  agreementNumber: string
  status: string
  pickupType: string
  startDate: string
  endDate: string | null
  poNumber: string | null
  afeNumber: string | null
  siteContactName: string | null
  siteContactPhone: string | null
  personCallingName: string | null
  field: { name: string } | null
  pad: { name: string } | null
  well: { wellName: string } | null
  items: RentalItem[]
  dailyLogs: RentalLog[]
}

function locationLine(r: RentalAgreement): string {
  const parts = [r.field?.name, r.pad?.name, r.well?.wellName].filter(Boolean)
  return parts.length ? parts.join(' > ') : 'Location not specified'
}

function statusClass(status: string) {
  if (status === 'active') return 'bg-green-50 text-green-700 border-green-200'
  if (status === 'scheduled') return 'bg-blue-50 text-blue-700 border-blue-200'
  if (status === 'completed') return 'bg-slate-100 text-slate-700 border-slate-200'
  return 'bg-amber-50 text-amber-800 border-amber-200'
}

export function PortalRentalsPage() {
  const [rentals, setRentals] = useState<RentalAgreement[]>([])
  const [status, setStatus] = useState('active')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    api.get<{ data: RentalAgreement[] }>(`/portal/rentals?status=${status}`)
      .then((res) => setRentals(res.data))
      .catch((err) => setError(err.message || 'Could not load rentals'))
      .finally(() => setLoading(false))
  }, [status])

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-black">Rentals</h1>
            <p className="text-sm text-slate-600 mt-1">Active agreements, deployed equipment, and recent daily-log visibility.</p>
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2 border border-slate-300 bg-white text-sm"
          >
            <option value="active">Active / scheduled</option>
            <option value="completed">Completed</option>
            <option value="all">All rentals</option>
          </select>
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}
      {loading ? (
        <p className="text-slate-500 text-center py-12">Loading…</p>
      ) : rentals.length === 0 ? (
        <p className="text-slate-500 text-center py-12">No rentals are currently visible.</p>
      ) : (
        <div className="space-y-3">
          {rentals.map((rental) => (
            <article key={rental.id} className="bg-white border border-slate-200">
              <div className="p-4 border-b border-slate-200 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-extrabold text-black">{rental.agreementNumber}</h2>
                    <span className={`text-xs px-2 py-0.5 border font-semibold ${statusClass(rental.status)}`}>{titleCase(rental.status)}</span>
                    <span className="text-xs px-2 py-0.5 bg-slate-100 text-slate-700 font-semibold">{titleCase(rental.pickupType)}</span>
                  </div>
                  <p className="text-sm text-slate-700 mt-1">{locationLine(rental)}</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Start {formatCalendarDate(rental.startDate)}
                    {rental.endDate ? ` / End ${formatCalendarDate(rental.endDate)}` : ''}
                    {rental.poNumber ? ` / PO ${rental.poNumber}` : ''}
                    {rental.afeNumber ? ` / AFE ${rental.afeNumber}` : ''}
                  </p>
                </div>
                <div className="text-sm text-slate-700">
                  Contact: {rental.siteContactName || rental.personCallingName || rental.siteContactPhone || 'not shown'}
                </div>
              </div>

              <div className="p-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <PackageCheck className="w-4 h-4 text-blue-700" />
                    <h3 className="font-bold text-black">Deployed Equipment</h3>
                  </div>
                  {rental.items.length === 0 ? (
                    <p className="text-sm text-slate-500">No deployed equipment shown.</p>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {rental.items.map((item) => (
                        <div key={item.id} className="border border-slate-200 bg-slate-50 p-3">
                          <p className="font-bold text-black">{item.product?.name ?? 'Equipment'}</p>
                          <p className="text-sm text-slate-700 mt-1">Serial {item.serializedEquipment?.serialNumber ?? 'not shown'}</p>
                          <p className="text-xs text-slate-500 mt-1">
                            {titleCase(item.status)} / deployed {formatCalendarDate(item.deployedDate)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <ClipboardList className="w-4 h-4 text-blue-700" />
                    <h3 className="font-bold text-black">Recent Daily Logs</h3>
                  </div>
                  {rental.dailyLogs.length === 0 ? (
                    <p className="text-sm text-slate-500">No daily logs shown.</p>
                  ) : (
                    <div className="space-y-2">
                      {rental.dailyLogs.map((log) => (
                        <div key={log.logDate} className="border border-slate-200 p-3">
                          <div className="flex items-center gap-2 text-sm font-bold text-black">
                            <CalendarDays className="w-4 h-4 text-slate-500" />
                            {formatCalendarDate(log.logDate)}
                          </div>
                          <p className="text-sm text-slate-700 mt-1">
                            {titleCase(log.equipmentStatus)} / equipment {log.equipmentPresent ? 'present' : 'not present'}
                          </p>
                          {log.notes && <p className="text-xs text-slate-500 mt-1">{log.notes}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
