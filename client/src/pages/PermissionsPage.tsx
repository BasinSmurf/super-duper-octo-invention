import { useState, useEffect, useMemo, useRef } from 'react'
import { api } from '@/lib/api'
import { type Role } from '@/lib/permissions'
import { usePermissions } from '@/contexts/PermissionsContext'
import { Shield, AlertTriangle } from 'lucide-react'

// Capabilities platform_admin can never lose — rendered locked in the UI.
const ADMIN_LOCKED = new Set(['system:config', 'users:manage', 'page:permissions'])

function roleLabel(role: string): string {
  return role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function PermissionsPage() {
  const { can, catalog, roles, matrix: liveMatrix, reload } = usePermissions()
  const canManage = can('system:config')

  const [matrix, setMatrix] = useState<Record<string, Role[]>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Fetch fresh on mount so the editor always reflects the persisted matrix.
  useEffect(() => {
    let cancelled = false
    api.get<{ matrix: Record<string, Role[]> }>('/permissions/matrix')
      .then(res => { if (!cancelled) setMatrix(res.matrix) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load permissions') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Group catalog rows by their `group` for sectioned rendering.
  const groups = useMemo(() => {
    const order: string[] = []
    const byGroup: Record<string, typeof catalog> = {}
    for (const cap of catalog) {
      if (!byGroup[cap.group]) { byGroup[cap.group] = []; order.push(cap.group) }
      byGroup[cap.group].push(cap)
    }
    return order.map(g => ({ group: g, caps: byGroup[g] }))
  }, [catalog])

  function isChecked(cap: string, role: Role): boolean {
    if (role === 'platform_admin') return true
    return (matrix[cap] ?? liveMatrix[cap] ?? []).includes(role)
  }

  function toggle(cap: string, role: Role) {
    if (!canManage || role === 'platform_admin') return
    setMatrix(prev => {
      const current = prev[cap] ?? liveMatrix[cap] ?? []
      const next = current.includes(role) ? current.filter(r => r !== role) : [...current, role]
      return { ...prev, [cap]: next }
    })
  }

  /** Section toggle: grant/revoke every capability in a group for one role at once. */
  function toggleGroup(caps: { key: string }[], role: Role, grant: boolean) {
    if (!canManage || role === 'platform_admin') return
    setMatrix(prev => {
      const next = { ...prev }
      for (const cap of caps) {
        const current = next[cap.key] ?? liveMatrix[cap.key] ?? []
        next[cap.key] = grant
          ? (current.includes(role) ? current : [...current, role])
          : current.filter(r => r !== role)
      }
      return next
    })
  }

  async function save() {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      // Send the full effective matrix (live values overlaid with edits) so the
      // server stores a complete snapshot.
      const full: Record<string, Role[]> = {}
      for (const cap of catalog) {
        const roleList = matrix[cap.key] ?? liveMatrix[cap.key] ?? []
        const set = new Set<Role>(roleList)
        set.add('platform_admin')
        full[cap.key] = roles.filter(r => set.has(r))
      }
      await api.put('/permissions/matrix', { matrix: full })
      await reload()
      setNotice('Permissions saved')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-2 mb-1">
        <Shield className="w-5 h-5 text-slate-500" />
        <h1 className="text-2xl font-bold text-slate-900">Permissions</h1>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Control which roles can see each page and perform each action. Platform Admin always has
        full access. Changes take effect on each user's next page load — no re-login needed.
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">{error}</div>
      )}
      {notice && (
        <div className="mb-4 p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-sm text-emerald-700">{notice}</div>
      )}
      {!canManage && (
        <div className="mb-4 p-3 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> You can view permissions but only a Platform Admin can change them.
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50">
              <tr className="border-b border-slate-200">
                <th className="text-left font-semibold text-slate-600 px-4 py-2.5 min-w-[18rem]">Capability</th>
                {roles.map(r => (
                  <th key={r} className="font-semibold text-slate-600 px-2 py-2.5 text-center whitespace-nowrap">
                    {roleLabel(r)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(({ group, caps }) => (
                <GroupSection
                  key={group}
                  group={group}
                  caps={caps}
                  roles={roles}
                  isChecked={isChecked}
                  toggle={toggle}
                  toggleGroup={toggleGroup}
                  canManage={canManage}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && !loading && (
        <div className="mt-4 flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Permissions'}
          </button>
        </div>
      )}
    </div>
  )
}

function GroupSection({
  group, caps, roles, isChecked, toggle, toggleGroup, canManage,
}: {
  group: string
  caps: { key: string; label: string; description: string }[]
  roles: Role[]
  isChecked: (cap: string, role: Role) => boolean
  toggle: (cap: string, role: Role) => void
  toggleGroup: (caps: { key: string }[], role: Role, grant: boolean) => void
  canManage: boolean
}) {
  return (
    <>
      <tr className="bg-slate-100/70">
        <td className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          {group}
        </td>
        {roles.map(role => {
          const checkedCount = caps.filter(c => isChecked(c.key, role)).length
          const all = checkedCount === caps.length
          return (
            <td key={role} className="px-2 py-1.5 text-center">
              <TriStateCheckbox
                checked={all}
                indeterminate={checkedCount > 0 && !all}
                disabled={!canManage || role === 'platform_admin'}
                onChange={() => toggleGroup(caps, role, !all)}
                title={
                  role === 'platform_admin'
                    ? 'Platform Admin always has full access'
                    : `${all ? 'Revoke' : 'Grant'} the entire ${group} section for ${roleLabel(role)}`
                }
              />
            </td>
          )
        })}
      </tr>
      {caps.map(cap => (
        <tr key={cap.key} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60" data-cap={cap.key}>
          <td className="px-4 py-2">
            <p className="font-medium text-slate-800">{cap.label}</p>
            <p className="text-[11px] text-slate-400">{cap.description}</p>
          </td>
          {roles.map(role => {
            const locked = role === 'platform_admin' && ADMIN_LOCKED.has(cap.key)
            return (
              <td key={role} className="px-2 py-2 text-center">
                <input
                  type="checkbox"
                  checked={isChecked(cap.key, role)}
                  disabled={!canManage || role === 'platform_admin'}
                  onChange={() => toggle(cap.key, role)}
                  title={
                    role === 'platform_admin'
                      ? (locked ? 'Platform Admin always has this (required)' : 'Platform Admin always has full access')
                      : undefined
                  }
                  className="w-4 h-4 accent-blue-600 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                />
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
}

/** Checkbox that can render the browser-native indeterminate ("some of these") state. */
function TriStateCheckbox({
  checked, indeterminate, disabled, onChange, title,
}: {
  checked: boolean
  indeterminate: boolean
  disabled: boolean
  onChange: () => void
  title?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      title={title}
      className="w-4 h-4 accent-blue-600 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
    />
  )
}
