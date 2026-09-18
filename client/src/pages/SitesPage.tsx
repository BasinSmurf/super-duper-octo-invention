import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { Warehouse, Plus, Pencil, Check, X } from 'lucide-react'

interface Site {
  id: string
  name: string
  shortCode: string
  address: string | null
  timezone: string
  active: boolean
  salesTaxJurisdictionId: string | null
}

interface SiteForm {
  name: string
  shortCode: string
  address: string
  timezone: string
  salesTaxJurisdictionId: string
}

interface TaxRate {
  id: string
  name: string
}

const TIMEZONES = [
  'America/Chicago',
  'America/Denver',
  'America/New_York',
  'America/Los_Angeles',
]

const EMPTY_FORM: SiteForm = { name: '', shortCode: '', address: '', timezone: 'America/Chicago', salesTaxJurisdictionId: '' }

export function SitesPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createForm, setCreateForm] = useState<SiteForm>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<SiteForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'system:config')

  useEffect(() => {
    loadSites()
    api.get<{ data: TaxRate[] }>('/sales-tax-rates?activeOnly=1')
      .then(res => setTaxRates(res.data))
      .catch(() => { /* dropdown just won't populate */ })
  }, [])

  async function loadSites() {
    setLoading(true)
    try {
      const data = await api.get<{ data: Site[] }>('/sites')
      setSites(data.data)
    } catch {
      setSites([])
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate() {
    if (!createForm.name.trim() || !createForm.shortCode.trim()) {
      setError('Name and short code are required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.post('/sites', createForm)
      setCreating(false)
      setCreateForm(EMPTY_FORM)
      loadSites()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  function startEdit(site: Site) {
    setEditingId(site.id)
    setEditForm({
      name: site.name,
      shortCode: site.shortCode,
      address: site.address || '',
      timezone: site.timezone,
      salesTaxJurisdictionId: site.salesTaxJurisdictionId || '',
    })
    setError(null)
  }

  async function saveEdit() {
    if (!editingId) return
    if (!editForm.name.trim() || !editForm.shortCode.trim()) {
      setError('Name and short code are required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.put(`/sites/${editingId}`, editForm)
      setEditingId(null)
      loadSites()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(site: Site) {
    setSaving(true)
    setError(null)
    try {
      await api.put(`/sites/${site.id}`, { active: !site.active })
      loadSites()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Sites</h1>
          {!loading && (
            <p className="text-sm text-slate-500">
              {sites.length} site{sites.length === 1 ? '' : 's'} · Basin Safety physical service locations
            </p>
          )}
        </div>
        {canManage && !creating && (
          <button
            onClick={() => {
              setCreating(true)
              setCreateForm(EMPTY_FORM)
              setError(null)
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Add Site
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700 flex items-start gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 leading-none">
            &times;
          </button>
        </div>
      )}

      {creating && (
        <div className="mb-4 bg-white rounded-lg border border-blue-200 p-4">
          <p className="font-medium text-slate-900 mb-3">New Site</p>
          <SiteFields form={createForm} onChange={setCreateForm} taxRates={taxRates} />
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={() => {
                setCreating(false)
                setError(null)
              }}
              className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={saving}
              className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Create Site'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : sites.length === 0 ? (
        <div className="text-center py-12 text-slate-400">No sites yet</div>
      ) : (
        <div className="space-y-2">
          {sites.map(site => {
            const isEditing = editingId === site.id
            return (
              <div
                key={site.id}
                className={`bg-white rounded-lg border p-4 ${site.active ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}
              >
                {isEditing ? (
                  <div>
                    <SiteFields form={editForm} onChange={setEditForm} taxRates={taxRates} />
                    <div className="flex justify-end gap-2 mt-3">
                      <button
                        onClick={() => {
                          setEditingId(null)
                          setError(null)
                        }}
                        className="p-1.5 text-slate-400 hover:text-slate-600 rounded"
                      >
                        <X className="w-4 h-4" />
                      </button>
                      <button
                        onClick={saveEdit}
                        disabled={saving}
                        className="p-1.5 text-green-600 hover:text-green-800 rounded disabled:opacity-50"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                      <Warehouse className="w-5 h-5 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-slate-900">{site.name}</p>
                        <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">{site.shortCode}</span>
                        {!site.active && (
                          <span className="text-xs bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded">Inactive</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-sm text-slate-500 flex-wrap">
                        {site.address && <span>{site.address}</span>}
                        <span className="text-xs text-slate-400">{site.timezone}</span>
                        <span className="text-xs text-slate-400">
                          · Tax: {taxRates.find(r => r.id === site.salesTaxJurisdictionId)?.name || 'ND state (default)'}
                        </span>
                      </div>
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => toggleActive(site)}
                          disabled={saving}
                          className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {site.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                        <button
                          onClick={() => startEdit(site)}
                          className="p-1.5 text-slate-400 hover:text-blue-600 rounded"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SiteFields({ form, onChange, taxRates }: { form: SiteForm; onChange: (f: SiteForm) => void; taxRates: TaxRate[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Name</label>
        <input
          type="text"
          value={form.name}
          onChange={e => onChange({ ...form, name: e.target.value })}
          placeholder="Williston"
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Short Code</label>
        <input
          type="text"
          value={form.shortCode}
          onChange={e => onChange({ ...form, shortCode: e.target.value.toUpperCase() })}
          placeholder="WIL"
          maxLength={8}
          className="w-full px-2 py-1.5 text-sm font-mono border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Address</label>
        <input
          type="text"
          value={form.address}
          onChange={e => onChange({ ...form, address: e.target.value })}
          placeholder="Optional"
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Timezone</label>
        <select
          value={form.timezone}
          onChange={e => onChange({ ...form, timezone: e.target.value })}
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        >
          {TIMEZONES.map(tz => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Sales Tax Jurisdiction (shop work orders)</label>
        <select
          value={form.salesTaxJurisdictionId}
          onChange={e => onChange({ ...form, salesTaxJurisdictionId: e.target.value })}
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">ND state rate (default)</option>
          {taxRates.map(r => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <p className="text-[10px] text-slate-400 mt-0.5">Shop WO invoices from this shop default to this rate (e.g. Dickinson → Stark, Williston → Williston).</p>
      </div>
    </div>
  )
}
