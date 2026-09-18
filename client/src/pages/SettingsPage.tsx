import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Shield, Plus, Pencil, Trash2, Save, X, AlertTriangle, CheckCircle, Users, Key, KeyRound, UserX, UserCheck, Search, RefreshCw, Lock, MapPin, Percent } from 'lucide-react'

// ── Shared constants ──

interface RoleMapping {
  id: string
  googleGroupEmail: string
  sundogRole: string
  priority: number
  isActive: boolean
  createdAt: string
}

interface AppUser {
  id: string
  email: string
  name: string
  phone: string | null
  role: string
  homeSiteId: string | null
  isActive: boolean
  hasPin: boolean
  hasPassword: boolean
  isGoogleAuth: boolean
  lastLoginAt: string | null
  createdAt: string
}

interface Site {
  id: string
  name: string
  shortCode: string
}

interface SyncReport {
  created: number
  updated: number
  skippedSuspended: number
  total: number
  errors: { email: string; message: string }[]
}

const ROLE_OPTIONS = [
  { value: 'platform_admin', label: 'Platform Admin', color: 'bg-red-100 text-red-700' },
  { value: 'boss', label: 'Boss', color: 'bg-purple-100 text-purple-700' },
  { value: 'field_super', label: 'Field Supervisor', color: 'bg-blue-100 text-blue-700' },
  { value: 'billing_ar', label: 'Billing / AR', color: 'bg-orange-100 text-orange-700' },
  { value: 'dispatch', label: 'Dispatch', color: 'bg-teal-100 text-teal-700' },
  { value: 'field_tech', label: 'Field Tech', color: 'bg-green-100 text-green-700' },
  { value: 'train_admin', label: 'Training Admin', color: 'bg-indigo-100 text-indigo-700' },
  { value: 'trainer', label: 'Trainer', color: 'bg-cyan-100 text-cyan-700' },
]

const ROLE_COLOR_MAP = Object.fromEntries(ROLE_OPTIONS.map(r => [r.value, r.color]))
const ROLE_LABEL_MAP = Object.fromEntries(ROLE_OPTIONS.map(r => [r.value, r.label]))

export function SettingsPage() {
  // ── Role Mappings state ──
  const [mappings, setMappings] = useState<RoleMapping[]>([])
  const [loading, setLoading] = useState(true)
  const [googleGroupsConfigured, setGoogleGroupsConfigured] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [formEmail, setFormEmail] = useState('')
  const [formRole, setFormRole] = useState('field_tech')
  const [formPriority, setFormPriority] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Users state ──
  const [users, setUsers] = useState<AppUser[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [userSearch, setUserSearch] = useState('')
  const [pinUserId, setPinUserId] = useState<string | null>(null)
  const [pinValue, setPinValue] = useState('')
  const [pinSaving, setPinSaving] = useState(false)
  const [pinMessage, setPinMessage] = useState<string | null>(null)
  // Role editor
  const [roleEditingId, setRoleEditingId] = useState<string | null>(null)
  // Password editor (local users only)
  const [pwUserId, setPwUserId] = useState<string | null>(null)
  const [pwValue, setPwValue] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  // Google Workspace sync
  const [syncing, setSyncing] = useState(false)
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null)

  // ── Role Mappings CRUD ──

  async function loadMappings() {
    try {
      const res = await api.get<{ data: RoleMapping[]; googleGroupsConfigured: boolean }>('/role-mappings')
      setMappings(res.data)
      setGoogleGroupsConfigured(res.googleGroupsConfigured)
    } catch {
      setError('Failed to load role mappings')
    } finally {
      setLoading(false)
    }
  }

  async function loadUsers() {
    try {
      const res = await api.get<{ data: AppUser[] }>('/users')
      setUsers(res.data)
    } catch {
      setUsersError('Failed to load users')
    } finally {
      setUsersLoading(false)
    }
  }

  useEffect(() => {
    loadMappings()
    loadUsers()
    api.get<{ data: Site[] }>('/sites?active=true').then(({ data }) => setSites(data)).catch(() => {})
  }, [])

  function startAdd() {
    setAdding(true)
    setEditingId(null)
    setFormEmail('')
    setFormRole('field_tech')
    setFormPriority(0)
    setError(null)
  }

  function startEdit(m: RoleMapping) {
    setEditingId(m.id)
    setAdding(false)
    setFormEmail(m.googleGroupEmail)
    setFormRole(m.sundogRole)
    setFormPriority(m.priority)
    setError(null)
  }

  function cancelForm() {
    setAdding(false)
    setEditingId(null)
    setError(null)
  }

  async function handleSave() {
    if (!formEmail.trim()) { setError('Group email is required'); return }
    setSaving(true)
    setError(null)
    try {
      if (adding) {
        await api.post('/role-mappings', {
          googleGroupEmail: formEmail.trim(),
          sundogRole: formRole,
          priority: formPriority,
        })
      } else if (editingId) {
        await api.put(`/role-mappings/${editingId}`, {
          googleGroupEmail: formEmail.trim(),
          sundogRole: formRole,
          priority: formPriority,
        })
      }
      cancelForm()
      await loadMappings()
    } catch (err: any) {
      setError(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this role mapping?')) return
    try {
      await api.delete(`/role-mappings/${id}`)
      setMappings(prev => prev.filter(m => m.id !== id))
    } catch (err: any) {
      setError(err.message || 'Delete failed')
    }
  }

  async function handleToggleActive(m: RoleMapping) {
    try {
      await api.put(`/role-mappings/${m.id}`, { isActive: !m.isActive })
      await loadMappings()
    } catch (err: any) {
      setError(err.message || 'Update failed')
    }
  }

  // ── User PIN management ──

  function startSetPin(userId: string) {
    setPinUserId(userId)
    setPinValue('')
    setPinMessage(null)
    setUsersError(null)
  }

  function cancelPin() {
    setPinUserId(null)
    setPinValue('')
    setPinMessage(null)
  }

  async function handleSavePin() {
    if (!pinUserId) return
    if (!/^\d{4,6}$/.test(pinValue)) {
      setUsersError('PIN must be 4-6 digits')
      return
    }
    setPinSaving(true)
    setUsersError(null)
    try {
      const res = await api.put<{ message: string }>(`/users/${pinUserId}/pin`, { pin: pinValue })
      setPinMessage(res.message || 'PIN saved')
      setPinUserId(null)
      setPinValue('')
      await loadUsers()
      // Auto-clear success message
      setTimeout(() => setPinMessage(null), 3000)
    } catch (err: any) {
      setUsersError(err.message || 'Failed to set PIN')
    } finally {
      setPinSaving(false)
    }
  }

  async function handleClearPin(userId: string, userName: string) {
    if (!confirm(`Clear PIN for ${userName}? They won't be able to PIN-login until a new one is set.`)) return
    try {
      await api.delete(`/users/${userId}/pin`)
      await loadUsers()
      setPinMessage(`PIN cleared for ${userName}`)
      setTimeout(() => setPinMessage(null), 3000)
    } catch (err: any) {
      setUsersError(err.message || 'Failed to clear PIN')
    }
  }

  async function handleChangeRole(userId: string, newRole: string) {
    try {
      await api.put(`/users/${userId}/role`, { role: newRole })
      setRoleEditingId(null)
      await loadUsers()
      setPinMessage('Role updated')
      setTimeout(() => setPinMessage(null), 2500)
    } catch (err: any) {
      setUsersError(err.message || 'Failed to update role')
    }
  }

  async function handleChangeHomeSite(userId: string, siteId: string) {
    try {
      await api.put(`/users/${userId}/home-site`, { siteId: siteId || null })
      await loadUsers()
      setPinMessage('Home site updated')
      setTimeout(() => setPinMessage(null), 2500)
    } catch (err: any) {
      setUsersError(err.message || 'Failed to update home site')
    }
  }

  async function handleSavePassword() {
    if (!pwUserId) return
    if (pwValue.length < 8) {
      setUsersError('Password must be at least 8 characters')
      return
    }
    setPwSaving(true)
    setUsersError(null)
    try {
      const res = await api.put<{ message: string }>(`/users/${pwUserId}/password`, { password: pwValue })
      setPinMessage(res.message || 'Password updated')
      setPwUserId(null)
      setPwValue('')
      await loadUsers()
      setTimeout(() => setPinMessage(null), 3000)
    } catch (err: any) {
      setUsersError(err.message || 'Failed to set password')
    } finally {
      setPwSaving(false)
    }
  }

  async function handleSyncGoogle() {
    if (!confirm('Sync users from Google Workspace Directory?\n\nCreates users with no group mapping as inactive. Skips suspended Google accounts.')) return
    setSyncing(true)
    setSyncReport(null)
    setUsersError(null)
    try {
      const res = await api.post<{ report: SyncReport }>('/users/sync-google', {})
      setSyncReport(res.report)
      await loadUsers()
    } catch (err: any) {
      setUsersError(err.message || 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  async function handleToggleUserActive(userId: string) {
    try {
      await api.put(`/users/${userId}/toggle-active`)
      await loadUsers()
    } catch (err: any) {
      setUsersError(err.message || 'Failed to update user')
    }
  }

  // Filtered users
  const filteredUsers = users.filter(u => {
    if (!userSearch.trim()) return true
    const q = userSearch.toLowerCase()
    return u.name?.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.role.toLowerCase().includes(q)
  })

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Settings</h1>

      {/* ════════════════════════════════════════════════
          Google Groups → Role Mappings
         ════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-blue-600" />
            <div>
              <h2 className="font-semibold text-slate-900">Google Group → Role Mappings</h2>
              <p className="text-xs text-slate-500">
                Map Google Workspace groups to Service Pro roles. Users get the highest-priority matching role on SSO login.
              </p>
            </div>
          </div>
          <button
            onClick={startAdd}
            disabled={adding || !!editingId}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-700 text-white text-sm rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>

        {/* Status banner */}
        {!loading && !googleGroupsConfigured && (
          <div className="flex items-center gap-2 px-5 py-3 bg-amber-50 border-b border-amber-100 text-sm text-amber-700">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              Google Groups integration not configured. Set <code className="bg-amber-100 px-1 rounded text-xs">GOOGLE_SA_KEY_PATH</code> and{' '}
              <code className="bg-amber-100 px-1 rounded text-xs">GOOGLE_ADMIN_EMAIL</code> in your server .env.
              Mappings can be set up now and will activate once configured.
            </span>
          </div>
        )}
        {!loading && googleGroupsConfigured && (
          <div className="flex items-center gap-2 px-5 py-2 bg-green-50 border-b border-green-100 text-sm text-green-700">
            <CheckCircle className="w-4 h-4 shrink-0" />
            Google Groups integration active. Roles are synced on each SSO login.
          </div>
        )}

        {error && (
          <div className="px-5 py-2 bg-red-50 border-b border-red-100 text-sm text-red-600">{error}</div>
        )}

        {/* Add form */}
        {adding && (
          <div className="px-5 py-4 bg-blue-50 border-b border-blue-100">
            <MappingForm
              email={formEmail}
              role={formRole}
              priority={formPriority}
              onEmailChange={setFormEmail}
              onRoleChange={setFormRole}
              onPriorityChange={setFormPriority}
              onSave={handleSave}
              onCancel={cancelForm}
              saving={saving}
            />
          </div>
        )}

        {/* Mapping list */}
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading...</div>
        ) : mappings.length === 0 && !adding ? (
          <div className="p-8 text-center text-slate-400">
            No role mappings configured. Click "Add" to create one.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {mappings.map(m => (
              <div key={m.id}>
                {editingId === m.id ? (
                  <div className="px-5 py-4 bg-blue-50">
                    <MappingForm
                      email={formEmail}
                      role={formRole}
                      priority={formPriority}
                      onEmailChange={setFormEmail}
                      onRoleChange={setFormRole}
                      onPriorityChange={setFormPriority}
                      onSave={handleSave}
                      onCancel={cancelForm}
                      saving={saving}
                    />
                  </div>
                ) : (
                  <div className={cn(
                    'flex items-center justify-between px-5 py-3 group',
                    !m.isActive && 'opacity-50',
                  )}>
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-sm text-slate-700 truncate">{m.googleGroupEmail}</span>
                      <span className="text-slate-300">→</span>
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap', ROLE_COLOR_MAP[m.sundogRole] || 'bg-slate-100')}>
                        {ROLE_LABEL_MAP[m.sundogRole] || m.sundogRole}
                      </span>
                      <span className="text-[10px] text-slate-400 whitespace-nowrap">pri {m.priority}</span>
                      {!m.isActive && (
                        <span className="text-[10px] text-slate-400 font-medium">DISABLED</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleToggleActive(m)}
                        className="p-1.5 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 text-xs"
                        title={m.isActive ? 'Disable' : 'Enable'}
                      >
                        {m.isActive ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => startEdit(m)}
                        className="p-1.5 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50"
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(m.id)}
                        className="p-1.5 rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Info footer */}
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 text-xs text-slate-500">
          <strong>How it works:</strong> On Google SSO login, Service Pro checks which groups the user belongs to.
          The mapping with the highest priority determines their role.
          Users without any matching group cannot sign in (existing users keep PIN login as fallback).
        </div>
      </div>

      {/* ════════════════════════════════════════════════
          User Management + PIN Setup
         ════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <Users className="w-5 h-5 text-blue-600" />
            <div>
              <h2 className="font-semibold text-slate-900">Users &amp; PIN Management</h2>
              <p className="text-xs text-slate-500">
                Manage roles, PINs, and passwords. Users auto-provision on Google SSO login, or import them ahead of time.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                type="text"
                value={userSearch}
                onChange={e => setUserSearch(e.target.value)}
                placeholder="Search users..."
                className="pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg text-sm w-48 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
            <button
              onClick={handleSyncGoogle}
              disabled={syncing || !googleGroupsConfigured}
              title={googleGroupsConfigured ? 'Import users from Google Workspace Directory' : 'Configure Google Workspace env vars first'}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-700 text-white text-sm rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', syncing && 'animate-spin')} />
              {syncing ? 'Syncing...' : 'Sync Google Workspace'}
            </button>
          </div>
        </div>

        {/* Sync report banner */}
        {syncReport && (
          <div className="flex items-start gap-2 px-5 py-2 bg-blue-50 border-b border-blue-100 text-sm text-blue-800">
            <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div>
                Synced {syncReport.total} Workspace users — <strong>{syncReport.created}</strong> created,{' '}
                <strong>{syncReport.updated}</strong> updated, <strong>{syncReport.skippedSuspended}</strong> suspended skipped.
              </div>
              {syncReport.errors.length > 0 && (
                <div className="text-xs text-red-700 mt-1">
                  {syncReport.errors.length} error(s): {syncReport.errors.slice(0, 3).map(e => e.email).join(', ')}
                  {syncReport.errors.length > 3 && ` +${syncReport.errors.length - 3} more`}
                </div>
              )}
            </div>
            <button onClick={() => setSyncReport(null)} className="text-blue-400 hover:text-blue-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Success message */}
        {pinMessage && (
          <div className="flex items-center gap-2 px-5 py-2 bg-green-50 border-b border-green-100 text-sm text-green-700">
            <CheckCircle className="w-4 h-4 shrink-0" />
            {pinMessage}
          </div>
        )}

        {/* Error */}
        {usersError && (
          <div className="px-5 py-2 bg-red-50 border-b border-red-100 text-sm text-red-600">{usersError}</div>
        )}

        {/* User list */}
        {usersLoading ? (
          <div className="p-8 text-center text-slate-400">Loading...</div>
        ) : filteredUsers.length === 0 ? (
          <div className="p-8 text-center text-slate-400">
            {userSearch ? 'No users match your search.' : 'No users found.'}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredUsers.map(u => (
              <div key={u.id}>
                {pinUserId === u.id ? (
                  /* ── Inline PIN form ── */
                  <div className="px-5 py-4 bg-blue-50">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900">Set PIN for {u.name || u.email}</p>
                        <p className="text-xs text-slate-500">Enter a 4-6 digit numeric PIN</p>
                      </div>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={6}
                        value={pinValue}
                        onChange={e => setPinValue(e.target.value.replace(/\D/g, ''))}
                        placeholder="••••"
                        autoFocus
                        className="w-32 px-3 py-2 border border-slate-300 rounded-lg text-center text-xl tracking-[0.4em] font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        onKeyDown={e => {
                          if (e.key === 'Enter' && pinValue.length >= 4) handleSavePin()
                          if (e.key === 'Escape') cancelPin()
                        }}
                      />
                      <button
                        onClick={handleSavePin}
                        disabled={pinSaving || pinValue.length < 4}
                        className="flex items-center gap-1.5 px-3 py-2 bg-blue-700 text-white text-sm rounded-lg hover:bg-blue-600 disabled:opacity-50"
                      >
                        <Save className="w-3.5 h-3.5" />
                        {pinSaving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        onClick={cancelPin}
                        className="flex items-center gap-1.5 px-3 py-2 border border-slate-300 text-sm rounded-lg hover:bg-slate-50"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : pwUserId === u.id ? (
                  /* ── Inline password form ── */
                  <div className="px-5 py-4 bg-amber-50">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900">Set password for {u.name || u.email}</p>
                        <p className="text-xs text-slate-500">Minimum 8 characters. Used for email+password login on desktop.</p>
                      </div>
                      <input
                        type="text"
                        value={pwValue}
                        onChange={e => setPwValue(e.target.value)}
                        placeholder="new password"
                        autoFocus
                        className="w-64 px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none"
                        onKeyDown={e => {
                          if (e.key === 'Enter' && pwValue.length >= 8) handleSavePassword()
                          if (e.key === 'Escape') { setPwUserId(null); setPwValue('') }
                        }}
                      />
                      <button
                        onClick={handleSavePassword}
                        disabled={pwSaving || pwValue.length < 8}
                        className="flex items-center gap-1.5 px-3 py-2 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-500 disabled:opacity-50"
                      >
                        <Save className="w-3.5 h-3.5" />
                        {pwSaving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setPwUserId(null); setPwValue('') }}
                        className="flex items-center gap-1.5 px-3 py-2 border border-slate-300 text-sm rounded-lg hover:bg-slate-50"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  /* ── User row ── */
                  <div className={cn(
                    'flex items-center justify-between px-5 py-3 group',
                    !u.isActive && 'opacity-60',
                  )}>
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Avatar */}
                      <div className={cn(
                        'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
                        u.isActive ? 'bg-blue-100 text-blue-700' : 'bg-slate-200 text-slate-500',
                      )}>
                        {u.name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-900 truncate">{u.name || 'Unnamed'}</span>
                          {roleEditingId === u.id ? (
                            <select
                              autoFocus
                              value={u.role}
                              onChange={e => handleChangeRole(u.id, e.target.value)}
                              onBlur={() => setRoleEditingId(null)}
                              className="px-2 py-0.5 border border-blue-300 rounded text-xs bg-white"
                            >
                              {ROLE_OPTIONS.map(r => (
                                <option key={r.value} value={r.value}>{r.label}</option>
                              ))}
                            </select>
                          ) : (
                            <button
                              onClick={() => setRoleEditingId(u.id)}
                              className={cn('px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap hover:ring-2 hover:ring-blue-400', ROLE_COLOR_MAP[u.role] || 'bg-slate-100')}
                              title="Click to change role"
                            >
                              {ROLE_LABEL_MAP[u.role] || u.role}
                            </button>
                          )}
                          {/* Auth type */}
                          {u.isGoogleAuth ? (
                            <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded" title="Signs in via Google Workspace">
                              Google
                            </span>
                          ) : (
                            <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded" title="Local account — password managed in Sundog">
                              Local
                            </span>
                          )}
                          {u.hasPin ? (
                            <span className="flex items-center gap-0.5 text-[10px] text-green-600" title="PIN configured">
                              <KeyRound className="w-3 h-3" />
                              PIN
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400">No PIN</span>
                          )}
                          {!u.isGoogleAuth && (
                            u.hasPassword ? (
                              <span className="flex items-center gap-0.5 text-[10px] text-blue-600" title="Password configured">
                                <Lock className="w-3 h-3" />
                                PW
                              </span>
                            ) : (
                              <span className="text-[10px] text-red-500 font-medium">No password</span>
                            )
                          )}
                          {!u.isActive && (
                            <span className="text-[10px] text-red-500 font-medium">DEACTIVATED</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 truncate">
                          {u.email}
                          {u.lastLoginAt && (
                            <span className="ml-2 text-slate-400">· last login {new Date(u.lastLoginAt).toLocaleDateString()}</span>
                          )}
                        </p>
                        {sites.length > 1 && (
                          <div className="flex items-center gap-1.5 mt-1">
                            <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                            <span className="text-[10px] text-slate-500">Home site</span>
                            <select
                              value={u.homeSiteId ?? ''}
                              onChange={e => handleChangeHomeSite(u.id, e.target.value)}
                              className="px-1.5 py-0.5 border border-slate-300 rounded text-xs bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                            >
                              <option value="">— Default (A–Z) —</option>
                              {sites.map(s => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions — show on hover */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        onClick={() => startSetPin(u.id)}
                        className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-slate-500 hover:text-blue-600 hover:bg-blue-50"
                        title="Set PIN"
                      >
                        <Key className="w-3.5 h-3.5" />
                        {u.hasPin ? 'Change PIN' : 'Set PIN'}
                      </button>
                      {u.hasPin && (
                        <button
                          onClick={() => handleClearPin(u.id, u.name || u.email)}
                          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-slate-500 hover:text-red-600 hover:bg-red-50"
                          title="Clear PIN"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {!u.isGoogleAuth && (
                        <button
                          onClick={() => { setPwUserId(u.id); setPwValue('') }}
                          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-slate-500 hover:text-amber-600 hover:bg-amber-50"
                          title="Set password"
                        >
                          <Lock className="w-3.5 h-3.5" />
                          {u.hasPassword ? 'Change PW' : 'Set PW'}
                        </button>
                      )}
                      <button
                        onClick={() => handleToggleUserActive(u.id)}
                        className={cn(
                          'flex items-center gap-1 px-2 py-1.5 rounded text-xs',
                          u.isActive
                            ? 'text-slate-500 hover:text-red-600 hover:bg-red-50'
                            : 'text-slate-500 hover:text-green-600 hover:bg-green-50',
                        )}
                        title={u.isActive ? 'Deactivate' : 'Reactivate'}
                      >
                        {u.isActive ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Info footer */}
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 text-xs text-slate-500">
          <strong>How it works:</strong> Users auto-provision on first Google SSO login, or bulk-import via <em>Sync Google Workspace</em>.
          Users imported without a group→role mapping arrive deactivated and must be assigned a role before they can sign in.
          <br />
          <strong>Google users:</strong> password is managed in Google Workspace (no reset here). PIN is still useful for offline iPad login.
          <strong className="ml-2">Local users:</strong> password + PIN are both managed here.
        </div>
      </div>

      {/* ════════════════════════════════════════════════
          Sales Tax Jurisdictions
         ════════════════════════════════════════════════ */}
      <SalesTaxRatesCard />
    </div>
  )
}

// ── Sales Tax Jurisdictions card ──
// Admin-editable ND/MT rate table. Rates entered as a percent (8 = 8%) and
// stored as a decimal. The county + "county default" flag drive the
// destination-based auto-selection at invoice generation; qbTaxItemName maps
// to the QuickBooks Sales Tax Item so QB recomputes tax to match.

interface TaxRateRow {
  id: string
  name: string
  rate: number | string
  county: string | null
  isCountyDefault: boolean
  qbTaxItemName: string | null
  active: boolean
  sortOrder: number
}

const BLANK_RATE: TaxRateRow = {
  id: '', name: '', rate: 0, county: '', isCountyDefault: false, qbTaxItemName: '', active: true, sortOrder: 0,
}

function SalesTaxRatesCard() {
  const [rates, setRates] = useState<TaxRateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<TaxRateRow>(BLANK_RATE)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const res = await api.get<{ data: TaxRateRow[] }>('/sales-tax-rates')
      setRates(res.data)
    } catch {
      setError('Failed to load tax rates')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  function startAdd() {
    setDraft({ ...BLANK_RATE, sortOrder: (rates.at(-1)?.sortOrder ?? 0) + 1 })
    setAdding(true)
    setEditingId(null)
    setError(null)
  }
  function startEdit(r: TaxRateRow) {
    // Convert stored decimal → percent for the form
    setDraft({ ...r, rate: +(Number(r.rate) * 100).toFixed(3), county: r.county || '', qbTaxItemName: r.qbTaxItemName || '' })
    setEditingId(r.id)
    setAdding(false)
    setError(null)
  }
  function cancel() { setAdding(false); setEditingId(null); setError(null) }

  async function save() {
    if (!draft.name.trim()) { setError('Name is required'); return }
    const ratePct = Number(draft.rate)
    if (isNaN(ratePct) || ratePct < 0 || ratePct > 100) { setError('Rate must be a percent between 0 and 100'); return }
    const body = {
      name: draft.name.trim(),
      rate: ratePct / 100, // percent → decimal
      county: draft.county?.trim() || null,
      isCountyDefault: draft.isCountyDefault,
      qbTaxItemName: draft.qbTaxItemName?.trim() || null,
      active: draft.active,
      sortOrder: draft.sortOrder,
    }
    setSaving(true)
    setError(null)
    try {
      if (adding) {
        const id = draft.id.trim() || draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
        await api.post('/sales-tax-rates', { id, ...body })
      } else if (editingId) {
        await api.put(`/sales-tax-rates/${editingId}`, body)
      }
      cancel()
      await load()
    } catch (err: any) {
      setError(err?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <Percent className="w-5 h-5 text-blue-600" />
          <div>
            <h2 className="font-semibold text-slate-900">Sales Tax Jurisdictions</h2>
            <p className="text-xs text-slate-500">
              ND/MT destination-based rates. The county + "county default" flag auto-select the rate on new invoices; the QB Item maps to QuickBooks.
            </p>
          </div>
        </div>
        <button
          onClick={startAdd}
          disabled={adding || !!editingId}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-700 text-white text-sm rounded-lg hover:bg-blue-600 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          Add
        </button>
      </div>

      {error && <div className="px-5 py-2 bg-red-50 border-b border-red-100 text-sm text-red-600">{error}</div>}

      {adding && (
        <div className="px-5 py-4 bg-blue-50 border-b border-blue-100">
          <TaxRateForm draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel} saving={saving} isNew />
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-slate-400">Loading...</div>
      ) : (
        <div className="divide-y divide-slate-100">
          {rates.map(r => (
            <div key={r.id}>
              {editingId === r.id ? (
                <div className="px-5 py-4 bg-blue-50">
                  <TaxRateForm draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel} saving={saving} />
                </div>
              ) : (
                <div className={cn('flex items-center justify-between px-5 py-3 group', !r.active && 'opacity-50')}>
                  <div className="flex items-center gap-3 min-w-0 flex-wrap">
                    <span className="text-sm font-medium text-slate-800">{r.name}</span>
                    <span className="text-xs font-mono text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                      {(Number(r.rate) * 100).toFixed(Number(r.rate) * 100 % 1 === 0 ? 0 : 2)}%
                    </span>
                    {r.county && (
                      <span className="text-[10px] text-slate-500">
                        {r.county} Co.{r.isCountyDefault && <span className="ml-1 text-emerald-600 font-medium">· default</span>}
                      </span>
                    )}
                    {!r.active && <span className="text-[10px] text-slate-400 font-medium">DISABLED</span>}
                  </div>
                  <button
                    onClick={() => startEdit(r)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-blue-700 border border-blue-200 hover:bg-blue-50 shrink-0"
                    title="Edit jurisdiction"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 text-xs text-slate-500">
        <strong>Destination-based:</strong> new invoices pick the row whose county matches the service location and "county default" is on (the unincorporated rate most well sites use). Billing can override per invoice for sites inside city limits.
      </div>
    </div>
  )
}

function TaxRateForm({ draft, setDraft, onSave, onCancel, saving, isNew }: {
  draft: TaxRateRow
  setDraft: (r: TaxRateRow) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  isNew?: boolean
}) {
  const set = (patch: Partial<TaxRateRow>) => setDraft({ ...draft, ...patch })
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
          <input
            type="text" value={draft.name} onChange={e => set({ name: e.target.value })}
            placeholder="Williston (8%)"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Rate %</label>
          <input
            type="number" step="0.001" value={draft.rate} onChange={e => set({ rate: e.target.value as any })}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">County</label>
          <input
            type="text" value={draft.county || ''} onChange={e => set({ county: e.target.value })}
            placeholder="Williams"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">QuickBooks Sales Tax Item</label>
          <input
            type="text" value={draft.qbTaxItemName || ''} onChange={e => set({ qbTaxItemName: e.target.value })}
            placeholder="Exact QB Sales Tax Item name"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <div className="flex items-end gap-4 pb-1">
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={draft.isCountyDefault} onChange={e => set({ isCountyDefault: e.target.checked })}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
            County default
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={draft.active} onChange={e => set({ active: e.target.checked })}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
            Active
          </label>
        </div>
      </div>
      {isNew && (
        <p className="text-[11px] text-slate-400">A slug id will be generated from the name. The QB item name must match QuickBooks exactly for tax to sync.</p>
      )}
      <div className="flex items-center gap-2">
        <button onClick={onSave} disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-700 text-white text-sm rounded-lg hover:bg-blue-600 disabled:opacity-50">
          <Save className="w-3.5 h-3.5" />{saving ? 'Saving...' : 'Save'}
        </button>
        <button onClick={onCancel}
          className="flex items-center gap-1.5 px-4 py-2 border border-slate-300 text-sm rounded-lg hover:bg-slate-50">
          <X className="w-3.5 h-3.5" />Cancel
        </button>
      </div>
    </div>
  )
}

// ── Mapping Form sub-component (unchanged) ──

function MappingForm({
  email, role, priority,
  onEmailChange, onRoleChange, onPriorityChange,
  onSave, onCancel, saving,
}: {
  email: string; role: string; priority: number
  onEmailChange: (v: string) => void
  onRoleChange: (v: string) => void
  onPriorityChange: (v: number) => void
  onSave: () => void; onCancel: () => void; saving: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-1">
          <label className="block text-xs font-medium text-slate-600 mb-1">Google Group Email</label>
          <input
            type="email"
            value={email}
            onChange={e => onEmailChange(e.target.value)}
            placeholder="sundog.tech@basinsafetyus.com"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Service Pro Role</label>
          <select
            value={role}
            onChange={e => onRoleChange(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
          >
            {ROLE_OPTIONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Priority</label>
          <input
            type="number"
            value={priority}
            onChange={e => onPriorityChange(parseInt(e.target.value, 10) || 0)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          <p className="text-[10px] text-slate-400 mt-0.5">Higher = takes precedence</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-700 text-white text-sm rounded-lg hover:bg-blue-600 disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-4 py-2 border border-slate-300 text-sm rounded-lg hover:bg-slate-50"
        >
          <X className="w-3.5 h-3.5" />
          Cancel
        </button>
      </div>
    </div>
  )
}
