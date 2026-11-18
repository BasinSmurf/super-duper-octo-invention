/**
 * RBAC capability catalog + effective-matrix resolver.
 *
 * Single source of truth for "who can do what". The capability catalog below
 * (CAPABILITY_CATALOG) defines every gateable action and page, the human label
 * the admin Permissions page renders, and the DEFAULT role list.
 *
 * The effective matrix = DEFAULT_PERMISSIONS merged with admin overrides stored
 * in the PermissionConfig singleton row. Overrides are sparse: any capability
 * absent from the stored matrix falls back to its code default, so newly-added
 * capabilities always work without a DB edit.
 *
 * platform_admin is all-powerful and non-revocable — roleHasCapability() short-
 * circuits to true for it regardless of what the matrix says, and the PUT route
 * refuses to persist a matrix that would strip admin of the keep-the-lights-on
 * capabilities.
 */
import { prisma } from '../db.js';

export type Role =
  | 'field_tech'
  | 'dispatch'
  | 'field_super'
  | 'billing_ar'
  | 'ar_supervisor'
  | 'trainer'
  | 'train_admin'
  | 'boss'
  | 'platform_admin';

/** The staff roles, in display order. `customer` (portal) is intentionally excluded. */
export const ALL_ROLES: Role[] = [
  'field_tech',
  'dispatch',
  'field_super',
  'billing_ar',
  'ar_supervisor',
  'trainer',
  'train_admin',
  'boss',
  'platform_admin',
];

const ALL: Role[] = [...ALL_ROLES];

/**
 * A role that starts life as a copy of another. While the stored matrix has
 * never seen the new role, it mirrors what its base role holds IN THE STORED
 * MATRIX rather than the code defaults — otherwise an install where the admin
 * granted billing_ar something extra would ship an AR Supervisor who can do
 * less than the people they supervise (and one where the admin revoked
 * something would quietly hand it back). One-time: once the Permissions page is
 * saved with the role present, the stored matrix is the whole truth.
 */
const ROLE_INHERITS: Partial<Record<Role, Role>> = { ar_supervisor: 'billing_ar' };

/**
 * Capabilities platform_admin must always retain — the PUT validator rejects any
 * override that would remove admin from these (prevents locking yourself out).
 */
export const ADMIN_LOCKED_CAPABILITIES = ['system:config', 'users:manage', 'page:permissions'];

export type CapabilityGroup =
  | 'Pages'
  | 'Tickets'
  | 'Dispatch'
  | 'Customers'
  | 'Billing'
  | 'Inventory'
  | 'Locations'
  | 'Routes'
  | 'Rentals'
  | 'Repairs'
  | 'Training'
  | 'Reports'
  | 'Destructive'
  | 'Admin';

export interface CapabilityDef {
  key: string;
  label: string;
  group: CapabilityGroup;
  description: string;
  /** Default roles allowed. platform_admin is implicitly always allowed. */
  defaults: Role[];
}

/**
 * The full capability catalog. Order here drives the Permissions-page layout.
 * Page-view caps (group 'Pages') seed from the previously-hardcoded AppShell
 * role arrays so day-one behavior is unchanged.
 */
export const CAPABILITY_CATALOG: CapabilityDef[] = [
  // ── Tickets ──────────────────────────────────────────────────────────────
  { key: 'tickets:create',      label: 'Create tickets',          group: 'Tickets', description: 'Start new field/shop/training tickets.', defaults: ['field_tech', 'dispatch', 'field_super', 'trainer', 'train_admin', 'platform_admin'] },
  { key: 'tickets:edit_own',    label: 'Edit own tickets',        group: 'Tickets', description: 'Edit tickets the user created.', defaults: ['field_tech', 'dispatch', 'field_super', 'trainer', 'train_admin', 'platform_admin'] },
  { key: 'tickets:edit_all',    label: 'Edit any ticket',         group: 'Tickets', description: 'Edit tickets created by anyone.', defaults: ['field_super', 'platform_admin'] },
  { key: 'tickets:edit_billing',label: 'Edit ticket billing',     group: 'Tickets', description: 'Edit billing lines / rates on tickets.', defaults: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'tickets:complete',    label: 'Complete tickets',        group: 'Tickets', description: 'Mark tickets complete / submit for signature.', defaults: ['field_tech', 'field_super', 'trainer', 'train_admin', 'platform_admin'] },
  { key: 'tickets:approve',     label: 'Approve tickets',         group: 'Tickets', description: 'Approve tickets into the billing queue.', defaults: ['field_super', 'platform_admin'] },
  { key: 'tickets:view_own',    label: 'View own tickets',        group: 'Tickets', description: 'See tickets the user is involved in.', defaults: [...ALL] },
  { key: 'tickets:view_all',    label: 'View all tickets',        group: 'Tickets', description: 'See every ticket in the org.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'train_admin', 'boss', 'platform_admin'] },
  { key: 'tickets:reassign_location', label: 'Reassign ticket location', group: 'Tickets', description: 'Move a ticket to a different pad/well/facility after the fact, regardless of ticket status — for correcting historical data-cleanup mistakes.', defaults: ['platform_admin'] },

  // ── Dispatch ─────────────────────────────────────────────────────────────
  { key: 'dispatch:manage',     label: 'Manage dispatch',         group: 'Dispatch', description: 'Assign work and manage the dispatch board.', defaults: ['dispatch', 'field_super', 'platform_admin'] },

  // ── Customers ────────────────────────────────────────────────────────────
  { key: 'customers:view',      label: 'View customers',          group: 'Customers', description: 'See customer/company records.', defaults: [...ALL] },
  { key: 'customers:manage',    label: 'Manage customers',        group: 'Customers', description: 'Create/edit/merge customer records.', defaults: ['dispatch', 'billing_ar', 'ar_supervisor', 'platform_admin'] },

  // ── Billing ──────────────────────────────────────────────────────────────
  { key: 'billing:profiles',       label: 'Manage billing profiles', group: 'Billing', description: 'Edit customer billing profiles.', defaults: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'billing:create_invoice', label: 'Create invoices',         group: 'Billing', description: 'Generate and edit invoices.', defaults: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'billing:qb_sync',        label: 'QuickBooks sync',         group: 'Billing', description: 'Push/pull QuickBooks.', defaults: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'billing:enverus',        label: 'Enverus submit',          group: 'Billing', description: 'Submit receipts/invoices to Enverus.', defaults: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'billing:bluelion',       label: 'BlueLion push',           group: 'Billing', description: 'Push records to BlueLion.', defaults: ['billing_ar', 'ar_supervisor', 'field_super', 'platform_admin'] },
  { key: 'billing:record_observation', label: 'Record billing observation', group: 'Billing', description: 'Manually attribute a billing-lineage fact (e.g. a disputed status confirmed by phone) when no API status is available. Always attributed to the recording user.', defaults: ['billing_ar', 'ar_supervisor', 'platform_admin'] },

  // ── Inventory & Products ─────────────────────────────────────────────────
  { key: 'inventory:manage',    label: 'Manage inventory/equipment', group: 'Inventory', description: 'Create/edit equipment records.', defaults: ['dispatch', 'field_super', 'platform_admin'] },
  { key: 'products:manage',     label: 'Manage products',            group: 'Inventory', description: 'Edit the product catalog & pricing.', defaults: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'inventory:novara',    label: 'Novara sync admin',          group: 'Inventory', description: 'Map Novara equipment types/schedules to SP products and columns, trigger a sync, and work the review queue.', defaults: ['platform_admin'] },

  // ── Locations ────────────────────────────────────────────────────────────
  { key: 'locations:request',   label: 'Request locations',       group: 'Locations', description: 'Submit a new location/pad for approval.', defaults: ['field_tech', 'dispatch', 'field_super', 'platform_admin'] },
  { key: 'locations:manage',    label: 'Manage locations',        group: 'Locations', description: 'Edit/activate location & pad records.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'locations:approve',   label: 'Approve locations',       group: 'Locations', description: 'Approve requested locations.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'locations:import_dmr',label: 'Import DMR data',         group: 'Locations', description: 'Run the DMR well import.', defaults: ['platform_admin'] },

  // ── Routes ───────────────────────────────────────────────────────────────
  { key: 'routes:manage',       label: 'Manage routes',           group: 'Routes', description: 'Build/optimize service routes.', defaults: ['dispatch', 'field_super', 'boss', 'platform_admin'] },

  // ── Rentals ──────────────────────────────────────────────────────────────
  { key: 'rentals:edit_packages', label: 'Edit rental packages', group: 'Rentals', description: 'Create, edit, and remove customer rental packages and their baseline equipment.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'rentals:release_billing', label: 'Send rentals for billing', group: 'Rentals', description: 'Dashboard "Rental Billing" tab: send open rentals to the billing queue once their tickets are approved.', defaults: ['field_super', 'boss', 'platform_admin'] },
  { key: 'rentals:force_billing_release', label: 'Force rentals into billing', group: 'Rentals', description: 'Put a rental in the billing queue without the field sending it. Skips the ticket-approval gate; a reason is required and recorded.', defaults: ['ar_supervisor', 'platform_admin'] },
  { key: 'rentals:edit',        label: 'Edit rentals',            group: 'Rentals', description: 'Correct anything on an existing rental agreement (with reason).', defaults: ['field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },

  // ── Repairs ──────────────────────────────────────────────────────────────
  { key: 'repairs:manage',      label: 'Manage repairs',          group: 'Repairs', description: 'Manage repair/shop work flow.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'shop_orders:edit',    label: 'Edit shop service work',  group: 'Repairs', description: 'Edit work details (diagnosis, parts, cost) on a shop service work order.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },

  // ── Training (ClassPRO) ──────────────────────────────────────────────────
  { key: 'training:courses',    label: 'Manage course catalog',   group: 'Training', description: 'Edit training course definitions (billing item, cert code, validity, card-on-site).', defaults: ['billing_ar', 'ar_supervisor', 'train_admin', 'platform_admin'] },
  { key: 'training:schedule',   label: 'Training scheduling',     group: 'Training', description: 'Manage training locations, trainers and availability (and, later, scheduled sessions).', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'train_admin', 'boss', 'platform_admin'] },

  // ── Reports ──────────────────────────────────────────────────────────────
  { key: 'reports:ops',         label: 'Ops reports',             group: 'Reports', description: 'View operational reports.', defaults: ['dispatch', 'field_super', 'boss', 'platform_admin'] },
  { key: 'reports:financial',   label: 'Financial reports',       group: 'Reports', description: 'View financial reports.', defaults: ['billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'reports:all',         label: 'All reports',             group: 'Reports', description: 'View every report.', defaults: ['boss', 'platform_admin'] },

  // ── Destructive — soft cancel/void + hard delete per entity ──────────────
  { key: 'invoices:cancel',      label: 'Void invoices',            group: 'Destructive', description: 'Void/cancel an invoice (recoverable; retracts un-synced billing).', defaults: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'invoices:delete',      label: 'Delete invoices (permanent)', group: 'Destructive', description: 'Permanently delete an invoice. No recovery.', defaults: ['platform_admin'] },
  { key: 'tickets:cancel',       label: 'Void tickets',             group: 'Destructive', description: 'Void/nullify a ticket and discard drafts (recoverable tombstone).', defaults: ['billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'tickets:delete',       label: 'Delete tickets (permanent)', group: 'Destructive', description: 'Permanently delete a ticket + children. No recovery.', defaults: ['field_super', 'platform_admin'] },
  { key: 'rentals:cancel',       label: 'Cancel rentals (not-done)', group: 'Destructive', description: 'Close a rental as not-done; returns items, keeps the record, non-billable.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'platform_admin'] },
  { key: 'rentals:delete',       label: 'Delete rentals (permanent)', group: 'Destructive', description: 'Permanently delete a rental agreement + children. No recovery.', defaults: ['platform_admin'] },
  { key: 'shop_orders:cancel',   label: 'Void shop work orders',    group: 'Destructive', description: 'Close a WO with no work done (no billing ticket).', defaults: ['field_super', 'boss', 'platform_admin'] },
  { key: 'shop_orders:waive_billing', label: 'Close shop WOs without billing', group: 'Destructive', description: 'Waive billing with a reason and retract local shop invoices.', defaults: ['platform_admin'] },
  { key: 'shop_orders:force_close', label: 'Force-close shop WOs',  group: 'Destructive', description: 'Force a WO closed and auto-generate its billing ticket.', defaults: ['field_super', 'boss', 'platform_admin'] },
  { key: 'shop_orders:delete',   label: 'Delete shop WOs (permanent)', group: 'Destructive', description: 'Permanently delete a shop work order + children. No recovery.', defaults: ['platform_admin'] },

  // ── Admin ────────────────────────────────────────────────────────────────
  { key: 'users:manage',        label: 'Manage users',            group: 'Admin', description: 'Create users, set roles, PINs, passwords.', defaults: ['platform_admin'] },
  { key: 'system:config',       label: 'System configuration',    group: 'Admin', description: 'Edit board/permissions/system settings.', defaults: ['platform_admin'] },

  // ── Pages (nav visibility) — seeded from the prior AppShell role arrays ───
  { key: 'page:tickets',         label: 'Tickets',          group: 'Pages', description: 'Tickets list.', defaults: [...ALL] },
  { key: 'page:my_jobs',         label: 'My Jobs',          group: 'Pages', description: 'Personal job queue.', defaults: ['field_tech', 'field_super', 'dispatch', 'trainer', 'train_admin', 'boss', 'platform_admin'] },
  { key: 'page:shop',            label: 'Shop Service',     group: 'Pages', description: 'Shop service intake/list.', defaults: ['dispatch', 'field_super', 'field_tech', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:billing',         label: 'Billing',          group: 'Pages', description: 'Billing workspace.', defaults: ['billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:dispatch',        label: 'Dispatch',         group: 'Pages', description: 'Dispatch board.', defaults: ['dispatch', 'field_super', 'platform_admin'] },
  { key: 'page:dashboard',       label: 'Dashboard',        group: 'Pages', description: 'Overview dashboard.', defaults: [...ALL] },
  { key: 'page:ops',             label: 'Ops',              group: 'Pages', description: 'Ops health dashboard.', defaults: ['platform_admin'] },
  { key: 'page:shop_board',      label: 'Shop Board',       group: 'Pages', description: 'Shop kanban board.', defaults: ['dispatch', 'field_super', 'field_tech', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:stale_transfers', label: 'Stale Transfers',  group: 'Pages', description: 'Stale inter-site transfers.', defaults: ['dispatch', 'field_super', 'boss', 'platform_admin'] },
  { key: 'page:rentals',         label: 'Rentals',          group: 'Pages', description: 'Rentals list.', defaults: ['dispatch', 'field_super', 'field_tech', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:coverage',        label: 'Coverage',         group: 'Pages', description: 'Coverage map.', defaults: ['dispatch', 'field_super', 'boss', 'platform_admin'] },
  { key: 'page:routes',          label: 'Routes',           group: 'Pages', description: 'Service routes.', defaults: ['dispatch', 'field_super', 'boss', 'platform_admin'] },
  { key: 'page:approvals',       label: 'Approvals',        group: 'Pages', description: 'Approvals queue.', defaults: ['field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:history',         label: 'Service History',  group: 'Pages', description: 'Service history.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:equipment',       label: 'Equipment',        group: 'Pages', description: 'Equipment records.', defaults: ['dispatch', 'field_super', 'boss', 'platform_admin'] },
  { key: 'page:companies',       label: 'Customers',        group: 'Pages', description: 'Customers page.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:locations',       label: 'Locations',        group: 'Pages', description: 'Locations page.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:products',        label: 'Products',         group: 'Pages', description: 'Products catalog.', defaults: ['billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:cards',           label: 'Card Issuance',    group: 'Pages', description: 'Card issuance.', defaults: ['billing_ar', 'ar_supervisor', 'boss', 'platform_admin'] },
  { key: 'page:admin',           label: 'Admin (Settings)', group: 'Pages', description: 'User/role admin settings.', defaults: ['platform_admin'] },
  { key: 'page:sites',           label: 'Sites',            group: 'Pages', description: 'Site administration.', defaults: ['platform_admin'] },
  { key: 'page:printers',        label: 'Printers',         group: 'Pages', description: 'Printer config.', defaults: ['platform_admin'] },
  { key: 'page:kiosks',          label: 'Kiosks',           group: 'Pages', description: 'Kiosk management.', defaults: ['platform_admin'] },
  { key: 'page:board_settings',  label: 'Board Settings',   group: 'Pages', description: 'Shop board theming/thresholds.', defaults: ['platform_admin'] },
  { key: 'page:permissions',     label: 'Permissions',      group: 'Pages', description: 'This permissions editor.', defaults: ['platform_admin'] },
  { key: 'page:api_keys',        label: 'API Keys',         group: 'Pages', description: 'Issue/revoke v1 API tokens (BlueLion, bolt-ons).', defaults: ['platform_admin'] },
  { key: 'page:novara',          label: 'Novara Sync',      group: 'Pages', description: 'Novara Flex equipment/compliance sync admin.', defaults: ['platform_admin'] },
  { key: 'page:courses',         label: 'Courses',          group: 'Pages', description: 'ClassPRO training course catalog.', defaults: ['billing_ar', 'ar_supervisor', 'trainer', 'train_admin', 'boss', 'platform_admin'] },
  { key: 'page:training',        label: 'Training Setup',   group: 'Pages', description: 'ClassPRO training locations, trainers & availability.', defaults: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'trainer', 'train_admin', 'boss', 'platform_admin'] },
];

/** Code-defined default matrix, derived from the catalog. */
export const DEFAULT_PERMISSIONS: Record<string, Role[]> = Object.fromEntries(
  CAPABILITY_CATALOG.map((c) => [c.key, c.defaults]),
);

const VALID_CAPABILITIES = new Set(CAPABILITY_CATALOG.map((c) => c.key));
export function isValidCapability(cap: string): boolean {
  return VALID_CAPABILITIES.has(cap);
}

// ── Effective-matrix cache ───────────────────────────────────────────────────
let cachedMatrix: Record<string, Role[]> | null = null;

/**
 * Merge stored overrides over the code defaults. Only known capabilities kept.
 *
 * Roles the stored matrix has never seen anywhere (added to the code AFTER the
 * admin last saved — the page persists a dense matrix, every capability) get
 * their code defaults unioned back in. Without this, adding a role (e.g.
 * trainer/train_admin) would ship all-unchecked on any install where the
 * Permissions page was ever saved.
 */
function mergeOverrides(overrides: Record<string, unknown>): Record<string, Role[]> {
  const seenRoles = new Set<string>();
  for (const v of Object.values(overrides)) {
    if (Array.isArray(v)) for (const r of v) if (typeof r === 'string') seenRoles.add(r);
  }
  const unseen = new Set(ALL_ROLES.filter((r) => !seenRoles.has(r)));

  const merged: Record<string, Role[]> = { ...DEFAULT_PERMISSIONS };
  for (const cap of Object.keys(DEFAULT_PERMISSIONS)) {
    const o = overrides[cap];
    if (Array.isArray(o)) {
      const kept = new Set((o as string[]).filter((r): r is Role => ALL.includes(r as Role)));
      for (const r of DEFAULT_PERMISSIONS[cap]) if (unseen.has(r) && !ROLE_INHERITS[r]) kept.add(r);
      for (const r of unseen) {
        const base = ROLE_INHERITS[r];
        if (base && kept.has(base)) kept.add(r);
      }
      merged[cap] = ALL_ROLES.filter((r) => kept.has(r));
    }
  }
  return merged;
}

/** Load (or reload) the effective matrix from the PermissionConfig singleton. */
export async function loadMatrix(): Promise<Record<string, Role[]>> {
  try {
    const row = await prisma.permissionConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    const overrides = (row?.matrix && typeof row.matrix === 'object' ? row.matrix : {}) as Record<string, unknown>;
    cachedMatrix = mergeOverrides(overrides);
  } catch (err) {
    // If the table is missing or DB unreachable, fall back to code defaults so
    // auth keeps working rather than 500-ing every gated route.
    console.error('[permissions] failed to load matrix, using code defaults:', (err as Error).message);
    cachedMatrix = { ...DEFAULT_PERMISSIONS };
  }
  return cachedMatrix;
}

/** Current effective matrix (defaults until loadMatrix() has run). */
export function getEffectiveMatrix(): Record<string, Role[]> {
  return cachedMatrix ?? DEFAULT_PERMISSIONS;
}

/** Drop the cache so the next read reloads from DB. Call after a PUT. */
export function invalidateMatrix(): void {
  cachedMatrix = null;
}

/**
 * Does `role` have `capability`? platform_admin always wins. Unknown roles
 * (e.g. portal `customer`) only get what the matrix explicitly grants.
 */
export function roleHasCapability(role: string | undefined | null, capability: string): boolean {
  if (!role) return false;
  if (role === 'platform_admin') return true;
  const matrix = cachedMatrix ?? DEFAULT_PERMISSIONS;
  const allowed = matrix[capability];
  if (!allowed) return false;
  return allowed.includes(role as Role);
}
