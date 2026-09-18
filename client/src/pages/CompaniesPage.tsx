import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { CompanyMergePanel } from '@/components/CompanyMergePanel'
import { Search, Plus, Building2, ChevronRight } from 'lucide-react'

interface Company {
  id: string
  name: string
  legalName: string | null
  companyType: string
  isActive: boolean
  cashCcOnly: boolean
  creditHold: boolean
  city: string | null
  state: string | null
  _count: { billingProfiles: number; contacts: number }
}

export function CompaniesPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'customers:manage')
  const [companies, setCompanies] = useState<Company[]>([])
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadCompanies()
  }, [search, showInactive])

  async function loadCompanies() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '50' })
      // Default to active-only; the toggle shows all (incl. deactivated) so an
      // admin can find and reactivate a customer.
      if (!showInactive) params.set('active', 'true')
      if (search) params.set('search', search)
      const data = await api.get<{ data: Company[] }>(`/companies?${params}`)
      setCompanies(data.data)
    } catch {
      setCompanies([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
        <button className="flex items-center gap-2 px-4 py-2 bg-blue-800 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium">
          <Plus className="w-5 h-5" />
          Add Customer
        </button>
      </div>

      {canManage && <CompanyMergePanel onMerged={loadCompanies} />}

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customers..."
          className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-600 mb-4 cursor-pointer w-fit">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={e => setShowInactive(e.target.checked)}
          className="rounded"
        />
        Show inactive customers
      </label>

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : (
        <div className="space-y-2">
          {companies.map(co => (
            <button
              key={co.id}
              onClick={() => navigate(`/companies/${co.id}`)}
              className="w-full text-left bg-white rounded-lg border border-slate-200 p-4 hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-5 h-5 text-slate-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-900 flex items-center gap-2">
                    {co.name}
                    {co.creditHold && (
                      <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded-full font-bold">CREDIT HOLD</span>
                    )}
                    {!co.isActive && (
                      <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium">Inactive</span>
                    )}
                    {co.cashCcOnly && (
                      <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">Cash / Card only</span>
                    )}
                  </p>
                  <p className="text-sm text-slate-500">
                    {co.companyType.replace('_', ' ')}
                    {co.city && ` — ${co.city}, ${co.state}`}
                  </p>
                </div>
                <div className="text-right text-xs text-slate-400 flex-shrink-0">
                  <p>{co._count.contacts} contacts</p>
                  <p>{co._count.billingProfiles} billing profiles</p>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
