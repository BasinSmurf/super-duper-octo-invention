import { Link } from 'react-router-dom'
import { CloudOff } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { isFieldMobileRole } from '@/lib/roleMobility'

/**
 * Gate for routes that write ticket work through the offline queue.
 *
 * Ticket writes go into Dexie and drain via the sync engine, and the sync engine
 * only loads for field-mobile roles (ADR-0005). An office-only role could
 * therefore build a complete ticket, watch it save, and have it never leave the
 * browser: the mutation sits in the queue with nothing running that could push
 * it, and SyncStatusBar — the one place a pending count is visible — is hidden
 * for exactly those roles. No error, no indicator, work silently lost.
 *
 * So block the write rather than let it be entered. Reading is untouched: ticket
 * detail and lists fetch over HTTP and work for every role.
 */
export function RequireSyncingRole({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()

  if (isFieldMobileRole(user?.role)) return <>{children}</>

  return (
    <div className="max-w-lg mx-auto mt-10 px-4">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <div className="flex items-start gap-3">
          <CloudOff className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900">
            <h1 className="font-semibold text-base mb-1">
              Ticket editing needs a field role
            </h1>
            <p>
              Tickets are written offline first and synced up afterwards, and the
              sync engine only runs for field roles. On{' '}
              <span className="font-medium">{user?.role || 'this role'}</span> a
              ticket would save locally and never reach the server — so this is
              blocked rather than lost.
            </p>
            <p className="mt-2">
              Sign in as a field tech, field supervisor, dispatcher or boss to
              create or edit a ticket. Viewing tickets works on any role.
            </p>
          </div>
        </div>
      </div>
      <div className="mt-4 flex gap-3">
        <Link
          to="/tickets"
          className="px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-700"
        >
          Back to tickets
        </Link>
      </div>
    </div>
  )
}
