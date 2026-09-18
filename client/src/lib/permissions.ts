/**
 * Client-side permission helper.
 *
 * The server is the source of truth: PermissionsContext fetches the effective
 * role × capability matrix from GET /api/permissions/matrix and registers it
 * here via setServerMatrix(). hasPermission()/can() then read that matrix,
 * falling back to the bundled defaults below while it loads or offline.
 *
 * platform_admin is always all-powerful (mirrors the server).
 */

export type Role = 'field_tech' | 'dispatch' | 'field_super' | 'billing_ar' | 'trainer' | 'train_admin' | 'boss' | 'platform_admin'

export type Permission =
  | 'customers:view'
  | 'customers:manage'
  | 'billing:view'
  | 'billing:manage'
  | 'billing:profiles'
  | 'billing:enverus'
  | 'dispatch:manage'
  | 'rentals:edit'
  | 'shop_orders:edit'
  | 'locations:view'
  | 'locations:request'
  | 'locations:manage'
  | 'locations:approve'
  | 'locations:import_dmr'
  | 'inventory:view'
  | 'inventory:manage'
  | 'products:manage'
  | 'tickets:view'
  | 'tickets:create'
  | 'tickets:edit_own'
  | 'tickets:edit_any'
  | 'tickets:approve'
  | 'users:manage'
  | 'system:config'

const ALL: Role[] = ['field_tech', 'dispatch', 'field_super', 'billing_ar', 'trainer', 'train_admin', 'boss', 'platform_admin']

/**
 * Bundled fallback defaults — used only until the server matrix loads (or while
 * offline). Includes the legacy client-only aliases (billing:view, admin:*),
 * plus page/destructive caps so nav + buttons render correctly on first paint.
 * The server matrix overrides any matching key once fetched.
 */
const FALLBACK_MAP: Record<string, Role[]> = {
  'customers:view': [...ALL],
  'customers:manage': ['dispatch', 'billing_ar', 'platform_admin'],
  'billing:view': ['billing_ar', 'boss', 'platform_admin'],
  'billing:manage': ['billing_ar', 'platform_admin'],
  'billing:profiles': ['billing_ar', 'platform_admin'],
  'billing:enverus': ['billing_ar', 'platform_admin'],
  'dispatch:manage': ['dispatch', 'field_super', 'platform_admin'],
  'rentals:edit': ['field_super', 'billing_ar', 'boss', 'platform_admin'],
  'locations:view': [...ALL],
  'locations:request': ['field_tech', 'dispatch', 'field_super', 'platform_admin'],
  'locations:manage': ['dispatch', 'field_super', 'billing_ar', 'platform_admin'],
  'locations:approve': ['dispatch', 'field_super', 'billing_ar', 'platform_admin'],
  'locations:import_dmr': ['platform_admin'],
  'inventory:view': [...ALL],
  'inventory:manage': ['dispatch', 'field_super', 'platform_admin'],
  'products:manage': ['billing_ar', 'platform_admin'],
  'tickets:view': [...ALL],
  'tickets:create': ['field_tech', 'dispatch', 'field_super', 'trainer', 'train_admin', 'platform_admin'],
  'tickets:edit_own': ['field_tech', 'dispatch', 'field_super', 'trainer', 'train_admin', 'platform_admin'],
  'tickets:edit_any': ['dispatch', 'field_super', 'platform_admin'],
  'tickets:approve': ['dispatch', 'field_super', 'platform_admin'],
  'users:manage': ['platform_admin'],
  'system:config': ['platform_admin'],

  // Destructive (soft cancel/void + hard delete)
  'invoices:cancel': ['billing_ar', 'platform_admin'],
  'invoices:delete': ['platform_admin'],
  'tickets:cancel': ['billing_ar', 'platform_admin'],
  'tickets:delete': ['field_super', 'platform_admin'],
  'rentals:cancel': ['dispatch', 'field_super', 'billing_ar', 'platform_admin'],
  'rentals:delete': ['platform_admin'],
  'shop_orders:edit': ['dispatch', 'field_super', 'billing_ar', 'boss', 'platform_admin'],
  'shop_orders:cancel': ['field_super', 'boss', 'platform_admin'],
  'shop_orders:waive_billing': ['platform_admin'],
  'shop_orders:force_close': ['field_super', 'boss', 'platform_admin'],
  'shop_orders:delete': ['platform_admin'],

  // Page visibility (seeded from AppShell role arrays)
  'page:tickets': [...ALL],
  'page:my_jobs': ['field_tech', 'field_super', 'dispatch', 'trainer', 'train_admin', 'boss', 'platform_admin'],
  'page:shop': ['dispatch', 'field_super', 'field_tech', 'billing_ar', 'boss', 'platform_admin'],
  'page:billing': ['billing_ar', 'boss', 'platform_admin'],
  'page:dispatch': ['dispatch', 'field_super', 'platform_admin'],
  'page:dashboard': [...ALL],
  'page:ops': ['platform_admin'],
  'page:shop_board': ['dispatch', 'field_super', 'field_tech', 'billing_ar', 'boss', 'platform_admin'],
  'page:stale_transfers': ['dispatch', 'field_super', 'boss', 'platform_admin'],
  'page:rentals': ['dispatch', 'field_super', 'field_tech', 'billing_ar', 'boss', 'platform_admin'],
  'page:coverage': ['dispatch', 'field_super', 'boss', 'platform_admin'],
  'page:routes': ['dispatch', 'field_super', 'boss', 'platform_admin'],
  'page:approvals': ['field_super', 'billing_ar', 'boss', 'platform_admin'],
  'page:history': ['dispatch', 'field_super', 'billing_ar', 'boss', 'platform_admin'],
  'page:equipment': ['dispatch', 'field_super', 'boss', 'platform_admin'],
  'page:companies': ['dispatch', 'field_super', 'billing_ar', 'boss', 'platform_admin'],
  'page:locations': ['dispatch', 'field_super', 'billing_ar', 'boss', 'platform_admin'],
  'page:products': ['billing_ar', 'boss', 'platform_admin'],
  'page:cards': ['billing_ar', 'boss', 'platform_admin'],
  'page:admin': ['platform_admin'],
  'page:sites': ['platform_admin'],
  'page:printers': ['platform_admin'],
  'page:kiosks': ['platform_admin'],
  'page:board_settings': ['platform_admin'],
  'page:permissions': ['platform_admin'],
  'page:api_keys': ['platform_admin'],
  'page:courses': ['billing_ar', 'trainer', 'train_admin', 'boss', 'platform_admin'],
  'page:training': ['dispatch', 'field_super', 'billing_ar', 'trainer', 'train_admin', 'boss', 'platform_admin'],

  // Training (ClassPRO)
  'training:courses': ['billing_ar', 'train_admin', 'platform_admin'],
  'training:schedule': ['dispatch', 'field_super', 'billing_ar', 'train_admin', 'boss', 'platform_admin'],
}

// Server-provided effective matrix, registered by PermissionsContext. Seeded
// from localStorage so the first paint after a reload already reflects overrides.
let serverMatrix: Record<string, Role[]> | null = (() => {
  try {
    const raw = localStorage.getItem('sundog_permission_matrix')
    return raw ? (JSON.parse(raw) as Record<string, Role[]>) : null
  } catch {
    return null
  }
})()

/** Register the effective matrix fetched from the server (and cache it). */
export function setServerMatrix(matrix: Record<string, Role[]> | null) {
  serverMatrix = matrix
  try {
    if (matrix) localStorage.setItem('sundog_permission_matrix', JSON.stringify(matrix))
    else localStorage.removeItem('sundog_permission_matrix')
  } catch {
    /* noop */
  }
}

/** Core lookup: platform_admin always wins; server matrix first, then fallback. */
function lookup(role: string | undefined | null, capability: string): boolean {
  if (!role) return false
  if (role === 'platform_admin') return true
  const allowed = serverMatrix?.[capability] ?? FALLBACK_MAP[capability]
  if (!allowed) return false
  return allowed.includes(role as Role)
}

/** Check if a role has a specific capability. */
export function hasPermission(role: string | undefined | null, capability: Permission | string): boolean {
  return lookup(role, capability)
}
