import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ArrowLeft, MailPlus, UserRound, LogOut } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/lib/api'

const TABS = [
  { to: '/portal', label: 'Home', end: true },
  { to: '/portal/service', label: 'Service Tickets', end: false },
  { to: '/portal/h2s', label: 'H₂S Test History', end: false },
  { to: '/portal/shop', label: 'Shop Approvals', end: false },
  { to: '/portal/rentals', label: 'Rentals', end: false },
]

interface PortalMe {
  user: { id: string; name: string; email: string } | null
  company: { id: string; name: string } | null
}

export function PortalLayout() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [me, setMe] = useState<PortalMe | null>(null)
  const isAdminPreview = user?.role === 'platform_admin'

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const previewCompanyId = params.get('previewCompanyId')
    if (previewCompanyId) {
      sessionStorage.setItem('sundog_portal_preview_company_id', previewCompanyId)
    }
    api.get<PortalMe>('/portal/me').then(setMe).catch(() => {})
  }, [location.search])

  const companyName = me?.company?.name ?? 'Customer Portal'

  return (
    <div className="min-h-screen bg-slate-100 text-black">
      {isAdminPreview && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-950">
          <div className="max-w-7xl mx-auto px-4 py-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-semibold">Admin preview: customer-visible portal for {companyName}</p>
            <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-sm font-bold text-amber-900 hover:underline">
              <ArrowLeft className="w-4 h-4" />
              Back to dashboard
            </Link>
          </div>
        </div>
      )}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-12 w-44 bg-white border border-slate-200 flex items-center px-2 shrink-0">
              <img src="/servicepro-logo.png" alt="Service Pro" className="max-h-9 object-contain" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-extrabold text-black truncate">{companyName}</p>
              <p className="text-xs text-slate-600">ServicePRO Customer Portal</p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <a
              href="mailto:service@basinsafetyus.com?subject=Service%20request%20from%20ServicePRO%20portal"
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold bg-blue-700 text-white border border-blue-700 hover:bg-blue-800"
            >
              <MailPlus className="w-4 h-4" />
              Request Service
            </a>
            <NavLink
              to="/portal/account"
              className={({ isActive }) =>
                `inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold border ${
                  isActive
                    ? 'bg-blue-50 border-blue-700 text-blue-800'
                    : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-50'
                }`
              }
            >
              <UserRound className="w-4 h-4" />
              <span className="leading-tight">
                Account
                <span className="block text-[11px] font-medium text-slate-500">Password reset</span>
              </span>
            </NavLink>
            <button
              onClick={logout}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </div>

        <nav className="max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `px-3 py-3 text-sm font-semibold border-b-2 -mb-px whitespace-nowrap transition-colors ${
                  isActive
                    ? 'border-blue-700 text-blue-800'
                    : 'border-transparent text-slate-600 hover:text-black'
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-5">
        <Outlet context={{ me, companyName, user }} />
      </main>
    </div>
  )
}
