import { useState, useEffect, useRef } from 'react'
import { db } from '@/lib/db'
import { api } from '@/lib/api'
import { Search, Building2, Clock, HardDrive, UserPlus, Loader2 } from 'lucide-react'

interface Company {
  id: string
  name: string
  companyType: string
  city: string | null
  state: string | null
  cashCcOnly?: boolean
  creditHold?: boolean
  assignedFieldNames?: string[]
}

interface CustomerSearchProps {
  value: Company | null
  onChange: (company: Company | null) => void
}

const RECENT_KEY = 'sundog_recent_customers'
const MAX_RECENT = 5

function getRecentCustomers(): Company[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
  } catch {
    return []
  }
}

function addRecentCustomer(company: Company) {
  const recent = getRecentCustomers().filter(c => c.id !== company.id)
  recent.unshift(company)
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)))
}

/**
 * Search Dexie first (instant, offline), then API fallback.
 */
async function searchCompanies(query: string): Promise<{ results: Company[]; source: 'local' | 'api' }> {
  const q = query.toLowerCase()

  // 1. Search Dexie
  try {
    const localResults = await db.companies
      .filter(c =>
        c.isActive &&
        c.name.toLowerCase().includes(q)
      )
      .limit(10)
      .toArray()

    if (localResults.length > 0) {
      // Derive assigned field names from pads in Dexie — keeps lookup card
      // informative when we hit offline-first results.
      const companyIds = localResults.map(c => c.id)
      const fieldsByCompany = new Map<string, string[]>()
      try {
        const pads = await db.pads
          .filter(p => !!p.currentOperatorId && companyIds.includes(p.currentOperatorId!))
          .toArray()
        const fieldIds = Array.from(new Set(pads.map(p => p.fieldId).filter(Boolean)))
        const fields = await db.fields.where('id').anyOf(fieldIds).toArray()
        const fieldNameById = new Map(fields.map(f => [f.id, f.name]))
        for (const p of pads) {
          if (!p.currentOperatorId) continue
          const name = fieldNameById.get(p.fieldId)
          if (!name) continue
          const list = fieldsByCompany.get(p.currentOperatorId) ?? []
          if (!list.includes(name)) list.push(name)
          fieldsByCompany.set(p.currentOperatorId, list)
        }
      } catch {
        // Non-critical — just skip field enrichment
      }
      return {
        results: localResults.map(c => ({
          id: c.id,
          name: c.name,
          companyType: c.companyType,
          city: c.city ?? null,
          state: c.state ?? null,
          cashCcOnly: c.cashCcOnly ?? false,
          creditHold: c.creditHold ?? false,
          assignedFieldNames: (fieldsByCompany.get(c.id) ?? []).sort(),
        })),
        source: 'local',
      }
    }
  } catch {
    // Fall through to API
  }

  // 2. API fallback
  try {
    const params = new URLSearchParams({ search: query, limit: '10', active: 'true' })
    const data = await api.get<{ data: Company[] }>(`/companies?${params}`)
    return { results: data.data, source: 'api' }
  } catch {
    return { results: [], source: 'api' }
  }
}

interface WalkInForm {
  name: string
  phone: string
  email: string
  contactName: string
}

export function CustomerSearch({ value, onChange }: CustomerSearchProps) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Company[]>([])
  const [source, setSource] = useState<'local' | 'api'>('local')
  const [recent] = useState(getRecentCustomers)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Walk-in customer form state
  const [showWalkIn, setShowWalkIn] = useState(false)
  const [walkInForm, setWalkInForm] = useState<WalkInForm>({ name: '', phone: '', email: '', contactName: '' })
  const [walkInSubmitting, setWalkInSubmitting] = useState(false)
  const [walkInError, setWalkInError] = useState('')

  useEffect(() => {
    if (!search) {
      setResults([])
      return
    }
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const { results: r, source: s } = await searchCompanies(search)
        setResults(r)
        setSource(s)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 150)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setShowWalkIn(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function select(company: Company) {
    addRecentCustomer(company)
    onChange(company)
    setSearch('')
    setOpen(false)
    setShowWalkIn(false)
  }

  function openWalkInForm() {
    setShowWalkIn(true)
    setWalkInForm({ name: search, phone: '', email: '', contactName: '' })
    setWalkInError('')
  }

  async function submitWalkIn() {
    if (!walkInForm.name.trim()) {
      setWalkInError('Company name is required')
      return
    }

    setWalkInSubmitting(true)
    setWalkInError('')

    try {
      const created = await api.post<Company>('/companies/quick-create', {
        name: walkInForm.name.trim(),
        phone: walkInForm.phone.trim() || undefined,
        email: walkInForm.email.trim() || undefined,
        contactName: walkInForm.contactName.trim() || undefined,
      })

      // Add to local Dexie DB so it works offline going forward
      try {
        await db.companies.put({
          id: created.id,
          name: created.name,
          companyType: created.companyType,
          isActive: true,
          phone: (created as any).phone ?? null,
          email: (created as any).email ?? null,
          updatedAt: new Date().toISOString(),
        })
      } catch {
        // Non-critical — will sync on next pull
      }

      select(created)
    } catch (err: any) {
      setWalkInError(err.message || 'Failed to create customer')
    } finally {
      setWalkInSubmitting(false)
    }
  }

  // Show the dropdown when there's a search with results OR loading, or when showing recents, or when walk-in form is open
  const showList = open && (search ? results.length > 0 || loading || showWalkIn : recent.length > 0)
  // Always show the "add walk-in" button when searching (even with results), unless form is already open
  const showWalkInButton = open && search.length >= 2 && !loading && !showWalkIn

  return (
    <div ref={ref} className="relative">
      <label className="block text-sm font-medium text-slate-700 mb-1">Customer</label>
      {value ? (
        <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <Building2 className="w-5 h-5 text-blue-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-slate-900">{value.name}</p>
            <p className="text-sm text-slate-500">{value.companyType.replace('_', ' ')}</p>
            {value.creditHold && (
              <span className="inline-flex items-center gap-1 mt-1 mr-1 text-xs font-bold bg-red-600 text-white px-1.5 py-0.5 rounded">
                CREDIT HOLD
              </span>
            )}
            {value.cashCcOnly && (
              <span className="inline-flex items-center gap-1 mt-1 text-xs font-medium bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                Cash / Card only
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={e => { setSearch(e.target.value); setOpen(true); setShowWalkIn(false) }}
              onFocus={() => setOpen(true)}
              placeholder="Search customers..."
              className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-base"
            />
          </div>

          {(showList || showWalkInButton) && (
            <div className="absolute z-20 left-0 right-0 mt-1 bg-white rounded-lg border border-slate-200 shadow-lg max-h-80 overflow-y-auto">
              {!search && recent.length > 0 && (
                <>
                  <div className="px-3 py-2 text-xs font-semibold text-slate-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" /> Recent
                  </div>
                  {recent.map(co => (
                    <button
                      key={co.id}
                      type="button"
                      onClick={() => select(co)}
                      className="w-full text-left px-3 py-3 hover:bg-slate-50 flex items-center gap-3 transition-colors"
                    >
                      <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
                      <div>
                        <p className="font-medium text-slate-900 text-sm">{co.name}</p>
                        <p className="text-xs text-slate-500">{co.city && `${co.city}, ${co.state}`}</p>
                      </div>
                    </button>
                  ))}
                </>
              )}
              {search && loading && (
                <div className="px-3 py-4 text-center text-sm text-slate-400">Searching...</div>
              )}
              {search && !loading && results.length > 0 && !showWalkIn && (
                <>
                  {source === 'local' && (
                    <div className="px-3 py-1 text-[10px] text-slate-400 flex items-center gap-1 border-b border-slate-100">
                      <HardDrive className="w-2.5 h-2.5" /> Offline results
                    </div>
                  )}
                  {results.map(co => (
                    <button
                      key={co.id}
                      type="button"
                      onClick={() => select(co)}
                      className="w-full text-left px-3 py-3 hover:bg-slate-50 flex items-start gap-3 transition-colors"
                    >
                      <Building2 className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-slate-900 text-sm flex items-center gap-1.5">
                          {co.name}
                          {co.creditHold && (
                            <span className="inline-flex items-center text-[10px] font-bold bg-red-600 text-white px-1.5 py-0.5 rounded">
                              CREDIT HOLD
                            </span>
                          )}
                          {co.cashCcOnly && (
                            <span className="inline-flex items-center text-[10px] font-medium bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                              Cash / Card
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-500">
                          {co.companyType.replace('_', ' ')}
                          {co.city && ` — ${co.city}, ${co.state}`}
                        </p>
                        {co.assignedFieldNames && co.assignedFieldNames.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {co.assignedFieldNames.slice(0, 4).map(f => (
                              <span key={f} className="px-1.5 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-600 rounded">
                                {f}
                              </span>
                            ))}
                            {co.assignedFieldNames.length > 4 && (
                              <span className="text-[10px] text-slate-400 self-center">+{co.assignedFieldNames.length - 4} more</span>
                            )}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </>
              )}
              {search && !loading && results.length === 0 && !showWalkIn && (
                <div className="px-3 py-4 text-center text-sm text-slate-400">No customers found</div>
              )}

              {/* Walk-in customer form */}
              {showWalkIn && (
                <div className="p-3 border-t border-slate-100">
                  <div className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
                    <UserPlus className="w-4 h-4 text-green-600" />
                    Add Walk-In Customer
                  </div>
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={walkInForm.name}
                      onChange={e => setWalkInForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Company / Customer Name *"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                      autoFocus
                    />
                    <input
                      type="text"
                      value={walkInForm.contactName}
                      onChange={e => setWalkInForm(f => ({ ...f, contactName: e.target.value }))}
                      placeholder="Contact Name (optional)"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                    />
                    <input
                      type="tel"
                      value={walkInForm.phone}
                      onChange={e => setWalkInForm(f => ({ ...f, phone: e.target.value }))}
                      placeholder="Phone (optional)"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                    />
                    <input
                      type="email"
                      value={walkInForm.email}
                      onChange={e => setWalkInForm(f => ({ ...f, email: e.target.value }))}
                      placeholder="Email (optional)"
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                    />
                    {walkInError && (
                      <p className="text-xs text-red-600">{walkInError}</p>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={submitWalkIn}
                        disabled={walkInSubmitting || !walkInForm.name.trim()}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-green-600 text-white text-sm font-medium rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {walkInSubmitting ? (
                          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating...</>
                        ) : (
                          <><UserPlus className="w-3.5 h-3.5" /> Create Customer</>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowWalkIn(false)}
                        className="px-3 py-2 text-sm text-slate-600 hover:text-slate-800 border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Add Walk-In button — shown when searching and form is not open */}
              {showWalkInButton && (
                <button
                  type="button"
                  onClick={openWalkInForm}
                  className="w-full text-left px-3 py-3 hover:bg-green-50 flex items-center gap-3 transition-colors border-t border-slate-100 text-green-700"
                >
                  <UserPlus className="w-4 h-4 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">+ Add Walk-In Customer</p>
                    <p className="text-xs text-slate-500">Create "{search}" as a new cash customer</p>
                  </div>
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
