import { api } from './api'
import type { WidgetCatalogEntry, WidgetInstance } from './widgetTypes'

// Workbox NetworkFirst caches /api/ responses; without cache-busting, a
// just-saved layout can be replaced by a stale GET on the next mount.
const bust = () => `?t=${Date.now()}`

export const dashboardApi = {
  getCatalog: () =>
    api.get<{ widgets: WidgetCatalogEntry[] }>(`/dashboard/catalog${bust()}`),

  getWidgets: () =>
    api.get<{ widgets: WidgetInstance[]; isDefault: boolean }>(
      `/dashboard/widgets${bust()}`,
    ),

  saveWidgets: (widgets: WidgetInstance[]) =>
    api.put<{ widgets: WidgetInstance[]; isDefault: boolean }>(
      '/dashboard/widgets',
      { widgets },
    ),

  resetWidgets: () =>
    api.delete<{ widgets: WidgetInstance[]; isDefault: boolean }>(
      '/dashboard/widgets',
    ),
}
