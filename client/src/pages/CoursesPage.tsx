/**
 * CoursesPage — ClassPRO training course catalog admin.
 *
 * Source of truth for course definitions (the training wizard's picker and
 * the invoice/cert-push course maps all read from this catalog). Courses are
 * deactivated, never deleted, so historical roster records keep resolving.
 */
import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { cn } from '@/lib/cn'
import { GraduationCap, Plus, Pencil, Loader2, X, CreditCard, Award } from 'lucide-react'

interface Course {
  id: string
  code: string
  name: string
  durationHours: number | null
  validityMonths: number | null
  passingScore: number | null
  vaultProClassCode: string | null
  cardsOnSite: boolean
  qbPartNumber: string | null
  bookVersion: string | null
  testVersion: string | null
  standard: string | null
  description: string | null
  sortOrder: number
  isActive: boolean
}

type CourseForm = {
  code: string
  name: string
  durationHours: string
  validityMonths: string
  passingScore: string
  vaultProClassCode: string
  cardsOnSite: boolean
  qbPartNumber: string
  bookVersion: string
  testVersion: string
  standard: string
  description: string
  sortOrder: string
  isActive: boolean
}

const EMPTY_FORM: CourseForm = {
  code: '', name: '', durationHours: '', validityMonths: '', passingScore: '',
  vaultProClassCode: '', cardsOnSite: false, qbPartNumber: '', bookVersion: '',
  testVersion: '', standard: '', description: '', sortOrder: '0', isActive: true,
}

function toForm(c: Course): CourseForm {
  return {
    code: c.code,
    name: c.name,
    durationHours: c.durationHours != null ? String(c.durationHours) : '',
    validityMonths: c.validityMonths != null ? String(c.validityMonths) : '',
    passingScore: c.passingScore != null ? String(c.passingScore) : '',
    vaultProClassCode: c.vaultProClassCode ?? '',
    cardsOnSite: c.cardsOnSite,
    qbPartNumber: c.qbPartNumber ?? '',
    bookVersion: c.bookVersion ?? '',
    testVersion: c.testVersion ?? '',
    standard: c.standard ?? '',
    description: c.description ?? '',
    sortOrder: String(c.sortOrder),
    isActive: c.isActive,
  }
}

function numOrNull(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return isNaN(n) ? null : n
}

function toPayload(f: CourseForm) {
  return {
    code: f.code.trim(),
    name: f.name.trim(),
    durationHours: numOrNull(f.durationHours),
    validityMonths: numOrNull(f.validityMonths),
    passingScore: numOrNull(f.passingScore),
    vaultProClassCode: f.vaultProClassCode.trim() || null,
    cardsOnSite: f.cardsOnSite,
    qbPartNumber: f.qbPartNumber.trim() || null,
    bookVersion: f.bookVersion.trim() || null,
    testVersion: f.testVersion.trim() || null,
    standard: f.standard.trim() || null,
    description: f.description.trim() || null,
    sortOrder: numOrNull(f.sortOrder) ?? 0,
    isActive: f.isActive,
  }
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

export function CoursesPage() {
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'training:courses')

  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Edit / create dialog
  const [editing, setEditing] = useState<Course | null>(null) // null + showDialog = create
  const [showDialog, setShowDialog] = useState(false)
  const [form, setForm] = useState<CourseForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ courses: Course[] }>('/classpro/courses')
      setCourses(res.courses)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load courses')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setSaveError(null)
    setShowDialog(true)
  }

  function openEdit(c: Course) {
    setEditing(c)
    setForm(toForm(c))
    setSaveError(null)
    setShowDialog(true)
  }

  function set<K extends keyof CourseForm>(key: K, value: CourseForm[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  async function save() {
    if (!form.name.trim()) { setSaveError('Name is required'); return }
    if (!editing && !form.code.trim()) { setSaveError('Code is required'); return }
    setSaving(true)
    setSaveError(null)
    try {
      if (editing) {
        await api.put(`/classpro/courses/${editing.id}`, toPayload(form))
      } else {
        await api.post('/classpro/courses', toPayload(form))
      }
      setShowDialog(false)
      await load()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save course')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    )
  }

  const active = courses.filter(c => c.isActive)
  const retired = courses.filter(c => !c.isActive)

  return (
    <div className="max-w-5xl mx-auto pb-12">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <GraduationCap className="w-6 h-6 text-blue-600" />
          Course Catalog
        </h1>
        {canManage && (
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" /> Add Course
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-5">
        Training course definitions. The ticket wizard's course picker, invoice line pricing
        (QB item) and the VaultPRO cert push all read from this catalog. Retire a course
        instead of deleting it — old roster records keep the course they were trained under.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      )}

      <CourseTable courses={active} canManage={canManage} onEdit={openEdit} />

      {retired.length > 0 && (
        <>
          <h2 className="mt-8 mb-2 text-sm font-semibold text-slate-500">Retired</h2>
          <CourseTable courses={retired} canManage={canManage} onEdit={openEdit} retired />
        </>
      )}

      {courses.length === 0 && (
        <div className="border-2 border-dashed border-slate-200 rounded-lg p-10 text-center text-sm text-slate-400">
          No courses yet. {canManage ? 'Add the first one.' : ''}
        </div>
      )}

      {/* Edit / create dialog */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && setShowDialog(false)}>
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white rounded-t-xl">
              <h2 className="font-semibold text-slate-900">{editing ? `Edit — ${editing.name}` : 'New Course'}</h2>
              <button onClick={() => setShowDialog(false)} className="p-1 text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Name *">
                <input className={inputCls} value={form.name} onChange={e => set('name', e.target.value)} placeholder="H2S CLEAR" />
              </Field>
              <Field label="Code *" hint={editing ? 'Code is fixed after creation.' : 'Lowercase slug, e.g. h2s_clear.'}>
                <input
                  className={cn(inputCls, editing && 'bg-slate-50 text-slate-400')}
                  value={form.code}
                  disabled={!!editing}
                  onChange={e => set('code', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                  placeholder="h2s_clear"
                />
              </Field>

              <Field label="Duration (hours)">
                <input className={inputCls} type="number" step="0.5" min="0" value={form.durationHours} onChange={e => set('durationHours', e.target.value)} />
              </Field>
              <Field label="Validity (months)" hint="Blank = does not expire / unknown.">
                <input className={inputCls} type="number" min="0" value={form.validityMonths} onChange={e => set('validityMonths', e.target.value)} />
              </Field>

              <Field label="Passing score (%)" hint="Default — overridable per student.">
                <input className={inputCls} type="number" min="0" max="100" value={form.passingScore} onChange={e => set('passingScore', e.target.value)} />
              </Field>
              <Field label="Regulatory standard">
                <input className={inputCls} value={form.standard} onChange={e => set('standard', e.target.value)} placeholder="OSHA 1910.146" />
              </Field>

              <Field label="QB item (part number)" hint="Billing item for invoice lines. Blank falls back to Misc.">
                <input className={inputCls} value={form.qbPartNumber} onChange={e => set('qbPartNumber', e.target.value)} placeholder="11003" />
              </Field>
              <Field label="VaultPRO class code" hint="Governed — confirm against VaultPRO cert types. Blank = cert push parks for review.">
                <input className={inputCls} value={form.vaultProClassCode} onChange={e => set('vaultProClassCode', e.target.value.toUpperCase())} placeholder="H2S" />
              </Field>

              <Field label="Book version">
                <input className={inputCls} value={form.bookVersion} onChange={e => set('bookVersion', e.target.value)} />
              </Field>
              <Field label="Test version">
                <input className={inputCls} value={form.testVersion} onChange={e => set('testVersion', e.target.value)} />
              </Field>

              <div className="sm:col-span-2">
                <Field label="Description">
                  <textarea className={cn(inputCls, 'min-h-[70px]')} value={form.description} onChange={e => set('description', e.target.value)} />
                </Field>
              </div>

              <Field label="Sort order" hint="Lower shows first in the wizard.">
                <input className={inputCls} type="number" value={form.sortOrder} onChange={e => set('sortOrder', e.target.value)} />
              </Field>

              <div className="flex flex-col justify-end gap-2 pb-1">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="w-4 h-4" checked={form.cardsOnSite} onChange={e => set('cardsOnSite', e.target.checked)} />
                  Cards handed out in class
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="w-4 h-4" checked={form.isActive} onChange={e => set('isActive', e.target.checked)} />
                  Active (shown in wizard)
                </label>
              </div>
            </div>

            {saveError && (
              <div className="mx-5 mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{saveError}</div>
            )}

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100">
              <button
                onClick={() => setShowDialog(false)}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editing ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CourseTable({ courses, canManage, onEdit, retired }: {
  courses: Course[]
  canManage: boolean
  onEdit: (c: Course) => void
  retired?: boolean
}) {
  if (courses.length === 0) return null
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-xl">
      <table className={cn('w-full text-sm', retired && 'opacity-60')}>
        <thead>
          <tr className="bg-slate-50 text-left text-xs text-slate-500">
            <th className="px-4 py-2.5 font-medium">Course</th>
            <th className="px-4 py-2.5 font-medium">Duration</th>
            <th className="px-4 py-2.5 font-medium">Validity</th>
            <th className="px-4 py-2.5 font-medium">QB Item</th>
            <th className="px-4 py-2.5 font-medium">VaultPRO</th>
            <th className="px-4 py-2.5 font-medium">Cards</th>
            {canManage && <th className="px-2 py-2.5" />}
          </tr>
        </thead>
        <tbody>
          {courses.map(c => (
            <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50/50">
              <td className="px-4 py-2.5">
                <div className="font-medium text-slate-800">{c.name}</div>
                <div className="text-xs text-slate-400 font-mono">{c.code}</div>
              </td>
              <td className="px-4 py-2.5 text-slate-600">{c.durationHours != null ? `${c.durationHours} hr` : '—'}</td>
              <td className="px-4 py-2.5 text-slate-600">{c.validityMonths != null ? `${c.validityMonths} mo` : '—'}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{c.qbPartNumber ?? '—'}</td>
              <td className="px-4 py-2.5">
                {c.vaultProClassCode ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded text-xs font-medium">
                    <Award className="w-3 h-3" />{c.vaultProClassCode}
                  </span>
                ) : (
                  <span className="text-xs text-amber-600" title="Cert push parks for review until a code is set">unmapped</span>
                )}
              </td>
              <td className="px-4 py-2.5">
                {c.cardsOnSite && (
                  <span className="inline-flex items-center gap-1 text-xs text-slate-500" title="Cards handed out in class">
                    <CreditCard className="w-3.5 h-3.5" /> on-site
                  </span>
                )}
              </td>
              {canManage && (
                <td className="px-2 py-2.5 text-right">
                  <button onClick={() => onEdit(c)} className="p-1.5 text-slate-400 hover:text-blue-600 rounded" title="Edit">
                    <Pencil className="w-4 h-4" />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
