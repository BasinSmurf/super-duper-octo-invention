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

const PAGE_SIZE = 50

export function CompaniesPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'customers:manage')
  const [companies, setCompanies] = useState<Company[]>([])
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [loading, setLoading] = useState(true)
  // The list is paged: `total` is how many match, so a short page never reads
  // as "that's every customer".
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  async function addCustomer() {
    const name = newName.trim()
    if (!name) return
    setAddBusy(true)
    setAddError(null)
    try {
      const created = await api.post<{ id: string }>('/companies', { name, companyType: 'customer' })
      // Straight to the profile: that is where the rest of the setup lives.
      navigate(`/companies/${created.id}`)
    } catch (e: any) {
      setAddError(e?.message || 'Could not add the customer')
    } finally {
      setAddBusy(false)
    }
  }

  useEffect(() => {
    loadCompanies()
  }, [search, showInactive])

  function fetchPage(offset: number) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    // Default to active-only; the toggle shows all (incl. deactivated) so an
    // admin can find and reactivate a customer.
    if (!showInactive) params.set('active', 'true')
    if (search) params.set('search', search)
    return api.get<{ data: Company[]; total: number }>(`/companies?${params}`)
  }

  async function loadCompanies() {
    setLoading(true)
    try {
      const data = await fetchPage(0)
      setCompanies(data.data)
      setTotal(data.total)
    } catch {
      setCompanies([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }

  async function loadMore() {
    setLoadingMore(true)
    try {
      const data = await fetchPage(companies.length)
      // De-dupe by id: a customer added or renamed between pages can shift rows.
      setCompanies(prev => [...prev, ...data.data.filter(c => !prev.some(p => p.id === c.id))])
      setTotal(data.total)
    } catch {
      // Keep what is already shown; the button stays for a retry.
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
        {canManage && (
          <button
            onClick={() => { setAdding(a => !a); setNewName(search); setAddError(null) }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-800 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            <Plus className="w-5 h-5" />
            Add Customer
          </button>
        )}
      </div>

      {adding && (
        <form
          onSubmit={e => { e.preventDefault(); addCustomer() }}
          className="mb-4 bg-white rounded-lg border border-slate-200 p-4"
        >
          <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="new-customer-name">
            Customer name
          </label>
          <div className="flex gap-2">
            <input
              id="new-customer-name"
              autoFocus
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="flex-1 px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            <button
              type="submit"
              disabled={addBusy || !newName.trim()}
              className="px-4 py-2 bg-blue-800 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50"
            >
              {addBusy ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 font-medium"
            >
              Cancel
            </button>
          </div>
          {addError && <p className="text-sm text-red-600 mt-2">{addError}</p>}
        </form>
      )}

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
          {companies.length > 0 && (
            <div className="flex items-center justify-between pt-2 text-sm text-slate-500">
              <span>Showing {companies.length} of {Math.max(total, companies.length)} customers</span>
              {companies.length < total && (
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-medium disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, total - companies.length)} more`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
