import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ApprovalsTab } from './ApprovalsTab'
import { LocationRequestsTab } from './LocationRequestsTab'
import { DeploymentsTab } from './DeploymentsTab'
import { ClipboardCheck, MapPin, Truck } from 'lucide-react'

type SubTab = 'tickets' | 'locations' | 'deployments'

/**
 * ApprovalsHost — sub-tab container for the Approvals dashboard.
 *   - Tickets      (existing supervisor review queue)
 *   - Deployments  (rental/on-site jobs deployed without a rental attached)
 *   - Locations    (pending location-request review / DMR shell-game resolve)
 *
 * Sub-tab is persisted in the URL as `?atab=tickets|deployments|locations` so
 * deep-links survive reloads. Badges show pending counts.
 */
export function ApprovalsHost() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialParam = searchParams.get('atab') as SubTab | null
  const initial: SubTab =
    initialParam === 'locations' || initialParam === 'deployments' ? initialParam : 'tickets'
  const [sub, setSub] = useState<SubTab>(initial)
  const [locationCount, setLocationCount] = useState<number | null>(null)
  const [deploymentCount, setDeploymentCount] = useState<number | null>(null)

  // Keep URL in sync when sub changes
  useEffect(() => {
    const current = searchParams.get('atab')
    if (sub === 'tickets' && current) {
      const next = new URLSearchParams(searchParams)
      next.delete('atab')
      setSearchParams(next, { replace: true })
    } else if (sub !== 'tickets' && current !== sub) {
      const next = new URLSearchParams(searchParams)
      next.set('atab', sub)
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub])

  // Poll the badge counts (cheap, refreshes on mount + sub change)
  useEffect(() => {
    let cancelled = false
    api.get<{ data: unknown[]; total: number }>('/locations/requests/pending')
      .then(res => { if (!cancelled) setLocationCount(res.total) })
      .catch(() => { if (!cancelled) setLocationCount(null) })
    api.get<{ total: number }>('/tickets/deployments-queue')
      .then(res => { if (!cancelled) setDeploymentCount(res.total) })
      .catch(() => { if (!cancelled) setDeploymentCount(null) })
    return () => { cancelled = true }
  }, [sub])

  return (
    <div className="space-y-4">
      {/* Sub-tab bar */}
      <div className="border-b border-slate-200 flex gap-0">
        <SubTabButton
          icon={<ClipboardCheck className="w-4 h-4" />}
          label="Tickets"
          active={sub === 'tickets'}
          onClick={() => setSub('tickets')}
        />
        <SubTabButton
          icon={<Truck className="w-4 h-4" />}
          label="Deployments"
          active={sub === 'deployments'}
          onClick={() => setSub('deployments')}
          badge={deploymentCount && deploymentCount > 0 ? deploymentCount : undefined}
        />
        <SubTabButton
          icon={<MapPin className="w-4 h-4" />}
          label="Locations"
          active={sub === 'locations'}
          onClick={() => setSub('locations')}
          badge={locationCount && locationCount > 0 ? locationCount : undefined}
        />
      </div>

      {sub === 'tickets' && <ApprovalsTab />}
      {sub === 'deployments' && <DeploymentsTab />}
      {sub === 'locations' && <LocationRequestsTab />}
    </div>
  )
}

interface SubTabButtonProps {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  badge?: number
}

function SubTabButton({ icon, label, active, onClick, badge }: SubTabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
        active
          ? 'border-emerald-600 text-emerald-700'
          : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300',
      )}
    >
      {icon}
      {label}
      {typeof badge === 'number' && (
        <span className={cn(
          'text-[10px] font-semibold px-1.5 py-0.5 rounded',
          active ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700',
        )}>
          {badge}
        </span>
      )}
    </button>
  )
}
