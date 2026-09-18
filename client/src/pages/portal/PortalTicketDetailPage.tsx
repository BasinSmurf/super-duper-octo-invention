import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { formatCalendarDate } from '@/lib/dates'
import { customerStatus, statusBadgeClass, titleCase, formatDate } from './portalUtils'

interface PortalLineItem {
  id: string
  lineNumber: number
  lineType: string
  description: string | null
  quantity: string
  unitOfMeasure: string | null
}

interface PortalTicketDetail {
  id: string
  ticketNumber: string
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  serviceDateTo: string | null
  locationDisplay: string | null
  workDescription: string | null
  poNumber: string | null
  afeNumber: string | null
  customerRepName: string | null
  completedAt: string | null
  company: { id: string; name: string } | null
  field: { name: string } | null
  pad: { name: string } | null
  well: { wellName: string } | null
  assignedTech: { name: string } | null
  lineItems: PortalLineItem[]
}

function locationLine(t: PortalTicketDetail): string {
  if (t.locationDisplay) return t.locationDisplay
  const parts = [t.field?.name, t.pad?.name, t.well?.wellName].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Location not specified'
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-sm text-slate-800">{value}</dd>
    </div>
  )
}

export function PortalTicketDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [ticket, setTicket] = useState<PortalTicketDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    setLoading(true)
    setError('')
    api
      .get<PortalTicketDetail>(`/portal/tickets/${id}`)
      .then(setTicket)
      .catch((err) => setError(err.message || 'Could not load ticket'))
      .finally(() => setLoading(false))
  }, [id])

  return (
    <div>
      <Link to="/portal/service" className="text-sm text-blue-700 hover:underline">
        ← Back to Service Tickets
      </Link>

      {loading ? (
        <p className="text-slate-400 text-center py-12">Loading…</p>
      ) : error ? (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      ) : !ticket ? null : (
        <div className="mt-4 space-y-4">
          {/* Header */}
          <div className="bg-white border border-slate-200 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-extrabold text-black">{ticket.ticketNumber}</h1>
                <p className="text-sm text-slate-500">
                  {titleCase(ticket.serviceSubtype || ticket.ticketType)}
                </p>
              </div>
              <span
                className={`text-xs px-2.5 py-1 border font-semibold ${statusBadgeClass(ticket.status)}`}
              >
                {customerStatus(ticket.status)}
              </span>
            </div>

            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-5">
              <Detail label="Service Date" value={formatCalendarDate(ticket.serviceDate)} />
              {ticket.serviceDateTo && (
                <Detail label="Through" value={formatCalendarDate(ticket.serviceDateTo)} />
              )}
              <Detail label="Location" value={locationLine(ticket)} />
              <Detail label="Technician" value={ticket.assignedTech?.name} />
              <Detail label="PO Number" value={ticket.poNumber} />
              <Detail label="AFE Number" value={ticket.afeNumber} />
              <Detail label="Signed By" value={ticket.customerRepName} />
              {ticket.completedAt && (
                <Detail label="Completed" value={formatDate(ticket.completedAt)} />
              )}
            </dl>
          </div>

          {/* Work performed */}
          {ticket.workDescription && (
            <div className="bg-white border border-slate-200 p-5">
              <h2 className="text-sm font-extrabold text-black mb-2">Work Performed</h2>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">
                {ticket.workDescription}
              </p>
            </div>
          )}

          {/* Service lines, intentionally no dollar amounts in the customer portal. */}
          {ticket.lineItems.length > 0 && (
            <div className="bg-white border border-slate-200 overflow-hidden">
              <h2 className="text-sm font-extrabold text-black px-5 pt-5 pb-2">
                Service Lines
              </h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                    <th className="px-5 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 font-medium text-right">Qty</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ticket.lineItems.map((li) => (
                    <tr key={li.id}>
                      <td className="px-5 py-2 text-slate-800">
                        {li.description || titleCase(li.lineType)}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600">
                        {Number(li.quantity)}
                        {li.unitOfMeasure ? ` ${li.unitOfMeasure}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
