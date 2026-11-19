/**
 * Widget Catalog
 *
 * Single source of truth for:
 *   - which widget types exist
 *   - which roles may use each widget
 *   - per-role baseline layout (shown when user has no custom layout)
 *
 * The client renders widgets by `type`; each widget has its own data
 * endpoint elsewhere (or pulls from existing endpoints). This file is
 * metadata + baselines only — no data fetching.
 */

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

export type WidgetSize = 'small' | 'medium' | 'large' | 'full';

export type WidgetType =
  | 'my_tickets'
  | 'quick_actions'
  | 'unassigned_tickets'
  | 'coverage_status'
  | 'team_activity'
  | 'pending_location_requests'
  | 'approval_queue'
  | 'ready_to_invoice'
  | 'enverus_status'
  | 'qb_sync_queue'
  | 'internal_shop_value'
  | 'revenue_summary'
  | 'ticket_volume'
  | 'activity_summary'
  | 'shop_aging'
  | 'follow_ups_due'
  | 'background_jobs';

export interface WidgetInstance {
  id: string;                // nanoid from client; server accepts any non-empty string
  type: WidgetType;
  size: WidgetSize;
  config?: Record<string, unknown>;
}

export interface WidgetCatalogEntry {
  type: WidgetType;
  label: string;
  description: string;
  roles: Role[];
  sizes: WidgetSize[];
  defaultSize: WidgetSize;
  /** Optional — widget is rendered as an eye-catching action button, not a panel */
  variant?: 'panel' | 'action';
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const WIDGET_CATALOG: WidgetCatalogEntry[] = [
  { type: 'internal_shop_value', label: 'Internal Shop — Retail Value', description: 'Retail value of completed internal shop work; never billed', roles: ['boss', 'billing_ar', 'ar_supervisor', 'platform_admin'], sizes: ['large', 'full'], defaultSize: 'large' },
  {
    type: 'my_tickets',
    label: 'My Tickets',
    description: 'Open and in-progress tickets assigned to you',
    roles: ['field_tech', 'dispatch', 'field_super', 'trainer', 'train_admin'],
    sizes: ['medium', 'large', 'full'],
    defaultSize: 'large',
  },
  {
    type: 'quick_actions',
    label: 'Quick Actions',
    description: 'New Ticket, Scan Barcode, and shortcuts for common tasks',
    roles: ['field_tech', 'dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'trainer', 'train_admin', 'platform_admin'],
    sizes: ['small', 'medium'],
    defaultSize: 'medium',
  },
  {
    type: 'unassigned_tickets',
    label: 'Unassigned Tickets',
    description: 'Tickets in the queue that still need a tech',
    roles: ['dispatch', 'field_super', 'platform_admin'],
    sizes: ['medium', 'large'],
    defaultSize: 'medium',
  },
  {
    type: 'coverage_status',
    label: 'Coverage Status',
    description: 'Active H2S coverage assignments by field',
    roles: ['dispatch', 'field_super', 'boss', 'platform_admin'],
    sizes: ['medium', 'large'],
    defaultSize: 'medium',
  },
  {
    type: 'team_activity',
    label: 'Team Activity',
    description: "Today's tickets grouped by tech",
    roles: ['dispatch', 'field_super', 'boss', 'platform_admin'],
    sizes: ['medium', 'large', 'full'],
    defaultSize: 'large',
  },
  {
    type: 'pending_location_requests',
    label: 'Pending Location Requests',
    description: 'Field-requested locations waiting for approval — acts as a red alert button when count > 0',
    roles: ['dispatch', 'field_super', 'platform_admin'],
    sizes: ['small'],
    defaultSize: 'small',
    variant: 'action',
  },
  {
    type: 'approval_queue',
    label: 'Approval Queue',
    description: 'Tickets awaiting supervisor review',
    roles: ['field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'],
    sizes: ['medium', 'large'],
    defaultSize: 'medium',
  },
  {
    type: 'ready_to_invoice',
    label: 'Ready to Invoice',
    description: 'Completed tickets + closed shop WOs that have not yet been billed',
    roles: ['field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'],
    sizes: ['medium', 'large'],
    defaultSize: 'medium',
  },
  {
    type: 'enverus_status',
    label: 'Enverus Status',
    description: 'Recent receipt/invoice submissions and their acceptance state',
    roles: ['billing_ar', 'ar_supervisor', 'boss', 'platform_admin'],
    sizes: ['medium', 'large'],
    defaultSize: 'medium',
  },
  {
    type: 'qb_sync_queue',
    label: 'QuickBooks Sync',
    description: 'Approved invoices, queued pushes and sales orders awaiting conversion',
    roles: ['billing_ar', 'ar_supervisor', 'boss', 'platform_admin'],
    sizes: ['small', 'medium'],
    defaultSize: 'small',
  },
  {
    // The supervisor (#126) has published a snapshot at
    // /api/admin/ops/processors since it shipped, and nothing ever read it.
    // A processor that quietly dies is exactly the failure you want to notice
    // without going looking, so it belongs on the dashboard rather than behind
    // a click on the Ops page.
    //
    // platform_admin only, matching page:ops on the endpoint itself -- offering
    // this to a role that would only get a 403 is worse than not offering it.
    type: 'background_jobs',
    label: 'Background Jobs',
    description: 'Which background processors are beating, and which have stalled',
    roles: ['platform_admin'],
    sizes: ['small', 'medium'],
    defaultSize: 'small',
  },
  {
    type: 'revenue_summary',
    label: 'Revenue Summary',
    description: 'Today / WTD / MTD revenue totals',
    roles: ['billing_ar', 'ar_supervisor', 'boss', 'platform_admin'],
    sizes: ['small', 'medium'],
    defaultSize: 'medium',
  },
  {
    type: 'ticket_volume',
    label: 'Ticket Volume',
    description: 'Tickets by service date over the last 30 Central-time calendar days',
    roles: ['dispatch', 'field_super', 'boss', 'platform_admin'],
    sizes: ['medium', 'large'],
    defaultSize: 'large',
  },
  {
    type: 'activity_summary',
    label: 'Activity Summary',
    description: 'Tickets closed + dollars billed, today / this week / this month',
    roles: ['dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'],
    sizes: ['small', 'medium'],
    defaultSize: 'medium',
  },
  {
    // One type, three instances. The bucket lives in per-instance config, so a
    // user's Open / On Hold / Waiting widgets each remember their own "older
    // than" filter -- which is what "persists per user, per widget" needs, and
    // what three separate types could not give without triplicating the code.
    type: 'shop_aging',
    label: 'Shop Aging',
    description: 'Open / On Hold / Waiting-on-pickup shop units, filtered by age',
    roles: ['field_tech', 'dispatch', 'field_super', 'billing_ar', 'ar_supervisor', 'boss', 'platform_admin'],
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'medium',
  },
  {
    // WI-10. Pairs with Shop Aging: "waiting more than 30 days" is a much
    // smaller fire when the card carries an ETA somebody actually promised.
    //
    // Supervisor-facing roles only. A field tech chasing their own jobs is a
    // fine idea and is not what this widget is -- it is a cross-branch queue of
    // commitments that have come due, which is a supervisor's question.
    type: 'follow_ups_due',
    label: 'Due for Follow-up',
    description: 'Shop jobs whose promised call-back or vendor ETA has passed',
    roles: ['dispatch', 'field_super', 'boss', 'platform_admin'],
    sizes: ['small', 'medium', 'large'],
    defaultSize: 'medium',
  },
];

// ---------------------------------------------------------------------------
// Per-role baselines (used when user.dashboardWidgets is null)
// ---------------------------------------------------------------------------

/**
 * Stable placeholder IDs for baseline widgets. Client will replace these
 * with real nanoids the first time the user saves, but baseline IDs must
 * be distinct so React keys don't collide if two widgets share a type.
 */
function baseline(type: WidgetType, size?: WidgetSize): WidgetInstance {
  const entry = WIDGET_CATALOG.find(w => w.type === type);
  return {
    id: `baseline_${type}`,
    type,
    size: size ?? entry?.defaultSize ?? 'medium',
  };
}

/**
 * The three aging widgets (WI-03), pre-seeded as one row. Distinct ids because
 * they share a type -- `baseline()` alone would collide on all three.
 */
function agingBaselines(): WidgetInstance[] {
  return (['open', 'on_hold', 'waiting'] as const).map((bucket) => ({
    id: `baseline_shop_aging_${bucket}`,
    type: 'shop_aging' as WidgetType,
    size: 'small' as WidgetSize,
    config: { bucket, olderThanDays: 30 },
  }));
}

export const BASELINE_LAYOUTS: Record<Role, WidgetInstance[]> = {
  field_tech: [
    baseline('my_tickets'),
    baseline('quick_actions'),
    ...agingBaselines(),
  ],
  dispatch: [
    baseline('unassigned_tickets'),
    baseline('pending_location_requests'),
    baseline('coverage_status'),
    baseline('team_activity'),
  ],
  field_super: [
    baseline('approval_queue'),
    baseline('pending_location_requests'),
    baseline('team_activity'),
    baseline('unassigned_tickets'),
    ...agingBaselines(),
  ],
  billing_ar: [
    baseline('approval_queue'),
    baseline('ready_to_invoice'),
    baseline('enverus_status'),
  ],
  // Same desk as billing_ar; the role differs in what it may force, not in
  // what it watches.
  ar_supervisor: [
    baseline('approval_queue'),
    baseline('ready_to_invoice'),
    baseline('enverus_status'),
  ],
  trainer: [
    baseline('my_tickets'),
    baseline('quick_actions'),
  ],
  train_admin: [
    baseline('my_tickets'),
    baseline('quick_actions'),
  ],
  boss: [
    baseline('internal_shop_value'),
    baseline('activity_summary'),
    baseline('revenue_summary'),
    baseline('ticket_volume'),
    baseline('ready_to_invoice'),
  ],
  // Was empty — a platform_admin's first dashboard showed nothing at all.
  // Job health is the one thing that role should see without configuring it.
  platform_admin: [
    baseline('internal_shop_value'),
    baseline('background_jobs'),
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Catalog entries visible to a given role */
export function catalogForRole(role: string): WidgetCatalogEntry[] {
  return WIDGET_CATALOG.filter(w => w.roles.includes(role as Role));
}

/** Baseline layout for a role (empty array if unknown role) */
export function baselineForRole(role: string): WidgetInstance[] {
  return BASELINE_LAYOUTS[role as Role] ?? [];
}

/**
 * Validate + normalize a posted widget array. Strips unknown types,
 * drops widgets the role isn't allowed to see, coerces sizes to the
 * catalog's allowed set. Throws on structural problems so the route
 * can 400.
 */
export function validateWidgets(widgets: unknown, role: string): WidgetInstance[] {
  if (!Array.isArray(widgets)) {
    throw new Error('widgets must be an array');
  }
  if (widgets.length > 50) {
    throw new Error('Too many widgets (max 50)');
  }

  const allowedTypes = new Set(catalogForRole(role).map(w => w.type));
  const result: WidgetInstance[] = [];
  const seenIds = new Set<string>();

  for (const raw of widgets) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as Partial<WidgetInstance>;

    if (typeof w.id !== 'string' || !w.id.trim()) {
      throw new Error('Each widget requires a non-empty id');
    }
    if (seenIds.has(w.id)) {
      throw new Error(`Duplicate widget id: ${w.id}`);
    }
    if (typeof w.type !== 'string' || !allowedTypes.has(w.type as WidgetType)) {
      // Silently drop — role likely changed since layout was saved
      continue;
    }

    const entry = WIDGET_CATALOG.find(c => c.type === w.type)!;
    const size: WidgetSize = entry.sizes.includes(w.size as WidgetSize)
      ? (w.size as WidgetSize)
      : entry.defaultSize;

    const config =
      w.config && typeof w.config === 'object' && !Array.isArray(w.config)
        ? (w.config as Record<string, unknown>)
        : undefined;

    seenIds.add(w.id);
    result.push({ id: w.id, type: w.type as WidgetType, size, ...(config ? { config } : {}) });
  }

  return result;
}
