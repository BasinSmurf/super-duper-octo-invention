import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { setServerMatrix, hasPermission, type Role } from '@/lib/permissions'

export interface CapabilityDef {
  key: string
  label: string
  group: string
  description: string
}

interface MatrixResponse {
  roles: Role[]
  catalog: CapabilityDef[]
  matrix: Record<string, Role[]>
  defaults: Record<string, Role[]>
}

interface PermissionsContextType {
  /** Does the current user have this capability? */
  can: (capability: string) => boolean
  /** Effective matrix (capability → roles), once loaded. */
  matrix: Record<string, Role[]>
  catalog: CapabilityDef[]
  roles: Role[]
  defaults: Record<string, Role[]>
  loading: boolean
  /** Refetch the matrix from the server (call after saving on the admin page). */
  reload: () => Promise<void>
}

const PermissionsContext = createContext<PermissionsContextType | null>(null)

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [data, setData] = useState<MatrixResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const res = await api.get<MatrixResponse>('/permissions/matrix')
      setServerMatrix(res.matrix)
      setData(res)
    } catch {
      // Offline / not-yet-authed: keep whatever cached matrix is registered.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (user) {
      void reload()
    } else {
      setLoading(false)
    }
  }, [user, reload])

  // `can` re-reads via hasPermission so it always reflects the registered matrix.
  const can = useCallback((capability: string) => hasPermission(user?.role, capability), [user, data])

  return (
    <PermissionsContext.Provider
      value={{
        can,
        matrix: data?.matrix ?? {},
        catalog: data?.catalog ?? [],
        roles: data?.roles ?? ['field_tech', 'dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'trainer', 'train_admin', 'boss', 'platform_admin'],
        defaults: data?.defaults ?? {},
        loading,
        reload,
      }}
    >
      {children}
    </PermissionsContext.Provider>
  )
}

export function usePermissions() {
  const ctx = useContext(PermissionsContext)
  if (!ctx) throw new Error('usePermissions must be used within PermissionsProvider')
  return ctx
}
