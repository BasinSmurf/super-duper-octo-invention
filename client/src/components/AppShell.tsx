import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { SiteSwitcher } from '@/components/SiteSwitcher'
import { CompanyBrand } from '@/components/CompanyBrand'
import { BugReportButton } from '@/components/BugReportButton'
import { PinSetupNag } from '@/components/PinSetupNag'
import { useSync } from '@/contexts/SyncContext'
import { cn } from '@/lib/cn'
import {
  ClipboardList,
  Building2,
  MapPin,
  Package,
  Wrench,
  Warehouse,
  Printer,
  Monitor,
  SlidersHorizontal,
  Hammer,
  Truck,
  DollarSign,
  Wind,
  Route,
  Send,
  LayoutDashboard,
  Settings,
  Bell,
  Activity,
  CheckSquare,
  ListChecks,
  History,
  CreditCard,
  GraduationCap,
  HardHat,
  CalendarDays,
  Shield,
  KeyRound,
  ShieldCheck,
  Search,
  AlertTriangle,
  LogOut,
  Menu,
  X,
  ChevronDown,
} from 'lucide-react'
import { useState, useEffect, lazy, Suspense } from 'react'
import { usePermissions } from '@/contexts/PermissionsContext'

type NavItem = {
  to: string
  label: string
  icon: typeof ClipboardList
  /** Page-view capability gating this item (e.g. 'page:routes'). */
  cap: string
  /**
   * Optional tab name for items that deep-link into /dashboard?tab=X.
   * When set, active-state matches pathname + ?tab= rather than pathname
   * alone, so e.g. "Approvals" only lights up when ?tab=approvals is set.
   */
  tab?: string
  /**
   * Match this path exactly. Set on landing pages that sit above their own
   * children in a group (e.g. /billing above /billing/lineage) so the parent
   * doesn't stay lit while a child is open.
   */
  exact?: boolean
}

type NavGroup = {
  key: string
  label: string
  items: NavItem[]
}

// Top-level items — always rendered flat, one click away
const TOP_LEVEL: NavItem[] = [
  { to: '/my-jobs', label: 'My Jobs', icon: ListChecks, cap: 'page:my_jobs' },
  { to: '/tickets', label: 'Tickets', icon: ClipboardList, cap: 'page:tickets' },
  { to: '/shop', label: 'Shop Service', icon: Hammer, cap: 'page:shop' },
  { to: '/rentals', label: 'Rentals', icon: Truck, cap: 'page:rentals' },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, cap: 'page:dashboard', tab: 'overview' },
  { to: '/admin/ops', label: 'Ops', icon: Activity, cap: 'page:ops' },
]

// Grouped items — collapsible on desktop, state persisted per-group
const NAV_GROUPS: NavGroup[] = [
  {
    key: 'operations',
    label: 'Operations',
    items: [
      { to: '/dispatch', label: 'Dispatch', icon: Send, cap: 'page:dispatch' },
      // Two halves of the shop, two boards. `exact` on the customer board so it
      // doesn't stay lit while its /inhouse sibling is open.
      { to: '/shop-board', label: 'Shop Board', icon: LayoutDashboard, cap: 'page:shop_board', exact: true },
      { to: '/shop-board/inhouse', label: 'In-House Board', icon: HardHat, cap: 'page:shop_board' },
      // The rentals board was reachable only by typing the URL — routed, built,
      // and with no door anywhere in the app. Site + pickup-type are filters on
      // the page itself, so one entry covers every combination.
      { to: '/rentals-board', label: 'Rentals Board', icon: Truck, cap: 'page:rentals' },
      { to: '/stale-transfers', label: 'Stale Transfers', icon: Truck, cap: 'page:stale_transfers' },
      { to: '/coverage', label: 'Coverage', icon: Wind, cap: 'page:coverage' },
      { to: '/routes', label: 'Routes', icon: Route, cap: 'page:routes' },
      { to: '/dashboard?tab=approvals', label: 'Approvals', icon: CheckSquare, cap: 'page:approvals', tab: 'approvals' },
      { to: '/dashboard?tab=history', label: 'Service History', icon: History, cap: 'page:history', tab: 'history' },
    ],
  },
  {
    key: 'data',
    label: 'Data',
    items: [
      { to: '/locations', label: 'Locations', icon: MapPin, cap: 'page:locations' },
      { to: '/equipment', label: 'Equipment', icon: Wrench, cap: 'page:equipment' },
    ],
  },
  {
    key: 'training',
    label: 'Training',
    items: [
      { to: '/training/calendar', label: 'Calendar', icon: CalendarDays, cap: 'page:training' },
      { to: '/admin/courses', label: 'Courses', icon: GraduationCap, cap: 'page:courses' },
      { to: '/admin/training', label: 'Training Setup', icon: SlidersHorizontal, cap: 'page:training' },
      { to: '/dashboard?tab=cards', label: 'Card Issuance', icon: CreditCard, cap: 'page:cards', tab: 'cards' },
    ],
  },
  {
    key: 'billing',
    label: 'Billing',
    items: [
      { to: '/billing', label: 'Billing', icon: DollarSign, cap: 'page:billing', exact: true },
      { to: '/billing/lineage', label: 'Billing Lineage', icon: Search, cap: 'page:billing' },
      { to: '/billing/attention', label: 'Billing Attention', icon: AlertTriangle, cap: 'page:billing' },
      { to: '/companies', label: 'Customers', icon: Building2, cap: 'page:companies' },
      { to: '/products', label: 'Products', icon: Package, cap: 'page:products' },
    ],
  },
  {
    key: 'admin',
    label: 'Admin',
    items: [
      { to: '/settings', label: 'Admin', icon: Settings, cap: 'page:admin' },
      { to: '/admin/webhooks', label: 'Webhooks', icon: Bell, cap: 'system:config' },
      { to: '/admin/permissions', label: 'Permissions', icon: Shield, cap: 'page:permissions' },
      { to: '/admin/api-keys', label: 'API Keys', icon: KeyRound, cap: 'page:api_keys' },
      { to: '/admin/novara', label: 'Novara Sync', icon: ShieldCheck, cap: 'page:novara' },
      { to: '/sites', label: 'Sites', icon: Warehouse, cap: 'page:sites' },
      { to: '/printers', label: 'Printers', icon: Printer, cap: 'page:printers' },
      { to: '/kiosks', label: 'Kiosks', icon: Monitor, cap: 'page:kiosks' },
      { to: '/board-settings', label: 'Board Settings', icon: SlidersHorizontal, cap: 'page:board_settings' },
    ],
  },
]

// If a role's total visible item count is ≤ this, flatten (skip groups)
const FLATTEN_THRESHOLD = 4

// Lazy: office-only roles never render this, so it (and the syncEngine/db
// chunk it pulls in) should never be fetched for them either.
const SyncStatusBar = lazy(() => import('@/components/SyncStatusBar').then(m => ({ default: m.SyncStatusBar })))

export function AppShell() {
  const { user, logout } = useAuth()
  const { can } = usePermissions()
  const { isOnline, syncState, enabled: syncEnabled } = useSync()
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  /**
   * Active-state for nav items that deep-link into /dashboard?tab=X.
   *   tab === 'overview' (or undefined query param) matches the bare /dashboard
   *   Any other tab must match the ?tab query param exactly.
   */
  function isNavItemActive(item: NavItem): boolean | undefined {
    if (!item.tab) return undefined // fall through to default NavLink matching
    if (location.pathname !== '/dashboard') return false
    const currentTab = new URLSearchParams(location.search).get('tab') || 'overview'
    return currentTab === item.tab
  }

  const visibleTop = TOP_LEVEL.filter(item => can(item.cap))
  const visibleGroups = NAV_GROUPS
    .map(g => ({ ...g, items: g.items.filter(i => can(i.cap)) }))
    .filter(g => g.items.length > 0)

  const totalVisible = visibleTop.length + visibleGroups.reduce((n, g) => n + g.items.length, 0)
  const flatten = totalVisible <= FLATTEN_THRESHOLD

  // Collapsed-group state, persisted to localStorage (default: all closed)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('sidebar.openGroups')
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    try { localStorage.setItem('sidebar.openGroups', JSON.stringify(openGroups)) } catch { /* noop */ }
  }, [openGroups])
  function toggleGroup(key: string) {
    setOpenGroups(prev => ({ ...prev, [key]: !prev[key] }))
  }

  // Live clock — updates every minute, uses device local time
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 shrink-0 bg-slate-900 text-white transform transition-transform lg:translate-x-0 lg:static lg:inset-0 flex flex-col',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2 p-3 border-b border-slate-700 shrink-0">
          <div className="min-w-0 flex-1 rounded-lg bg-white/95 px-2.5 py-1.5 shadow-sm ring-1 ring-white/10">
            <CompanyBrand containerClassName="w-full" className="h-auto w-full max-h-32 object-contain" />
          </div>
          <button className="lg:hidden shrink-0 text-slate-400 hover:text-white" onClick={() => setSidebarOpen(false)}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="shrink-0">
          <SiteSwitcher />
        </div>

        <nav className="flex-1 min-h-0 p-3 space-y-1 overflow-y-auto">
          {(() => {
            const renderLink = (item: NavItem, indent = false) => {
              const customActive = isNavItemActive(item)
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setSidebarOpen(false)}
                  end={item.exact || item.tab === 'overview'} // bare /dashboard shouldn't match deep-link children
                  className={({ isActive }) => {
                    const active = customActive !== undefined ? customActive : isActive
                    return cn(
                      'flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors',
                      indent && 'pl-9 py-2',
                      active
                        ? 'bg-blue-800 text-white'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                    )
                  }}
                >
                  <item.icon className={cn('w-5 h-5', indent && 'w-4 h-4')} />
                  {item.label}
                </NavLink>
              )
            }

            if (flatten) {
              // Small role — flat list, no groups
              const all = [...visibleTop, ...visibleGroups.flatMap(g => g.items)]
              return all.map(item => renderLink(item))
            }

            return (
              <>
                {visibleTop.map(item => renderLink(item))}
                {visibleGroups.map(group => {
                  const isOpen = !!openGroups[group.key]
                  return (
                    <div key={group.key} className="pt-1">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.key)}
                        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-white transition-colors"
                      >
                        <span>{group.label}</span>
                        <ChevronDown
                          className={cn('w-4 h-4 transition-transform', isOpen ? 'rotate-0' : '-rotate-90')}
                        />
                      </button>
                      {isOpen && (
                        <div className="space-y-0.5 mt-0.5">
                          {group.items.map(item => renderLink(item, true))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            )
          })()}
        </nav>

        <div className="shrink-0 p-4 border-t border-slate-700 space-y-3">
          {/* Sync status — office-only roles never load this (ADR-0005) */}
          {syncEnabled && (
            <Suspense fallback={null}>
              <SyncStatusBar />
            </Suspense>
          )}

          {/* Current date/time (device local) */}
          <p className="text-[11px] text-slate-400 text-center">
            {now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
            {' · '}
            {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>

          <NavLink
            to="/account"
            className="flex items-center gap-3 rounded-lg -mx-1 px-1 py-1 hover:bg-slate-800 transition-colors"
          >
            <div className="w-8 h-8 rounded-full bg-blue-700 flex items-center justify-center text-sm font-bold">
              {user?.name?.charAt(0) || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.name}</p>
              <p className="text-xs text-slate-400 truncate">{user?.role?.replace('_', ' ')}</p>
            </div>
          </NavLink>
          <BugReportButton />
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-3 py-2 text-sm text-slate-400 hover:text-white transition-colors w-full rounded-lg hover:bg-slate-800"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar (mobile) */}
        <header className="lg:hidden bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <button onClick={() => setSidebarOpen(true)} className="text-slate-600">
            <Menu className="w-6 h-6" />
          </button>
          <CompanyBrand className="h-7 max-w-44 object-contain object-left" />
          {/* Mobile online/offline indicator */}
          <div className="flex items-center gap-1.5">
            {syncState.pendingMutations > 0 && (
              <span className="text-xs text-amber-500 font-medium">{syncState.pendingMutations}↑</span>
            )}
            <div className={cn(
              'w-2.5 h-2.5 rounded-full',
              isOnline ? 'bg-green-400' : 'bg-red-400',
            )} />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 lg:p-6 overflow-auto">
          <Outlet />
        </main>
      </div>

      {/* Pester staff without a PIN to set one (skippable, re-shows each login). */}
      <PinSetupNag />
    </div>
  )
}
