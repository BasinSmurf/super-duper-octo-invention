import type { SiteLogEntry } from './db-types'

export interface SiteLogTicket {
  id: string
  ticketNumber: string
  ticketType: string
  serviceSubtype: string | null
  status: string
  serviceDate: string
  assignedTechName: string | null
  workDescription: string | null
}

export interface DailyLog {
  id: string
  logDate: string
  loggedByName?: string | null
  equipmentPresent?: boolean | null
  equipmentStatus?: string | null
  cascadeStatus?: string | null
  bottlesFullCount?: number | null
  bottlesTotalCount?: number | null
  monitorsBumpTested?: boolean | null
  monitorsOperationalCount?: number | null
  monitorsTotalCount?: number | null
  notes?: string | null
  entries: SiteLogEntry[]
}
type StoredLog = Omit<DailyLog, 'entries'> & { entries?: SiteLogEntry[] | null }

interface AgreementContact {
  id: string
  agreementNumber?: string | null
  companyName?: string | null
  siteContactName?: string | null
  siteContactPhone?: string | null
  siteContactEmail?: string | null
}
export interface SiteLogAgreement extends AgreementContact {
  company?: { name: string } | null
  linkedServiceTickets?: Array<Omit<SiteLogTicket, 'assignedTechName'> & { assignedTech?: { name: string } | null }>
}
export interface SiteLogSnapshot {
  agreementId: string
  agreementLabel: string
  siteContact: { name: string; phone: string; email: string } | null
  dailyLogs: DailyLog[]
  tickets: SiteLogTicket[]
  loading: boolean
}
interface Sources {
  localAgreement: (id: string) => Promise<AgreementContact | undefined>
  localLogs: (id: string) => Promise<StoredLog[]>
  remoteAgreement: (id: string) => Promise<SiteLogAgreement>
  remoteLogs: (id: string) => Promise<{ data: StoredLog[] }>
}

export function emptySiteLog(agreementId: string): SiteLogSnapshot {
  return { agreementId, agreementLabel: '', siteContact: null, dailyLogs: [], tickets: [], loading: !!agreementId }
}
function contact(agreement: AgreementContact) {
  return agreement.siteContactName ? {
    name: agreement.siteContactName,
    phone: agreement.siteContactPhone || '',
    email: agreement.siteContactEmail || '',
  } : null
}
function logs(rows: StoredLog[]): DailyLog[] {
  return rows.map(row => ({ ...row, entries: Array.isArray(row.entries) ? row.entries : [] }))
    .sort((a, b) => b.logDate.localeCompare(a.logDate))
}
function tickets(rows: NonNullable<SiteLogAgreement['linkedServiceTickets']>): SiteLogTicket[] {
  return rows.map(row => ({ ...row, assignedTechName: row.assignedTech?.name ?? null }))
    .sort((a, b) => {
      const ad = a.ticketType === 'rental', bd = b.ticketType === 'rental'
      if (ad !== bd) return ad ? -1 : 1
      return ad ? a.serviceDate.localeCompare(b.serviceDate) : b.serviceDate.localeCompare(a.serviceDate)
    })
}

/** Publish cached data first; only the current rental may publish remote results. */
export async function loadSiteLog(
  agreementId: string, sources: Sources,
  publish: (snapshot: SiteLogSnapshot) => void, isCurrent: () => boolean,
): Promise<void> {
  let snapshot = emptySiteLog(agreementId)
  const [cachedAgreement, cachedLogs] = await Promise.allSettled([
    Promise.resolve().then(() => sources.localAgreement(agreementId)),
    Promise.resolve().then(() => sources.localLogs(agreementId)),
  ])
  if (!isCurrent()) return
  if (cachedAgreement.status === 'fulfilled' && cachedAgreement.value) {
    const agreement = cachedAgreement.value
    snapshot = { ...snapshot, agreementLabel: [agreement.agreementNumber, agreement.companyName].filter(Boolean).join(' — '), siteContact: contact(agreement) }
  }
  if (cachedLogs.status === 'fulfilled') snapshot = { ...snapshot, dailyLogs: logs(cachedLogs.value) }
  publish(snapshot)

  // A failed agreement lookup must not discard a successful daily-log lookup.
  const [remoteAgreement, remoteLogs] = await Promise.allSettled([
    Promise.resolve().then(() => sources.remoteAgreement(agreementId)),
    Promise.resolve().then(() => sources.remoteLogs(agreementId)),
  ])
  if (!isCurrent()) return
  if (remoteAgreement.status === 'fulfilled' && remoteAgreement.value.id === agreementId) {
    const agreement = remoteAgreement.value
    snapshot = { ...snapshot, agreementLabel: [agreement.agreementNumber, agreement.company?.name].filter(Boolean).join(' — '),
      siteContact: contact(agreement), tickets: tickets(agreement.linkedServiceTickets ?? []) }
  }
  if (remoteLogs.status === 'fulfilled') snapshot = { ...snapshot, dailyLogs: logs(remoteLogs.value.data ?? []) }
  publish({ ...snapshot, loading: false })
}
