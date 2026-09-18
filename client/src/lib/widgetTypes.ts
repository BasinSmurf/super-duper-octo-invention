// Mirror of server/src/services/widgetCatalog.ts types.
// Keep in sync if you add a widget type.

export type WidgetSize = 'small' | 'medium' | 'large' | 'full'

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
  | 'background_jobs'

export interface WidgetInstance {
  id: string
  type: WidgetType
  size: WidgetSize
  config?: Record<string, unknown>
}

export interface WidgetCatalogEntry {
  type: WidgetType
  label: string
  description: string
  roles: string[]
  sizes: WidgetSize[]
  defaultSize: WidgetSize
  variant?: 'panel' | 'action'
}
