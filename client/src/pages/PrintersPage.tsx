import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { Printer as PrinterIcon, Plus, Pencil, Check, X, Zap, RotateCcw } from 'lucide-react'

interface Site {
  id: string
  name: string
  shortCode: string
}

interface Printer {
  id: string
  name: string
  siteId: string
  ipAddress: string
  port: number
  labelWidthMm: number
  labelHeightMm: number
  defaultForStation: string | null
  active: boolean
  lastSeenAt: string | null
  lastError: string | null
  site: Site
}

interface PrintJob {
  id: string
  status: string
  reason: string
  reprintReason: string | null
  copies: number
  attempts: number
  errorMessage: string | null
  createdAt: string
  printer: { name: string } | null
  shopWorkOrder: { workOrderNumber: string } | null
  shopWorkOrderItem: { serialNumber: string } | null
}

interface PrinterForm {
  name: string
  siteId: string
  ipAddress: string
  port: string
  labelWidthMm: string
  labelHeightMm: string
  defaultForStation: string
}

const EMPTY_FORM: PrinterForm = {
  name: '',
  siteId: '',
  ipAddress: '',
  port: '9100',
  labelWidthMm: '51', // 2" x 2" direct-thermal stock for the ZD411
  labelHeightMm: '51',
  defaultForStation: '',
}

const OFFLINE_AFTER_MS = 5 * 60 * 1000

function printerOnline(p: Printer): boolean {
  return p.lastSeenAt != null && Date.now() - new Date(p.lastSeenAt).getTime() < OFFLINE_AFTER_MS
}

export function PrintersPage() {
  const [printers, setPrinters] = useState<Printer[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [failures, setFailures] = useState<PrintJob[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createForm, setCreateForm] = useState<PrinterForm>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<PrinterForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'system:config')

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [printerRes, siteRes, failureRes] = await Promise.all([
        api.get<{ data: Printer[] }>('/printers'),
        api.get<{ data: Site[] }>('/sites?active=true'),
        api.get<{ data: PrintJob[] }>('/print-jobs?status=FAILED&hours=24'),
      ])
      setPrinters(printerRes.data)
      setSites(siteRes.data)
      setFailures(failureRes.data)
    } catch {
      setPrinters([])
    } finally {
      setLoading(false)
    }
  }

  function formToPayload(f: PrinterForm) {
    return {
      name: f.name,
      siteId: f.siteId,
      ipAddress: f.ipAddress,
      port: parseInt(f.port, 10) || 9100,
      labelWidthMm: parseInt(f.labelWidthMm, 10) || 0,
      labelHeightMm: parseInt(f.labelHeightMm, 10) || 0,
      defaultForStation: f.defaultForStation || null,
    }
  }

  async function handleCreate() {
    if (!createForm.name.trim() || !createForm.siteId || !createForm.ipAddress.trim()) {
      setError('Name, site, and IP address are required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.post('/printers', formToPayload(createForm))
      setCreating(false)
      setCreateForm(EMPTY_FORM)
      loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(p: Printer) {
    setEditingId(p.id)
    setEditForm({
      name: p.name,
      siteId: p.siteId,
      ipAddress: p.ipAddress,
      port: String(p.port),
      labelWidthMm: String(p.labelWidthMm),
      labelHeightMm: String(p.labelHeightMm),
      defaultForStation: p.defaultForStation || '',
    })
    setError(null)
  }

  async function saveEdit() {
    if (!editingId) return
    setBusy(true)
    setError(null)
    try {
      await api.put(`/printers/${editingId}`, formToPayload(editForm))
      setEditingId(null)
      loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(p: Printer) {
    setBusy(true)
    setError(null)
    try {
      await api.put(`/printers/${p.id}`, { active: !p.active })
      loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  async function testPrint(p: Printer) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.post(`/printers/${p.id}/test`)
      setNotice(`Test label sent to ${p.name}`)
      loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test print failed')
    } finally {
      setBusy(false)
    }
  }

  async function retryJob(jobId: string) {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/print-jobs/${jobId}/retry`)
      setFailures(prev => prev.filter(j => j.id !== jobId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Printers</h1>
          {!loading && <p className="text-sm text-slate-500">{printers.length} label printers</p>}
        </div>
        {canManage && !creating && (
          <button
            onClick={() => {
              setCreating(true)
              setCreateForm({ ...EMPTY_FORM, siteId: sites[0]?.id || '' })
              setError(null)
            }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            Add Printer
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700 flex items-start gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 leading-none">&times;</button>
        </div>
      )}
      {notice && (
        <div className="mb-4 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-700 flex items-start gap-2">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-emerald-400 hover:text-emerald-600 leading-none">&times;</button>
        </div>
      )}

      {creating && (
        <div className="mb-4 bg-white rounded-lg border border-blue-200 p-4">
          <p className="font-medium text-slate-900 mb-3">New Printer</p>
          <PrinterFields form={createForm} onChange={setCreateForm} sites={sites} />
          <div className="flex justify-end gap-2 mt-3">
            <button onClick={() => { setCreating(false); setError(null) }} className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900">
              Cancel
            </button>
            <button onClick={handleCreate} disabled={busy} className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {busy ? 'Saving...' : 'Create Printer'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : printers.length === 0 ? (
        <div className="text-center py-12 text-slate-400">No printers configured</div>
      ) : (
        <div className="space-y-2">
          {printers.map(p => {
            const isEditing = editingId === p.id
            const online = printerOnline(p)
            return (
              <div key={p.id} className={`bg-white rounded-lg border p-4 ${p.active ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
                {isEditing ? (
                  <div>
                    <PrinterFields form={editForm} onChange={setEditForm} sites={sites} />
                    <div className="flex justify-end gap-2 mt-3">
                      <button onClick={() => { setEditingId(null); setError(null) }} className="p-1.5 text-slate-400 hover:text-slate-600 rounded">
                        <X className="w-4 h-4" />
                      </button>
                      <button onClick={saveEdit} disabled={busy} className="p-1.5 text-green-600 hover:text-green-800 rounded disabled:opacity-50">
                        <Check className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                      <PrinterIcon className="w-5 h-5 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-slate-900">{p.name}</p>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${
                            !p.active ? 'bg-slate-200 text-slate-600'
                              : online ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-red-100 text-red-700'
                          }`}
                          title={p.lastError || ''}
                        >
                          {!p.active ? 'Inactive' : online ? 'Online' : 'Offline'}
                        </span>
                        {p.defaultForStation && (
                          <span className="text-xs bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded">
                            default: {p.defaultForStation}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-sm text-slate-500 flex-wrap">
                        <span className="font-mono text-xs">{p.ipAddress}:{p.port}</span>
                        <span>{p.site.name}</span>
                        <span className="text-xs text-slate-400">{p.labelWidthMm}×{p.labelHeightMm}mm</span>
                      </div>
                      {p.lastError && !online && (
                        <p className="text-xs text-red-500 mt-0.5 truncate">{p.lastError}</p>
                      )}
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => testPrint(p)} disabled={busy} className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                          <Zap className="w-3 h-3" /> Test
                        </button>
                        <button onClick={() => toggleActive(p)} disabled={busy} className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                          {p.active ? 'Disable' : 'Enable'}
                        </button>
                        <button onClick={() => startEdit(p)} className="p-1.5 text-slate-400 hover:text-blue-600 rounded">
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

      {/* Recent print failures (last 24h) */}
      {!loading && failures.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Print failures · last 24h</h2>
          <div className="space-y-2">
            {failures.map(j => (
              <div key={j.id} className="bg-white rounded-lg border border-red-200 p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900">
                    {j.shopWorkOrder?.workOrderNumber || 'Work order'}
                    {j.shopWorkOrderItem && <span className="text-slate-500"> · S/N {j.shopWorkOrderItem.serialNumber}</span>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {j.printer?.name || 'Printer'} · {j.reason}
                    {j.errorMessage && <span className="text-red-500"> · {j.errorMessage}</span>}
                  </p>
                </div>
                {canManage && (
                  <button onClick={() => retryJob(j.id)} disabled={busy} className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                    <RotateCcw className="w-3 h-3" /> Retry
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PrinterFields({
  form,
  onChange,
  sites,
}: {
  form: PrinterForm
  onChange: (f: PrinterForm) => void
  sites: Site[]
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Name</label>
        <input
          type="text"
          value={form.name}
          onChange={e => onChange({ ...form, name: e.target.value })}
          placeholder="Intake bench"
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Site</label>
        <select
          value={form.siteId}
          onChange={e => onChange({ ...form, siteId: e.target.value })}
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">Select site…</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">IP Address</label>
        <input
          type="text"
          value={form.ipAddress}
          onChange={e => onChange({ ...form, ipAddress: e.target.value })}
          placeholder="10.0.0.50"
          className="w-full px-2 py-1.5 text-sm font-mono border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Port</label>
        <input
          type="number"
          value={form.port}
          onChange={e => onChange({ ...form, port: e.target.value })}
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Label Width (mm)</label>
        <input
          type="number"
          value={form.labelWidthMm}
          onChange={e => onChange({ ...form, labelWidthMm: e.target.value })}
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Label Height (mm)</label>
        <input
          type="number"
          value={form.labelHeightMm}
          onChange={e => onChange({ ...form, labelHeightMm: e.target.value })}
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="text-[10px] font-medium text-slate-500 block mb-1">Default for Station</label>
        <select
          value={form.defaultForStation}
          onChange={e => onChange({ ...form, defaultForStation: e.target.value })}
          className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">None</option>
          <option value="intake">Intake</option>
          <option value="qc">QC</option>
        </select>
      </div>
    </div>
  )
}
