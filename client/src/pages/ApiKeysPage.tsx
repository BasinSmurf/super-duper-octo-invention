import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  KeyRound,
  Plus,
  Copy,
  Check,
  Ban,
  Loader2,
  AlertTriangle,
  ShieldCheck,
} from 'lucide-react'

// v1 API token issuance — the tokens external consumers present to /api/v1.
// Primary use today: mint the bearer token BlueLion stores as
// SERVICEPRO_OUTBOUND_TOKEN for its card.issued flag (scope bluelion:write).
// The plaintext key is shown EXACTLY ONCE at issue; only its hash is stored.

interface ApiKeyRow {
  id: string
  label: string
  prefixHint: string | null
  scopes: string[]
  allowedIps: string[] | null
  revoked: boolean
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
  createdBy: string | null
}

interface EnvKeyRow {
  id: string
  label: string | null
  scopes: string[]
  revoked: boolean
}

interface KeysResponse {
  keys: ApiKeyRow[]
  envKeys: EnvKeyRow[]
  scopes: string[]
}

interface IssueResponse {
  id: string
  label: string
  prefixHint: string
  scopes: string[]
  key: string
}

const SCOPE_HINTS: Record<string, string> = {
  '*': 'Everything — full read + BlueLion writes. Use sparingly.',
  'bluelion:write': 'BlueLion sync writes + the card.issued receiver (the token BlueLion needs)',
  'bluelion:read': 'BlueLion sync queue read',
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function ApiKeysPage() {
  const [data, setData] = useState<KeysResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Issue dialog
  const [showIssue, setShowIssue] = useState(false)
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [allowedIps, setAllowedIps] = useState('')
  const [issuing, setIssuing] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)

  // The one-time plaintext reveal
  const [issued, setIssued] = useState<IssueResponse | null>(null)
  const [copied, setCopied] = useState(false)

  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.get<KeysResponse>('/admin/api-keys'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load API keys')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function toggleScope(s: string) {
    setScopes((prev) => {
      // '*' is exclusive of everything else
      if (s === '*') return prev.includes('*') ? [] : ['*']
      const next = prev.includes(s) ? prev.filter((x) => x !== s) : [...prev.filter((x) => x !== '*'), s]
      return next
    })
  }

  async function issue() {
    if (!label.trim() || scopes.length === 0) return
    setIssuing(true)
    setIssueError(null)
    try {
      const ips = allowedIps.split(',').map((s) => s.trim()).filter(Boolean)
      const res = await api.post<IssueResponse>('/admin/api-keys', {
        label: label.trim(),
        scopes,
        ...(ips.length ? { allowedIps: ips } : {}),
      })
      setIssued(res)
      setShowIssue(false)
      setLabel('')
      setScopes([])
      setAllowedIps('')
      await load()
    } catch (e) {
      setIssueError(e instanceof Error ? e.message : 'Failed to issue key')
    } finally {
      setIssuing(false)
    }
  }

  async function revoke(id: string) {
    setRevokingId(id)
    try {
      await api.post(`/admin/api-keys/${id}/revoke`)
      setConfirmRevokeId(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke key')
    } finally {
      setRevokingId(null)
    }
  }

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable — the key is still visible to select manually */
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto pb-12">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <KeyRound className="w-6 h-6 text-blue-600" />
          API Keys
        </h1>
        <button
          onClick={() => { setShowIssue(true); setIssued(null) }}
          className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" /> Issue Key
        </button>
      </div>
      <p className="text-xs text-slate-500 mb-5">
        Bearer tokens for the external <code className="bg-slate-100 px-1 rounded">/api/v1</code> surface.
        BlueLion&apos;s card-flag token is issued here with the <code className="bg-slate-100 px-1 rounded">bluelion:write</code> scope.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      )}

      {/* One-time plaintext reveal */}
      {issued && (
        <div className="mb-5 p-4 bg-amber-50 border-2 border-amber-300 rounded-xl">
          <div className="flex items-center gap-2 text-amber-900 font-semibold text-sm mb-2">
            <AlertTriangle className="w-4 h-4" />
            Copy this key now — it will never be shown again
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-white border border-amber-200 rounded-lg text-sm font-mono break-all select-all">
              {issued.key}
            </code>
            <button
              onClick={() => copyKey(issued.key)}
              className="flex items-center gap-1.5 px-3 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 shrink-0"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-amber-800 mt-2">
            <span className="font-medium">{issued.label}</span> · scopes: {issued.scopes.join(', ')} ·
            only the hash is stored on the server.
          </p>
        </div>
      )}

      {/* Issue dialog (inline panel) */}
      {showIssue && (
        <div className="mb-5 p-4 bg-white border border-slate-200 rounded-xl shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Issue a new key</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Label</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. bluelion-card-flag"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Scopes</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {(data?.scopes ?? []).map((s) => (
                  <label
                    key={s}
                    title={SCOPE_HINTS[s]}
                    className={cn(
                      'flex items-center gap-2 px-2.5 py-1.5 border rounded-lg text-xs cursor-pointer select-none',
                      scopes.includes(s)
                        ? 'border-blue-400 bg-blue-50 text-blue-900'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={scopes.includes(s)}
                      onChange={() => toggleScope(s)}
                      className="accent-blue-600"
                    />
                    <span className="font-mono">{s}</span>
                  </label>
                ))}
              </div>
              {SCOPE_HINTS[scopes[0] ?? ''] && scopes.length === 1 && (
                <p className="text-[11px] text-slate-500 mt-1">{SCOPE_HINTS[scopes[0]!]}</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Allowed IPs <span className="font-normal text-slate-400">(optional, comma-separated — blank allows any)</span>
              </label>
              <input
                value={allowedIps}
                onChange={(e) => setAllowedIps(e.target.value)}
                placeholder="192.168.0.50"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
              />
            </div>
            {issueError && <p className="text-xs text-red-600">{issueError}</p>}
            <div className="flex gap-2">
              <button
                onClick={issue}
                disabled={issuing || !label.trim() || scopes.length === 0}
                className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {issuing ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                Issue
              </button>
              <button
                onClick={() => { setShowIssue(false); setIssueError(null) }}
                className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Key list */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {(data?.keys ?? []).length === 0 ? (
          <p className="p-6 text-sm text-slate-500 text-center">No keys issued yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-100 bg-slate-50">
                  <th className="px-4 py-2 font-medium">Label</th>
                  <th className="px-4 py-2 font-medium">Key</th>
                  <th className="px-4 py-2 font-medium">Scopes</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {(data?.keys ?? []).map((k) => (
                  <tr key={k.id} className={cn('border-b border-slate-50', k.revoked && 'opacity-50')}>
                    <td className="px-4 py-2.5 font-medium text-slate-800">
                      {k.label}
                      {k.revoked && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-red-600 font-semibold">revoked</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">
                      {k.prefixHint ? `${k.prefixHint}…` : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <span key={s} className="px-1.5 py-0.5 bg-slate-100 rounded text-[11px] font-mono text-slate-600">{s}</span>
                        ))}
                      </div>
                      {k.allowedIps && k.allowedIps.length > 0 && (
                        <p className="text-[10px] text-slate-400 mt-0.5 font-mono">IPs: {k.allowedIps.join(', ')}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{fmtDate(k.lastUsedAt)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {fmtDate(k.createdAt)}
                      {k.createdBy && <span className="block text-[10px] text-slate-400">by {k.createdBy}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!k.revoked && (
                        confirmRevokeId === k.id ? (
                          <span className="inline-flex items-center gap-1.5">
                            <button
                              onClick={() => revoke(k.id)}
                              disabled={revokingId === k.id}
                              className="px-2 py-1 bg-red-600 text-white text-xs font-medium rounded hover:bg-red-700 disabled:opacity-50"
                            >
                              {revokingId === k.id ? 'Revoking…' : 'Confirm revoke'}
                            </button>
                            <button
                              onClick={() => setConfirmRevokeId(null)}
                              className="px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmRevokeId(k.id)}
                            title="Revoke — the key stops working immediately"
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                          >
                            <Ban className="w-3.5 h-3.5" /> Revoke
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Legacy env keys */}
      {(data?.envKeys ?? []).length > 0 && (
        <div className="mt-5">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" /> Env-configured keys (V1_API_KEYS)
          </h2>
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-1">
            {(data?.envKeys ?? []).map((k) => (
              <div key={k.id} className="flex items-center gap-2 text-xs text-slate-600">
                <span className="font-medium">{k.label ?? k.id}</span>
                <span className="font-mono text-slate-400">{k.scopes.join(', ')}</span>
                {k.revoked && <span className="text-red-500 font-medium">revoked</span>}
              </div>
            ))}
            <p className="text-[10px] text-slate-400 pt-1">
              These live in the server environment and are managed by editing <code>V1_API_KEYS</code>, not here.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
