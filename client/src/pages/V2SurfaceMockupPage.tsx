import { useMemo, useState } from 'react'
import {
  Activity,
  AppWindow,
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  CloudOff,
  DollarSign,
  FileCheck2,
  FileText,
  GraduationCap,
  HeartPulse,
  Layers3,
  MapPin,
  PackageCheck,
  PhoneCall,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Truck,
  UserRoundCheck,
  Warehouse,
  Wifi,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/cn'

type SurfaceKey = 'field' | 'shop' | 'billing' | 'ops' | 'compliance' | 'admin'
type WorkTypeKey =
  | 'field_service'
  | 'ih_testing'
  | 'rental_deploy'
  | 'daily_log'
  | 'inspection'
  | 'training'
  | 'occ_health'
  | 'shop_repair'

type SignoffPolicy = 'Work only' | 'Pricing call required' | 'Customer PO required' | 'Office quote required'

interface Surface {
  key: SurfaceKey
  label: string
  audience: string
  icon: typeof AppWindow
}

interface WorkType {
  key: WorkTypeKey
  label: string
  division: 'D3' | 'D4' | 'D6'
  surface: SurfaceKey
  icon: typeof ClipboardList
  offline: boolean
  signoff: SignoffPolicy
  instruction: string
  capture: string[]
  review: string[]
}

const surfaces: Surface[] = [
  { key: 'field', label: 'Field Work', audience: 'Techs, supervisors', icon: Truck },
  { key: 'shop', label: 'Shop Floor', audience: 'Bench, intake, QA', icon: Warehouse },
  { key: 'billing', label: 'Billing', audience: 'Home office, AR', icon: DollarSign },
  { key: 'ops', label: 'Ops Control', audience: 'Dispatch, managers', icon: Activity },
  { key: 'compliance', label: 'Compliance', audience: 'Training, occ health', icon: BadgeCheck },
  { key: 'admin', label: 'Admin', audience: 'Platform owners', icon: SlidersHorizontal },
]

const workTypes: WorkType[] = [
  {
    key: 'field_service',
    label: 'Field Service',
    division: 'D3',
    surface: 'field',
    icon: BriefcaseBusiness,
    offline: true,
    signoff: 'Work only',
    instruction: 'Capture the work performed. Home office rates it from the MSA.',
    capture: ['Service date/time', 'Work point', 'H2S/readings', 'Labor blocks', 'Photos', 'Customer signature'],
    review: ['MSA labor minimums', 'Travel policy', 'Customer-required notes', 'Approval routing'],
  },
  {
    key: 'ih_testing',
    label: 'IH Testing',
    division: 'D3',
    surface: 'field',
    icon: ShieldCheck,
    offline: true,
    signoff: 'Work only',
    instruction: 'Record samples, readings, context, and chain-of-custody details.',
    capture: ['Sample set', 'Exposure context', 'Device/calibration', 'Attachments', 'Signature'],
    review: ['IH line mapping', 'Report delivery rules', 'Special customer language'],
  },
  {
    key: 'rental_deploy',
    label: 'Rental Deploy',
    division: 'D4',
    surface: 'field',
    icon: PackageCheck,
    offline: true,
    signoff: 'Pricing call required',
    instruction: 'Call Dave at customer dispatch before presenting the daily sheet.',
    capture: ['Items deployed', 'Serials', 'Location', 'Start date', 'Approval contact', 'Signature'],
    review: ['Rental rate table', 'Day-one deploy charge', 'Customer exceptions', 'Sales tax jurisdiction'],
  },
  {
    key: 'daily_log',
    label: 'Rental Daily Log',
    division: 'D4',
    surface: 'field',
    icon: ClipboardCheck,
    offline: true,
    signoff: 'Pricing call required',
    instruction: 'If pricing is required, record who approved it and any reference number.',
    capture: ['On-rent items', 'Usage day', 'Status', 'Issues', 'Approval reference', 'Signature'],
    review: ['Billable rental days', 'Standby rules', 'Lost/damaged flags', 'Invoice grouping'],
  },
  {
    key: 'inspection',
    label: 'Equipment Inspection',
    division: 'D6',
    surface: 'field',
    icon: FileCheck2,
    offline: true,
    signoff: 'Work only',
    instruction: 'Inspection result is factual. Billing decides service, parts, or no-charge.',
    capture: ['Barcode/serial', 'Checklist', 'Outcome', 'Photos', 'Parts observed', 'Tech notes'],
    review: ['Inspection SKU', 'Parts/labor policy', 'Condemned handling', 'BlueLion push'],
  },
  {
    key: 'training',
    label: 'Training',
    division: 'D3',
    surface: 'compliance',
    icon: GraduationCap,
    offline: true,
    signoff: 'Customer PO required',
    instruction: 'Collect roster and attendance. Billing validates PO and course pricing.',
    capture: ['Roster', 'Course', 'Instructor', 'Attendee signatures', 'Cards/certs'],
    review: ['Per-student pricing', 'Card issuance', 'BlueLion sync', 'Customer PO'],
  },
  {
    key: 'occ_health',
    label: 'Occ Health',
    division: 'D3',
    surface: 'compliance',
    icon: HeartPulse,
    offline: true,
    signoff: 'Office quote required',
    instruction: 'Capture exam result data. Office confirms pricing before customer-facing docs.',
    capture: ['Person', 'Test method', 'Result', 'Disclosure fields', 'PDF packet'],
    review: ['Occ health rate', 'Result delivery', 'BlueLion sync', 'Privacy audit'],
  },
  {
    key: 'shop_repair',
    label: 'Shop Repair',
    division: 'D6',
    surface: 'shop',
    icon: Wrench,
    offline: true,
    signoff: 'Work only',
    instruction: 'Shop captures intake, diagnosis, item status, QA, parts, and pickup.',
    capture: ['Intake', 'Per-item status', 'Diagnosis', 'Parts used', 'QA inspection', 'Pickup'],
    review: ['Repair labor', 'Parts pricing', 'Warranty/outside service', 'Force-close rules'],
  },
]

const syncEvents = [
  { label: 'Draft saved locally', detail: 'Local ID ft-7A19, photos queued', state: 'done' },
  { label: 'Signature packet ready', detail: 'Work facts and approval contact cached', state: 'done' },
  { label: 'Awaiting connection', detail: '3 mutations, 5 attachments, no duplicate risk', state: 'pending' },
  { label: 'Billing review not created yet', detail: 'Generated only after clean server sync', state: 'blocked' },
]

export function V2SurfaceMockupPage() {
  const [activeSurface, setActiveSurface] = useState<SurfaceKey>('field')
  const [activeWorkType, setActiveWorkType] = useState<WorkTypeKey>('rental_deploy')
  const [online, setOnline] = useState(false)

  const selectedWork = workTypes.find((w) => w.key === activeWorkType) ?? workTypes[0]
  const visibleWorkTypes = useMemo(
    () => workTypes.filter((w) => activeSurface === 'billing' || activeSurface === 'ops' || w.surface === activeSurface),
    [activeSurface],
  )

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-800 text-white">
              <Layers3 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">ServicePRO V2 Control Surfaces</h1>
              <p className="text-sm text-slate-500">Work capture stays factual. Billing decides what to charge.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOnline((value) => !value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium',
                online
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-900',
              )}
            >
              {online ? <Wifi className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />}
              {online ? 'Online' : 'Offline mode'}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
            >
              <AppWindow className="h-4 w-4" />
              App Switcher
            </button>
          </div>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-73px)] grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-slate-950 p-3 text-white lg:border-b-0 lg:border-r">
          <div className="mb-3 px-2 text-xs font-semibold uppercase text-slate-400">Surfaces</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {surfaces.map((surface) => {
              const Icon = surface.icon
              const isActive = activeSurface === surface.key
              return (
                <button
                  key={surface.key}
                  type="button"
                  onClick={() => {
                    setActiveSurface(surface.key)
                    const first = workTypes.find((w) => w.surface === surface.key)
                    if (first) setActiveWorkType(first.key)
                  }}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-3 text-left transition',
                    isActive ? 'bg-blue-700 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800',
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{surface.label}</span>
                    <span className="block truncate text-xs text-slate-400">{surface.audience}</span>
                  </span>
                </button>
              )
            })}
          </div>

          <div className="mt-5 rounded-md border border-slate-700 bg-slate-900 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <UserRoundCheck className="h-4 w-4 text-emerald-300" />
              Higher-level users
            </div>
            <p className="text-sm leading-5 text-slate-300">
              Managers land here and switch surfaces. Techs land directly on the work they can perform.
            </p>
          </div>
        </aside>

        <main className="min-w-0 p-4 lg:p-5">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_380px]">
            <section className="min-w-0 space-y-4">
              <div className="rounded-md border border-slate-200 bg-white p-4">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-base font-semibold">Field Tech Work Picker</h2>
                    <p className="text-sm text-slate-500">Pick what happened. Division follows the work type.</p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
                    <MapPin className="h-4 w-4" />
                    BZN-42 / McKenzie County
                  </div>
                </div>

                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  {visibleWorkTypes.map((work) => {
                    const Icon = work.icon
                    const isActive = selectedWork.key === work.key
                    return (
                      <button
                        key={work.key}
                        type="button"
                        onClick={() => setActiveWorkType(work.key)}
                        className={cn(
                          'min-h-28 rounded-md border p-3 text-left transition',
                          isActive
                            ? 'border-blue-700 bg-blue-50 ring-2 ring-blue-100'
                            : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50',
                        )}
                      >
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <Icon className={cn('h-5 w-5', isActive ? 'text-blue-800' : 'text-slate-500')} />
                          <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                            {work.division}
                          </span>
                        </div>
                        <div className="text-sm font-semibold text-slate-950">{work.label}</div>
                        <div className="mt-1 text-xs leading-4 text-slate-500">{work.signoff}</div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <div className="rounded-md border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold">{selectedWork.label} Capture</h2>
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800">
                      <CloudOff className="h-3.5 w-3.5" />
                      Offline-first
                    </span>
                  </div>
                  <div className="space-y-2">
                    {selectedWork.capture.map((item) => (
                      <label key={item} className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2">
                        <input type="checkbox" defaultChecked className="h-4 w-4 accent-blue-700" />
                        <span className="text-sm text-slate-700">{item}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="rounded-md border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <PhoneCall className="h-5 w-5 text-amber-700" />
                    <h2 className="text-base font-semibold">Daily Sign-off Procedure</h2>
                  </div>
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                    <div className="text-sm font-semibold text-amber-950">{selectedWork.signoff}</div>
                    <p className="mt-1 text-sm leading-5 text-amber-900">{selectedWork.instruction}</p>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">Contact</label>
                      <input
                        defaultValue={selectedWork.signoff.includes('Pricing') ? 'Dave - customer dispatch' : 'N/A'}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">Reference</label>
                      <input defaultValue="verbal approval 14:32" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                    </div>
                  </div>

                  <div className="mt-3 rounded-md border border-slate-200 p-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                      <FileText className="h-4 w-4" />
                      Customer signs the daily sheet
                    </div>
                    <p className="mt-1 text-sm leading-5 text-slate-500">
                      The sheet shows work, quantities, and approval contact. It does not make the tech calculate final invoice lines.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-slate-200 bg-white p-4">
                <h2 className="mb-3 text-base font-semibold">Boundary Between Work and Billing</h2>
                <div className="grid gap-3 lg:grid-cols-3">
                  <ProcessColumn
                    icon={ClipboardList}
                    title="1. Work Record"
                    tone="blue"
                    lines={['Facts captured by tech', 'Local draft and local IDs', 'Photos, signatures, readings', 'Syncs without pricing']}
                  />
                  <ProcessColumn
                    icon={Building2}
                    title="2. Billing Review"
                    tone="amber"
                    lines={selectedWork.review}
                  />
                  <ProcessColumn
                    icon={FileCheck2}
                    title="3. Invoice"
                    tone="emerald"
                    lines={['Frozen line items', 'Billing profile grouping', 'QB/Enverus/Stripe paths', 'Audit trail and PDF']}
                  />
                </div>
              </div>
            </section>

            <aside className="space-y-4">
              <div className="rounded-md border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-base font-semibold">Offline Queue</h2>
                  <span className={cn('rounded px-2 py-1 text-xs font-semibold', online ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900')}>
                    {online ? 'Syncing' : 'Holding'}
                  </span>
                </div>
                <div className="space-y-3">
                  {syncEvents.map((event) => (
                    <div key={event.label} className="flex gap-3">
                      <div
                        className={cn(
                          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                          event.state === 'done' && 'bg-emerald-100 text-emerald-800',
                          event.state === 'pending' && 'bg-amber-100 text-amber-900',
                          event.state === 'blocked' && 'bg-slate-100 text-slate-600',
                        )}
                      >
                        {event.state === 'done' ? <CheckCircle2 className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-slate-800">{event.label}</div>
                        <div className="text-sm leading-5 text-slate-500">{event.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-md border border-slate-200 bg-white p-4">
                <h2 className="mb-3 text-base font-semibold">Role Landing</h2>
                <div className="space-y-2">
                  <RoleRow role="Field tech" lands="Field Work" sees="Work picker, My Jobs, inspections" />
                  <RoleRow role="Shop tech" lands="Shop Floor" sees="Intake, board, QA, pickup" />
                  <RoleRow role="Billing AR" lands="Billing" sees="Review packets, profiles, invoices" />
                  <RoleRow role="Boss / manager" lands="Ops Control" sees="Switcher, reports, exceptions" />
                </div>
              </div>

              <div className="rounded-md border border-slate-200 bg-white p-4">
                <h2 className="mb-3 text-base font-semibold">Sticky Rule</h2>
                <div className="rounded-md bg-slate-950 p-3 text-sm leading-6 text-slate-100">
                  <div>Surface = where they work</div>
                  <div>Work type = what they did</div>
                  <div>Division = classification</div>
                  <div>MSA = what to charge</div>
                  <div>Billing profile = how to bill</div>
                </div>
              </div>
            </aside>
          </div>
        </main>
      </div>
    </div>
  )
}

function ProcessColumn({
  icon: Icon,
  title,
  tone,
  lines,
}: {
  icon: typeof ClipboardList
  title: string
  tone: 'blue' | 'amber' | 'emerald'
  lines: string[]
}) {
  const toneClass = {
    blue: 'bg-blue-50 text-blue-800 border-blue-100',
    amber: 'bg-amber-50 text-amber-900 border-amber-100',
    emerald: 'bg-emerald-50 text-emerald-800 border-emerald-100',
  }[tone]

  return (
    <div className={cn('rounded-md border p-3', toneClass)}>
      <div className="mb-3 flex items-center gap-2 font-semibold">
        <Icon className="h-5 w-5" />
        <span>{title}</span>
      </div>
      <ul className="space-y-2">
        {lines.map((line) => (
          <li key={line} className="flex gap-2 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RoleRow({ role, lands, sees }: { role: string; lands: string; sees: string }) {
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-800">{role}</div>
          <div className="text-sm text-slate-500">{sees}</div>
        </div>
        <span className="shrink-0 rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{lands}</span>
      </div>
    </div>
  )
}
