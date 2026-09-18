import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, ArrowRight, ClipboardList, Download, MailPlus, PackageCheck, Wrench } from 'lucide-react'
import { api } from '@/lib/api'
import { formatCalendarDate } from '@/lib/dates'
import { customerStatus, statusBadgeClass, titleCase } from './portalUtils'

interface PortalSummary {
  company: { id: string; name: string } | null
  stats: {
    activeWork: number
    actions: number
    serviceTickets: number
    testingTickets: number
  }
  actions: Array<{
    id: string
    kind: string
    title: string
    subject: string
    detail: string
    href: string
    tone: 'danger' | 'warning' | 'ok'
  }>
  activeWork: Array<{
    id: string
    kind: 'ticket' | 'rental'
    title: string
    status: string
    detail: string
    date: string
    href: string
  }>
}

function StatCard({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="bg-white border border-slate-200 p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-extrabold text-black tabular-nums">{value}</p>
      <p className="mt-1 text-sm text-slate-600">{note}</p>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-500 py-6 text-center">{children}</p>
}

function portalStatusLabel(status: string) {
  const normalized = status.toLowerCase()
  if (normalized === 'active') return 'Active'
  if (normalized === 'scheduled') return 'Scheduled'
  if (normalized === 'completed') return 'Completed'
  return customerStatus(status)
}

function portalStatusClass(status: string) {
  const normalized = status.toLowerCase()
  if (normalized === 'active') return 'bg-green-50 text-green-700 border-green-200'
  if (normalized === 'scheduled') return 'bg-blue-50 text-blue-700 border-blue-200'
  if (normalized === 'completed') return 'bg-slate-100 text-slate-700 border-slate-200'
  return statusBadgeClass(status)
}

export function PortalHomePage() {
  const [summary, setSummary] = useState<PortalSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get<PortalSummary>('/portal/summary')
      .then(setSummary)
      .catch((err) => setError(err.message || 'Could not load portal summary'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-slate-500 text-sm py-10 text-center">Loading…</p>
  if (error) return <div className="bg-red-50 border border-red-200 text-red-700 p-3 text-sm">{error}</div>

  return (
    <div className="space-y-4">
      <section className="bg-white border border-slate-200 p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold text-black">Open work and service records</h1>
            <p className="text-sm text-slate-600 mt-1 max-w-3xl">
              Customer-side view for active Basin Safety work, shop approvals, rentals, and service-ticket exports.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="mailto:service@basinsafetyus.com?subject=Service%20request%20from%20ServicePRO%20portal"
              className="inline-flex items-center gap-2 px-3 py-2 bg-blue-700 text-white text-sm font-bold border border-blue-700 hover:bg-blue-800"
            >
              <MailPlus className="w-4 h-4" />
              Request Service
            </a>
            <Link
              to="/portal/service?testing=1"
              className="inline-flex items-center gap-2 px-3 py-2 bg-white text-slate-800 text-sm font-bold border border-slate-300 hover:bg-slate-50"
            >
              <Download className="w-4 h-4" />
              Testing CSV
            </Link>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Active work" value={summary?.stats.activeWork ?? 0} note="scheduled, in progress, or in shop" />
        <StatCard label="Customer actions" value={summary?.stats.actions ?? 0} note="approval or pickup tasks" />
        <StatCard label="Service tickets" value={summary?.stats.serviceTickets ?? 0} note="company-scoped history" />
        <StatCard label="Testing tickets" value={summary?.stats.testingTickets ?? 0} note="available for CSV export" />
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <div className="bg-white border border-slate-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <h2 className="font-extrabold text-black">Action Queue</h2>
              <Link to="/portal/shop" className="text-sm font-semibold text-blue-700 hover:underline">View shop approvals</Link>
            </div>
            <div className="p-4 space-y-3">
              {!summary?.actions.length ? (
                <EmptyState>No customer actions are open.</EmptyState>
              ) : (
                summary.actions.map((action) => (
                  <Link
                    key={action.id}
                    to={action.href}
                    className="grid grid-cols-[5px_minmax(0,1fr)_auto] gap-3 border border-slate-200 bg-slate-50 p-3 hover:bg-white"
                  >
                    <span
                      className={
                        action.tone === 'danger'
                          ? 'bg-red-400'
                          : action.tone === 'warning'
                            ? 'bg-amber-400'
                            : 'bg-green-400'
                      }
                    />
                    <span className="min-w-0">
                      <span className="block font-bold text-black">{action.title}</span>
                      <span className="block text-sm text-slate-700 mt-1">{action.subject}: {action.detail}</span>
                    </span>
                    <ArrowRight className="w-4 h-4 text-slate-400 self-center" />
                  </Link>
                ))
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <h2 className="font-extrabold text-black">Service Tickets</h2>
              <Link to="/portal/service" className="text-sm font-semibold text-blue-700 hover:underline">Open service history</Link>
            </div>
            <div className="p-4 grid gap-3 md:grid-cols-3">
              <Link to="/portal/service?type=inspection" className="border border-slate-200 p-3 hover:bg-slate-50">
                <ClipboardList className="w-5 h-5 text-blue-700 mb-2" />
                <h3 className="font-bold text-black">Sort by type</h3>
                <p className="text-sm text-slate-600 mt-1">Filter inspections, field service, rentals, and training.</p>
              </Link>
              <Link to="/portal/service?testing=1" className="border border-slate-200 p-3 hover:bg-slate-50">
                <Download className="w-5 h-5 text-blue-700 mb-2" />
                <h3 className="font-bold text-black">Testing export</h3>
                <p className="text-sm text-slate-600 mt-1">Download filtered testing results as CSV.</p>
              </Link>
              <Link to="/portal/shop" className="border border-slate-200 p-3 hover:bg-slate-50">
                <Wrench className="w-5 h-5 text-blue-700 mb-2" />
                <h3 className="font-bold text-black">Shop work</h3>
                <p className="text-sm text-slate-600 mt-1">Review shop status and approvals.</p>
              </Link>
            </div>
          </div>
        </div>

        <aside className="space-y-4 min-w-0">
          <div className="bg-white border border-slate-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <h2 className="font-extrabold text-black">Active Work</h2>
              <span className="px-2 py-1 text-xs font-bold bg-slate-100 text-slate-700">Customer-visible statuses</span>
            </div>
            <div className="p-4 space-y-3">
              {!summary?.activeWork.length ? (
                <EmptyState>No active work is currently visible.</EmptyState>
              ) : (
                summary.activeWork.map((work) => (
                  <Link key={work.id} to={work.href} className="block border border-slate-200 p-3 hover:bg-slate-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-bold text-black truncate">{work.title}</div>
                        <div className="text-sm text-slate-700 mt-1">{titleCase(work.detail)}</div>
                        {work.date && <div className="text-xs text-slate-500 mt-1">{formatCalendarDate(work.date)}</div>}
                      </div>
                      <span className={`text-xs px-2 py-0.5 border font-semibold whitespace-nowrap ${portalStatusClass(work.status)}`}>
                        {portalStatusLabel(work.status)}
                      </span>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-4">
            <div className="flex items-start gap-3">
              <PackageCheck className="w-5 h-5 text-blue-700 mt-0.5" />
              <div>
                <h2 className="font-extrabold text-black">Portal Scope</h2>
                <p className="text-sm text-slate-600 mt-1">
                  This portal intentionally omits invoice dollars and BlueLion compliance documents.
                </p>
              </div>
            </div>
          </div>

          {(summary?.stats.actions ?? 0) > 0 && (
            <div className="bg-amber-50 border border-amber-200 p-4 text-amber-900">
              <div className="flex gap-2">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm font-semibold">
                  {summary?.stats.actions} item{summary?.stats.actions === 1 ? '' : 's'} need customer attention.
                </p>
              </div>
            </div>
          )}
        </aside>
      </section>
    </div>
  )
}
