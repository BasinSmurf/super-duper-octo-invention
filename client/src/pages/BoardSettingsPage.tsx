import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { SlidersHorizontal, Palette, RotateCcw } from 'lucide-react'
import {
  THEMEABLE_COLUMNS,
  DEFAULT_STAGE_COLORS,
  resolveColumnColors,
  stageStyle,
  type ColumnColors,
} from '@/lib/boardTheme'

// Order + labels for the editable ShopItemStatus aging thresholds.
const STATUS_ROWS: Array<{ key: string; label: string }> = [
  { key: 'received', label: 'Received' },
  { key: 'diagnosing', label: 'Diagnosing' },
  { key: 'awaiting_approval', label: 'Awaiting Approval' },
  { key: 'awaiting_parts', label: 'Awaiting Parts' },
  { key: 'warranty_out', label: 'Warranty Out' },
  { key: 'outside_service', label: 'Outside Service' },
  { key: 'in_work', label: 'In Work' },
  { key: 'qc_testing', label: 'QC Testing' },
  { key: 'on_hold', label: 'On Hold (generic)' },
  { key: 'shop_complete', label: 'Shop Complete' },
]

// Fallback hue when toggling "tinted" on for a column whose default is neutral.
const TINT_ON_FALLBACK = '#64748b'

interface BoardConfigResponse {
  agingThresholds: Record<string, number>
  defaults: Record<string, number>
  columnColors?: ColumnColors
}

export function BoardSettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [defaults, setDefaults] = useState<Record<string, number>>({})
  const [colors, setColors] = useState<ColumnColors>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'system:config')

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const cfg = await api.get<BoardConfigResponse>('/board-config')
      const next: Record<string, string> = {}
      for (const row of STATUS_ROWS) {
        next[row.key] = String(cfg.agingThresholds[row.key] ?? cfg.defaults[row.key] ?? '')
      }
      setValues(next)
      setDefaults(cfg.defaults)
      setColors(resolveColumnColors(cfg.columnColors))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load board config')
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const agingThresholds: Record<string, number> = {}
      for (const row of STATUS_ROWS) {
        const n = parseInt(values[row.key], 10)
        if (Number.isFinite(n) && n > 0) agingThresholds[row.key] = n
      }
      // Only send the themeable columns; null = neutral (no tint).
      const columnColors: ColumnColors = {}
      for (const col of THEMEABLE_COLUMNS) columnColors[col.key] = colors[col.key] ?? null
      await api.put('/board-config', { agingThresholds, columnColors })
      setNotice('Board settings saved')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function setColor(key: string, value: string | null) {
    setColors(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="max-w-xl">
      <div className="flex items-center gap-2 mb-1">
        <SlidersHorizontal className="w-5 h-5 text-slate-500" />
        <h1 className="text-2xl font-bold text-slate-900">Board Settings</h1>
      </div>
      <p className="text-sm text-slate-500 mb-6">
        Tune the shop board: aging thresholds and per-column colors. Changes apply to every
        wall display and kiosk on their next refresh.
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">{error}</div>
      )}
      {notice && (
        <div className="mb-4 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-700">{notice}</div>
      )}

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : (
        <>
          {/* ---- Column colors ---- */}
          <div className="flex items-center gap-2 mb-2">
            <Palette className="w-4 h-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-700">Column Colors</h2>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100 mb-8">
            {THEMEABLE_COLUMNS.map(col => {
              const value = colors[col.key] ?? null
              const tinted = value !== null
              const def = DEFAULT_STAGE_COLORS[col.key] ?? null
              const isDefault = value === def
              return (
                <div key={col.key} className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <ColumnSwatch colKey={col.key} colors={colors} />
                    <p className="text-sm font-medium text-slate-800 truncate">{col.title}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={tinted}
                        disabled={!canManage}
                        onChange={e => setColor(col.key, e.target.checked ? (def ?? TINT_ON_FALLBACK) : null)}
                        className="w-3.5 h-3.5 accent-blue-600"
                      />
                      Tinted
                    </label>
                    <input
                      type="color"
                      value={value ?? def ?? TINT_ON_FALLBACK}
                      disabled={!canManage || !tinted}
                      onChange={e => setColor(col.key, e.target.value)}
                      className="w-9 h-8 rounded border border-slate-300 bg-white p-0.5 disabled:opacity-40 cursor-pointer"
                      title={tinted ? (value ?? '') : 'Neutral (no tint)'}
                    />
                    <input
                      type="text"
                      value={tinted ? (value ?? '') : ''}
                      placeholder="neutral"
                      disabled={!canManage || !tinted}
                      onChange={e => {
                        const v = e.target.value.trim()
                        if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(col.key, v.toLowerCase())
                        else if (v === '') setColor(col.key, null)
                        else setColor(col.key, v) // keep raw text while typing; validated on blur/save
                      }}
                      className="w-24 px-2 py-1.5 text-xs font-mono text-slate-700 border border-slate-300 rounded disabled:bg-slate-50 disabled:text-slate-300"
                    />
                    <button
                      type="button"
                      disabled={!canManage || isDefault}
                      onClick={() => setColor(col.key, def)}
                      title="Reset to default"
                      className="text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* ---- Aging thresholds ---- */}
          <div className="flex items-center gap-2 mb-2">
            <SlidersHorizontal className="w-4 h-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-700">Aging Thresholds</h2>
          </div>
          <p className="text-[11px] text-slate-400 mb-2">
            Hours a job can sit in a stage before it is flagged as aging.
            {' '}Since WI-02 this no longer paints a pill on the service board -- age
            moved to the Shop Aging dashboard widgets, which measure in days and
            ignore these thresholds. The flag still rides on the board API
            response for other consumers.
          </p>
          <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
            {STATUS_ROWS.map(row => (
              <div key={row.key} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium text-slate-800">{row.label}</p>
                  <p className="text-[11px] text-slate-400">default {defaults[row.key]}h</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="1"
                    value={values[row.key] ?? ''}
                    disabled={!canManage}
                    onChange={e => setValues({ ...values, [row.key]: e.target.value })}
                    className="w-20 px-2 py-1.5 text-sm text-right border border-slate-300 rounded disabled:bg-slate-50"
                  />
                  <span className="text-xs text-slate-400 w-8">hrs</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {canManage && !loading && (
        <div className="mt-4 flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      )}
    </div>
  )
}

/** A miniature preview of how the column header + body wash will render. */
function ColumnSwatch({ colKey, colors }: { colKey: string; colors: ColumnColors }) {
  const theme = stageStyle(colKey, colors)
  return (
    <div
      className="w-8 h-8 rounded-md border overflow-hidden shrink-0 bg-[#181310] border-white/10"
      style={theme?.column}
    >
      <div className="h-3 w-full" style={theme?.header ?? { backgroundColor: 'rgba(255,255,255,0.06)' }} />
    </div>
  )
}
