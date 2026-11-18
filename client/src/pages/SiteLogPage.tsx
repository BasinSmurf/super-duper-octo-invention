import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { formatCalendarDateNumeric } from '@/lib/dates'
import { ArrowLeft, Loader2, Phone, Mail, ClipboardList, ChevronRight, Truck } from 'lucide-react'
import { emptySiteLog, loadSiteLog, type DailyLog, type SiteLogAgreement, type SiteLogSnapshot } from '@/lib/siteLogLoader'

function humanize(value?: string | null): string {
  return value ? value.replace(/_/g, ' ') : ''
}

function logFacts(log: DailyLog): string[] {
  const facts: string[] = []
  if (log.equipmentStatus) facts.push(`Equipment ${humanize(log.equipmentStatus)}`)
  if (log.cascadeStatus) facts.push(`Cascade ${humanize(log.cascadeStatus)}`)
  if (log.bottlesFullCount != null && log.bottlesTotalCount != null) {
    facts.push(`Bottles ${log.bottlesFullCount}/${log.bottlesTotalCount}`)
  }
  if (log.monitorsOperationalCount != null && log.monitorsTotalCount != null) {
    facts.push(`Monitors ${log.monitorsOperationalCount}/${log.monitorsTotalCount}`)
  } else if (log.monitorsBumpTested != null) {
    facts.push(log.monitorsBumpTested ? 'Monitors bump tested' : 'Monitors not bump tested')
  }
  return facts
}

export function SiteLogPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [snapshot, setSnapshot] = useState<SiteLogSnapshot | null>(null)
  const [contactExpanded, setContactExpanded] = useState(false)
  const current = snapshot && snapshot.agreementId === id ? snapshot : emptySiteLog(id ?? '')
  const { agreementLabel, siteContact, dailyLogs, tickets, loading } = current

  useEffect(() => {
    if (!id) return
    let active = true
    void loadSiteLog(id, {
      localAgreement: agreementId => db.rentalAgreements.get(agreementId),
      localLogs: agreementId => db.rentalDailyLogs.where('rentalAgreementId').equals(agreementId).toArray(),
      remoteAgreement: agreementId => api.get<SiteLogAgreement>(`/rentals/${agreementId}`),
      remoteLogs: agreementId => api.get<{ data: DailyLog[] }>(`/rentals/${agreementId}/daily-logs`),
    }, setSnapshot, () => active)
    return () => { active = false }
  }, [id])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    )
  }

  if (!id || !user) {
    return (
      <div className="text-center py-20 text-slate-400">
        <p className="font-medium">Missing rental agreement</p>
        <button onClick={() => navigate('/rentals')} className="mt-3 text-blue-600 text-sm font-medium">
          Back to Rentals
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-slate-200 shrink-0">
        <button
          onClick={() => navigate(`/rentals/${id}`)}
          className="p-1.5 -ml-1.5 text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-slate-900 truncate">Site Log</h1>
          {agreementLabel && (
            <p className="text-xs text-slate-500 truncate">{agreementLabel}</p>
          )}
        </div>
      </div>

      {/* Site contact banner */}
      {siteContact && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 shrink-0">
          <button
            type="button"
            onClick={() => setContactExpanded(!contactExpanded)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="text-xs font-medium text-blue-800">
              Site Contact: {siteContact.name}
            </span>
            <span className="text-[10px] text-blue-600">{contactExpanded ? 'hide' : 'show'}</span>
          </button>
          {contactExpanded && (
            <div className="flex gap-4 mt-1.5 flex-wrap">
              {siteContact.phone && (
                <a href={`tel:${siteContact.phone}`} className="flex items-center gap-1.5 text-sm text-blue-700 hover:text-blue-900 font-medium">
                  <Phone className="w-3.5 h-3.5" />
                  {siteContact.phone}
                </a>
              )}
              {siteContact.email && (
                <a href={`mailto:${siteContact.email}`} className="flex items-center gap-1.5 text-sm text-blue-700 hover:text-blue-900 font-medium">
                  <Mail className="w-3.5 h-3.5" />
                  {siteContact.email}
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {/* Actual rental daily logs, then related tickets */}
      <div className="flex-1 overflow-auto px-4 py-3">
        <div className="mb-5">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="text-sm font-semibold text-slate-700">Daily Log Entries</h2>
            {dailyLogs.length > 0 && (
              <span className="text-xs text-slate-400">
                {dailyLogs.length} day{dailyLogs.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {dailyLogs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-white p-5 text-center text-slate-400">
              <ClipboardList className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="font-medium">No daily log entries yet</p>
              <p className="text-sm mt-1">Notes and H2S readings mirrored from daily tickets will appear here.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {dailyLogs.map(log => {
                const facts = logFacts(log)
                return (
                  <div key={log.id} className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {formatCalendarDateNumeric(log.logDate)}
                        </p>
                        <p className="text-xs text-slate-500">
                          {log.loggedByName ? `Logged by ${log.loggedByName}` : 'Daily rental log'}
                        </p>
                      </div>
                      {facts.length > 0 && (
                        <span className="text-[10px] leading-5 px-2 rounded-full bg-slate-100 text-slate-600 font-medium capitalize">
                          {facts[0]}
                        </span>
                      )}
                    </div>
                    {facts.length > 1 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {facts.slice(1).map(fact => (
                          <span key={fact} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-200 capitalize">
                            {fact}
                          </span>
                        ))}
                      </div>
                    )}
                    {log.notes && (
                      <p className="text-xs text-slate-700 whitespace-pre-wrap mt-2">{log.notes}</p>
                    )}
                    {log.entries.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {[...log.entries].sort((a, b) => `${a.date || log.logDate.slice(0, 10)}T${a.time}`.localeCompare(`${b.date || log.logDate.slice(0, 10)}T${b.time}`)).map(entry => (
                          <div key={entry.id} className="border-l-2 border-slate-200 pl-3">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-mono text-slate-500">{entry.date || log.logDate.slice(0, 10)} {entry.time || '--:--'}</span>
                              {entry.type === 'h2s' ? (
                                <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">
                                  H2S {entry.ppm ?? '?'} ppm
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">
                                  Note
                                </span>
                              )}
                              {entry.location && <span className="text-slate-400">{entry.location}</span>}
                              {entry.airDeployed && <span className="text-blue-700 font-medium">Air deployed</span>}
                            </div>
                            {entry.text && (
                              <p className="text-sm text-slate-800 whitespace-pre-wrap mt-1">{entry.text}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="text-sm font-semibold text-slate-700">Related Tickets</h2>
            {tickets.length > 0 && (
              <span className="text-xs text-slate-400">
                {tickets.length} ticket{tickets.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {tickets.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <ClipboardList className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p className="font-medium">No tickets yet</p>
              <p className="text-sm mt-1">The deploy and any field tickets logged against this rental will appear here.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {tickets.map(t => {
                const deploy = t.ticketType === 'rental'
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => navigate(`/tickets/${t.id}`)}
                    className={`w-full text-left rounded-lg border p-3 transition-colors hover:bg-slate-50 ${
                      deploy ? 'border-amber-300 bg-amber-50/60' : 'border-slate-200 bg-white'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                        {deploy && <Truck className="w-4 h-4 text-amber-600 shrink-0" />}
                        {t.ticketNumber}
                        {deploy && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-900 font-semibold uppercase">
                            Deploy
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium uppercase">
                          {t.status}
                        </span>
                        <ChevronRight className="w-4 h-4 text-slate-400" />
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>{formatCalendarDateNumeric(t.serviceDate)}</span>
                      {t.assignedTechName && <span>• {t.assignedTechName}</span>}
                      {t.serviceSubtype && <span>• {t.serviceSubtype.replace(/_/g, ' ')}</span>}
                    </div>
                    {t.workDescription && (
                      <p className="text-xs text-slate-700 mt-1 line-clamp-2">{t.workDescription}</p>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
