import { api } from '@/lib/api'
import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { RequireSyncingRole } from '@/components/RequireSyncingRole'
import { PermissionsProvider, usePermissions } from '@/contexts/PermissionsContext'
import { SyncProvider } from '@/contexts/SyncContext'
import { LoginPage } from '@/pages/LoginPage'
import { AppShell } from '@/components/AppShell'
import { PortalLayout } from '@/pages/portal/PortalLayout'
import { SwUpdatePrompt } from '@/components/SwUpdatePrompt'
import { DeferredSwUpdater } from '@/components/DeferredSwUpdater'
import { OfflineReadyToast } from '@/components/OfflineReadyToast'
import { KioskLock } from '@/components/KioskLock'
import { initServiceWorker } from '@/lib/sw-register'

// ADR-0005: every page below is its own lazy chunk — the shell (AppShell,
// LoginPage, PortalLayout) and the context providers stay static/eager since
// they're needed on every load; nothing else needs to be in the initial bundle.
const TicketsPage = lazy(() => import('@/pages/TicketsPage').then(m => ({ default: m.TicketsPage })))
const CompaniesPage = lazy(() => import('@/pages/CompaniesPage').then(m => ({ default: m.CompaniesPage })))
const LocationsPage = lazy(() => import('@/pages/LocationsPage').then(m => ({ default: m.LocationsPage })))
const ProductsPage = lazy(() => import('@/pages/ProductsPage').then(m => ({ default: m.ProductsPage })))
const EquipmentPage = lazy(() => import('@/pages/EquipmentPage').then(m => ({ default: m.EquipmentPage })))
const EquipmentDetailPage = lazy(() => import('@/pages/EquipmentDetailPage').then(m => ({ default: m.EquipmentDetailPage })))
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then(m => ({ default: m.DashboardPage })))
const OperationsReportPage = lazy(() => import('@/pages/OperationsReportPage').then(m => ({ default: m.OperationsReportPage })))
const RentalSwapPage = lazy(() => import('@/pages/RentalSwapPage').then(m => ({ default: m.RentalSwapPage })))
const TicketWizard = lazy(() => import('@/pages/TicketWizard').then(m => ({ default: m.TicketWizard })))
const TicketEditPage = lazy(() => import('@/pages/TicketEditPage').then(m => ({ default: m.TicketEditPage })))
const WizardShell = lazy(() => import('@/pages/wizard/WizardShell').then(m => ({ default: m.WizardShell })))
const TicketDetailPage = lazy(() => import('@/pages/TicketDetailPage').then(m => ({ default: m.TicketDetailPage })))
const RentalsPage = lazy(() => import('@/pages/RentalsPage').then(m => ({ default: m.RentalsPage })))
const RentalDetailPage = lazy(() => import('@/pages/RentalDetailPage').then(m => ({ default: m.RentalDetailPage })))
const SiteLogPage = lazy(() => import('@/pages/SiteLogPage').then(m => ({ default: m.SiteLogPage })))
const RentalReturnPage = lazy(() => import('@/pages/RentalReturnPage').then(m => ({ default: m.RentalReturnPage })))
const ShopOrdersPage = lazy(() => import('@/pages/ShopOrdersPage').then(m => ({ default: m.ShopOrdersPage })))
const ShopOrderDetailPage = lazy(() => import('@/pages/ShopOrderDetailPage').then(m => ({ default: m.ShopOrderDetailPage })))
const ShopIntakePage = lazy(() => import('@/pages/ShopIntakePage').then(m => ({ default: m.ShopIntakePage })))
const ShopBoardPage = lazy(() => import('@/pages/ShopBoardPage').then(m => ({ default: m.ShopBoardPage })))
const RentalsBoardPage = lazy(() => import('@/pages/RentalsBoardPage').then(m => ({ default: m.RentalsBoardPage })))
const BillingPage = lazy(() => import('@/pages/BillingPage').then(m => ({ default: m.BillingPage })))
const InvoiceDetailPage = lazy(() => import('@/pages/InvoiceDetailPage').then(m => ({ default: m.InvoiceDetailPage })))
const BillingLineageSearchPage = lazy(() => import('@/pages/BillingLineageSearchPage').then(m => ({ default: m.BillingLineageSearchPage })))
const BillingAttentionListPage = lazy(() => import('@/pages/BillingAttentionListPage').then(m => ({ default: m.BillingAttentionListPage })))
const CoveragePage = lazy(() => import('@/pages/CoveragePage').then(m => ({ default: m.CoveragePage })))
const RoutesPage = lazy(() => import('@/pages/RoutesPage').then(m => ({ default: m.RoutesPage })))
const PadMergePage = lazy(() => import('@/pages/PadMergePage').then(m => ({ default: m.PadMergePage })))
const DmrBrowserPage = lazy(() => import('@/pages/DmrBrowserPage').then(m => ({ default: m.DmrBrowserPage })))
const LocationBuilderPage = lazy(() => import('@/pages/LocationBuilderPage').then(m => ({ default: m.LocationBuilderPage })))
const CompanyDetailPage = lazy(() => import('@/pages/CompanyDetailPage').then(m => ({ default: m.CompanyDetailPage })))
const PadDetailPage = lazy(() => import('@/pages/PadDetailPage').then(m => ({ default: m.PadDetailPage })))
const WellDetailPage = lazy(() => import('@/pages/WellDetailPage').then(m => ({ default: m.WellDetailPage })))
const FieldDetailPage = lazy(() => import('@/pages/FieldDetailPage').then(m => ({ default: m.FieldDetailPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then(m => ({ default: m.SettingsPage })))
const WebhooksPage = lazy(() => import('@/pages/WebhooksPage').then(m => ({ default: m.WebhooksPage })))
const MyAccountPage = lazy(() => import('@/pages/MyAccountPage').then(m => ({ default: m.MyAccountPage })))
const SitesPage = lazy(() => import('@/pages/SitesPage').then(m => ({ default: m.SitesPage })))
const PrintersPage = lazy(() => import('@/pages/PrintersPage').then(m => ({ default: m.PrintersPage })))
const KiosksPage = lazy(() => import('@/pages/KiosksPage').then(m => ({ default: m.KiosksPage })))
const BoardSettingsPage = lazy(() => import('@/pages/BoardSettingsPage').then(m => ({ default: m.BoardSettingsPage })))
const PermissionsPage = lazy(() => import('@/pages/PermissionsPage').then(m => ({ default: m.PermissionsPage })))
const ClaimKioskPage = lazy(() => import('@/pages/ClaimKioskPage').then(m => ({ default: m.ClaimKioskPage })))
const TrainingKioskPage = lazy(() => import('@/pages/TrainingKioskPage').then(m => ({ default: m.TrainingKioskPage })))
const TrainSignInPage = lazy(() => import('@/pages/TrainSignInPage').then(m => ({ default: m.TrainSignInPage })))
const MyJobsPage = lazy(() => import('@/pages/MyJobsPage').then(m => ({ default: m.MyJobsPage })))
const StaleTransfersPage = lazy(() => import('@/pages/StaleTransfersPage').then(m => ({ default: m.StaleTransfersPage })))
const DispatchPage = lazy(() => import('@/pages/DispatchPage').then(m => ({ default: m.DispatchPage })))
const DirectSalePage = lazy(() => import('@/pages/DirectSalePage').then(m => ({ default: m.DirectSalePage })))
const AdminOpsPage = lazy(() => import('@/pages/AdminOpsPage').then(m => ({ default: m.AdminOpsPage })))
const ApiKeysPage = lazy(() => import('@/pages/ApiKeysPage').then(m => ({ default: m.ApiKeysPage })))
const NovaraSyncPage = lazy(() => import('@/pages/NovaraSyncPage').then(m => ({ default: m.NovaraSyncPage })))
const CoursesPage = lazy(() => import('@/pages/CoursesPage').then(m => ({ default: m.CoursesPage })))
const TrainingSetupPage = lazy(() => import('@/pages/TrainingSetupPage').then(m => ({ default: m.TrainingSetupPage })))
const TrainingCalendarPage = lazy(() => import('@/pages/TrainingCalendarPage').then(m => ({ default: m.TrainingCalendarPage })))
const PortalHomePage = lazy(() => import('@/pages/portal/PortalHomePage').then(m => ({ default: m.PortalHomePage })))
const PortalTicketsPage = lazy(() => import('@/pages/portal/PortalTicketsPage').then(m => ({ default: m.PortalTicketsPage })))
const PortalTicketDetailPage = lazy(() => import('@/pages/portal/PortalTicketDetailPage').then(m => ({ default: m.PortalTicketDetailPage })))
const PortalH2sPage = lazy(() => import('@/pages/portal/PortalH2sPage').then(m => ({ default: m.PortalH2sPage })))
const PortalShopPage = lazy(() => import('@/pages/portal/PortalShopPage').then(m => ({ default: m.PortalShopPage })))
const PortalRentalsPage = lazy(() => import('@/pages/portal/PortalRentalsPage').then(m => ({ default: m.PortalRentalsPage })))
const PortalAccountPage = lazy(() => import('@/pages/portal/PortalAccountPage').then(m => ({ default: m.PortalAccountPage })))

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-400 text-lg">Loading...</div>
      </div>
    )
  }

  // Pass the originally-requested URL (path + query) so LoginPage can bounce
  // the user back after they sign in. Critical for kiosk URLs whose query
  // params (?kiosk=1) were getting dropped on the redirect roundtrip.
  if (!user) {
    const next = location.pathname + location.search
    return <Navigate to="/login" replace state={{ from: next }} />
  }
  return <>{children}</>
}

function defaultRouteForRole(role: string | undefined): string {
  // External customer-portal accounts land on their service-history view;
  // they have no access to the internal app.
  if (role === 'customer') return '/portal'
  // Everyone else lands on the unified Dashboard — widgets give each role a
  // tailored "your world" view, with the rest of the app one click away.
  return '/dashboard'
}

// Keeps customer-portal accounts out of the internal app and vice versa.
function StaffRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (user?.role === 'customer') return <Navigate to="/portal" replace />
  return <>{children}</>
}

function CustomerRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (user && user.role !== 'customer' && user.role !== 'platform_admin') return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

function TicketEditRoute() {
  const { user } = useAuth()
  const { id } = useParams()
  const [kind, setKind] = useState<'loading' | 'rental' | 'other' | 'error'>('loading')
  useEffect(() => {
    let cancelled = false
    setKind('loading')
    if (user?.role === 'platform_admin') { setKind('other'); return }
    api.get<{ customData?: { workType?: string }; linkedRentalAgreementId?: string }>(`/tickets/${id}`)
      .then(ticket => { if (!cancelled) setKind(['rental_deploy', 'rental_swap', 'rental_return'].includes(ticket.customData?.workType || '') ? 'rental' : 'other') })
      .catch(() => { if (!cancelled) setKind('error') })
    return () => { cancelled = true }
  }, [id, user?.role])
  if (user?.role === 'platform_admin' || kind === 'rental') return <TicketEditPage />
  if (kind === 'loading') return <p role="status">Loading ticket…</p>
  if (kind === 'error') return <p role="alert">Could not load this ticket for editing. Return to its detail page and retry.</p>
  return <RequireSyncingRole><TicketWizard /></RequireSyncingRole>
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) return null
  if (user) {
    // If the user was bounced here by ProtectedRoute, send them back to where
    // they were trying to go. Otherwise drop them on their role default.
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from || defaultRouteForRole(user.role)} replace />
  }
  return <>{children}</>
}

function IndexRedirect() {
  const { user } = useAuth()
  return <Navigate to={defaultRouteForRole(user?.role)} replace />
}

// ADR-0005: fallback while a lazy page chunk downloads. Deliberately plain —
// this shows for a moment on most navigations, not just slow ones.
function PageSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-slate-400 text-sm">Loading...</div>
    </div>
  )
}

// Route-level page gating. If the user's role lacks the page capability, bounce
// to their default landing page rather than rendering a page they can't use.
// Waits for the matrix to load so we don't redirect on the fallback defaults.
function RequirePage({ cap, children }: { cap: string | string[]; children: React.ReactNode }) {
  const { user } = useAuth()
  const { can, loading } = usePermissions()
  if (loading) return null
  if (!(Array.isArray(cap) ? cap.some(value => can(value)) : can(cap))) return <Navigate to={defaultRouteForRole(user?.role)} replace />
  return <>{children}</>
}

export default function App() {
  const [needRefresh, setNeedRefresh] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)

  useEffect(() => {
    initServiceWorker({
      onNeedRefresh: () => setNeedRefresh(true),
      onOfflineReady: () => setOfflineReady(true),
    })
  }, [])

  const handleOfflineDismiss = useCallback(() => setOfflineReady(false), [])

  return (
    <BrowserRouter>
      <AuthProvider>
        <PermissionsProvider>
        <SyncProvider>
        <Suspense fallback={<PageSpinner />}>
        <Routes>
          <Route
            path="/login"
            element={
              <PublicRoute>
                <LoginPage />
              </PublicRoute>
            }
          />
          {/* Public — no auth required. View-only board for the wall tablet.
              Lives outside the AppShell so the kiosk display gets full screen
              without the sidebar chrome. */}
          <Route path="/shop-board" element={<ShopBoardPage />} />
          {/* Same component, /inhouse scope — Basin's own work. */}
          <Route path="/shop-board/inhouse" element={<ShopBoardPage />} />
          <Route path="/rentals-board" element={<RentalsBoardPage />} />
          {/* Kiosk displays — full-screen, kiosk-token auth, no sidebar. */}
          <Route path="/kiosk/board/:siteSlug" element={<ShopBoardPage />} />
          <Route path="/kiosk/inhouse/:siteSlug" element={<ShopBoardPage />} />
          <Route path="/kiosk/station/:siteSlug/:stationFilter" element={<ShopBoardPage />} />
          {/* Rentals board kiosks: per site, per pickup type. Two provisioned
              roles (RENTALS_DISPATCH / RENTALS_WALKIN) point here; the server
              re-derives both filters from the device token, so the path
              segments are for the operator reading the URL, not for auth. */}
          <Route path="/kiosk/rentals/:siteSlug/:pickupType" element={<RentalsBoardPage />} />
          <Route path="/kiosk/claim/:siteSlug" element={<ClaimKioskPage />} />
          <Route path="/kiosk/training/:siteSlug" element={<TrainingKioskPage />} />

          {/* #13 Training QR sign-in — public, keyed by per-class token.
              Students land here from the QR on their own phones. */}
          <Route path="/train/:token" element={<TrainSignInPage />} />

          {/* Customer portal — external read-only accounts. Lives outside the
              AppShell so customers never see the internal navigation. */}
          <Route
            element={
              <ProtectedRoute>
                <CustomerRoute>
                  <PortalLayout />
                </CustomerRoute>
              </ProtectedRoute>
            }
          >
            <Route path="/portal" element={<PortalHomePage />} />
            <Route path="/portal/service" element={<PortalTicketsPage />} />
            <Route path="/portal/shop" element={<PortalShopPage />} />
            <Route path="/portal/rentals" element={<PortalRentalsPage />} />
            <Route path="/portal/account" element={<PortalAccountPage />} />
            <Route path="/portal/h2s" element={<PortalH2sPage />} />
            <Route path="/portal/tickets/:id" element={<PortalTicketDetailPage />} />
          </Route>

          <Route
            element={
              <ProtectedRoute>
                <StaffRoute>
                  <AppShell />
                </StaffRoute>
              </ProtectedRoute>
            }
          >
            <Route index element={<IndexRedirect />} />
            <Route path="/tickets" element={<RequirePage cap="page:tickets"><TicketsPage /></RequirePage>} />
            <Route path="/tickets/swap" element={<RequireSyncingRole><RentalSwapPage /></RequireSyncingRole>} />
            <Route path="/tickets/new" element={<RequireSyncingRole><TicketWizard /></RequireSyncingRole>} />
            {/* ADR-0013 division-first entry point (strangler) — delegates to
                /tickets/new?type=… for each work type. Parallel to the direct
                entry above until every work type is extracted. */}
            <Route path="/tickets/start" element={<RequireSyncingRole><WizardShell /></RequireSyncingRole>} />
            <Route path="/tickets/:id" element={<TicketDetailPage />} />
            <Route path="/tickets/:id/edit" element={<TicketEditRoute />} />
            <Route path="/companies" element={<RequirePage cap="page:companies"><CompaniesPage /></RequirePage>} />
            <Route path="/companies/:id" element={<CompanyDetailPage />} />
            <Route path="/locations" element={<RequirePage cap="page:locations"><LocationsPage /></RequirePage>} />
            <Route path="/locations/pads/:id" element={<PadDetailPage />} />
            <Route path="/locations/wells/:id" element={<WellDetailPage />} />
            <Route path="/locations/fields/:id" element={<FieldDetailPage />} />
            <Route path="/locations/merge" element={<PadMergePage />} />
            <Route path="/locations/builder" element={<LocationBuilderPage />} />
            <Route path="/locations/dmr" element={<DmrBrowserPage />} />
            <Route path="/products" element={<RequirePage cap="page:products"><ProductsPage /></RequirePage>} />
            <Route path="/equipment" element={<RequirePage cap="page:equipment"><EquipmentPage /></RequirePage>} />
            <Route path="/equipment/:id" element={<EquipmentDetailPage />} />
            <Route path="/rentals" element={<RequirePage cap="page:rentals"><RentalsPage /></RequirePage>} />
            <Route path="/rentals/:id" element={<RentalDetailPage />} />
            <Route path="/rentals/:id/log" element={<SiteLogPage />} />
            {/* D4 -> Return (ADR-0013, net-new) — item-level partial return,
                reached from the wizard shell via a hard redirect (no work-type
                hand-off needed since this isn't the ticket monolith). */}
            <Route path="/rentals/return" element={<RentalReturnPage />} />
            <Route path="/shop" element={<RequirePage cap="page:shop"><ShopOrdersPage /></RequirePage>} />
            <Route path="/my-jobs" element={<RequirePage cap="page:my_jobs"><MyJobsPage /></RequirePage>} />
            <Route path="/stale-transfers" element={<RequirePage cap="page:stale_transfers"><StaleTransfersPage /></RequirePage>} />
            <Route path="/shop/intake" element={<ShopIntakePage />} />
            <Route path="/shop/:id" element={<ShopOrderDetailPage />} />
            <Route path="/pos" element={<DirectSalePage />} />
            <Route path="/billing" element={<RequirePage cap="page:billing"><BillingPage /></RequirePage>} />
            <Route path="/billing/lineage" element={<RequirePage cap={["page:billing", "page:tickets"]}><BillingLineageSearchPage /></RequirePage>} />
            <Route path="/billing/attention" element={<RequirePage cap="page:billing"><BillingAttentionListPage /></RequirePage>} />
            <Route path="/billing/:id" element={<InvoiceDetailPage />} />
            <Route path="/dispatch" element={<RequirePage cap="page:dispatch"><DispatchPage /></RequirePage>} />
            <Route path="/coverage" element={<RequirePage cap="page:coverage"><CoveragePage /></RequirePage>} />
            <Route path="/routes" element={<RequirePage cap="page:routes"><RoutesPage /></RequirePage>} />
            <Route path="/home" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/operations-report" element={<RequirePage cap="tickets:view_all"><OperationsReportPage /></RequirePage>} />
            <Route path="/account" element={<MyAccountPage />} />
            <Route path="/ops" element={<Navigate to="/admin/ops" replace />} />
            <Route path="/calendar" element={<Navigate to="/training/calendar" replace />} />
            <Route path="/admin/ops" element={<RequirePage cap="page:ops"><AdminOpsPage /></RequirePage>} />
            <Route path="/sites" element={<RequirePage cap="page:sites"><SitesPage /></RequirePage>} />
            <Route path="/printers" element={<RequirePage cap="page:printers"><PrintersPage /></RequirePage>} />
            <Route path="/kiosks" element={<RequirePage cap="page:kiosks"><KiosksPage /></RequirePage>} />
            <Route path="/board-settings" element={<RequirePage cap="page:board_settings"><BoardSettingsPage /></RequirePage>} />
            <Route path="/admin/permissions" element={<RequirePage cap="page:permissions"><PermissionsPage /></RequirePage>} />
            <Route path="/admin/webhooks" element={<RequirePage cap="system:config"><WebhooksPage /></RequirePage>} />
            <Route path="/admin/api-keys" element={<RequirePage cap="page:api_keys"><ApiKeysPage /></RequirePage>} />
            <Route path="/admin/novara" element={<RequirePage cap="page:novara"><NovaraSyncPage /></RequirePage>} />
            <Route path="/admin/courses" element={<RequirePage cap="page:courses"><CoursesPage /></RequirePage>} />
            <Route path="/admin/training" element={<RequirePage cap="page:training"><TrainingSetupPage /></RequirePage>} />
            <Route path="/training/calendar" element={<RequirePage cap="page:training"><TrainingCalendarPage /></RequirePage>} />
            <Route path="/boards/:siteSlug" element={<ShopBoardPage />} />
            <Route path="/boards/:siteSlug/inhouse" element={<ShopBoardPage />} />
            <Route path="/settings" element={<RequirePage cap="page:admin"><SettingsPage /></RequirePage>} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        </Suspense>

        {/* Device-scoped login gate + idle logout for CLAIM (intake) kiosks. */}
        <KioskLock />

        {/* PWA update & offline UI */}
        <DeferredSwUpdater pending={needRefresh} />
        <SwUpdatePrompt show={needRefresh} />
        <OfflineReadyToast show={offlineReady} onDismiss={handleOfflineDismiss} />
        </SyncProvider>
        </PermissionsProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
