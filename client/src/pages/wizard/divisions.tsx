// divisions.tsx — ADR-0013 division-first config for the new ticket wizard.
//
// The FIELD wizard top level is 4 division buttons (D3 / D4 / D6 / Shop Fill),
// each with a subhead listing "types of work you find here". Picking a division
// reveals its work-types; picking a work-type delegates (for now) to the
// existing /tickets/new?type=… flow (strangler), or redirects out.
//
// Shop Service / Direct Sale intentionally do NOT appear here — they live on
// app-switcher surfaces, not the field wizard.

import type { LucideIcon } from 'lucide-react'
import type { QbDivision } from '@/lib/qbDivision'
import { Wind, FlaskConical, ShieldCheck, Caravan, ClipboardCheck, Truck, PackageCheck, RotateCcw, ClipboardList } from 'lucide-react'

// Existing wizard WorkType keys (the ?type= hand-off target).
export type WorkTypeKey = 'field_service' | 'field_inspection' | 'd3_combined' | 'ih_testing' | 'air_fill' | 'rental' | 'fit_test'

export interface WorkEntry {
  label: string
  desc: string
  icon: LucideIcon
  /** Delegates to /tickets/new?type=<workType> (+ optional ?service=). */
  workType?: WorkTypeKey
  /** field_service sub-type (cascade_air | gas_detection | on_site_services | general). */
  serviceType?: string
  /** Finer sub-selection within a service type (e.g. on_site_services → manned_trailer). */
  subtype?: string
  /** Hard redirect instead of the wizard (e.g. a different surface). */
  redirectTo?: string
  /** Not built yet — shown disabled. */
  comingSoon?: boolean
}

export interface Division {
  id: 'D3' | 'D4' | 'D6' | 'D8' | 'SHOP_FILL'
  label: string
  subhead: string // "types of work you find here"
  icon: LucideIcon
  /**
   * ADR-0017 — the QB service division everything under this tile bills under.
   * Declared here, once, so the tech never makes the bookkeeping decision and
   * one ticket can only ever carry one division. WizardShell stamps it onto the
   * hand-off URL; TicketWizard puts it on the ticket.
   */
  qbDivision: QbDivision
  entries: WorkEntry[]
}

export const DIVISIONS: Division[] = [
  {
    id: 'D3',
    qbDivision: 'D3',
    label: 'D3',
    subhead: 'Air systems, gas detection, IH',
    icon: Wind,
    entries: [
      { label: 'Air System', desc: 'Cascade air service (inspection can stack with repairs)', icon: Wind, workType: 'field_service', serviceType: 'cascade_air' },
      { label: 'Combined Visit', desc: 'Air, IH, and gas detection on one customer/location entry', icon: ClipboardList, workType: 'd3_combined' },
      { label: 'IH Testing', desc: 'H₂S, O₂/VOC, sampling', icon: FlaskConical, workType: 'ih_testing' },
      { label: 'Gas Detection', desc: 'Monitors, bump test, calibration', icon: ShieldCheck, workType: 'field_service', serviceType: 'gas_detection' },
      { label: 'Other / General Service', desc: "Doesn't quite fit — add billable lines + notes", icon: ClipboardList, workType: 'field_service', serviceType: 'general' },
    ],
  },
  {
    id: 'D4',
    qbDivision: 'D4',
    label: 'D4',
    subhead: 'Rentals & on-site services',
    icon: Caravan,
    entries: [
      { label: 'On Site Services', desc: 'On-site work (incl. manned trailer)', icon: Truck, workType: 'field_service', serviceType: 'on_site_services' },
      { label: 'Deploy', desc: 'Hitch up a dispatched rental and head out', icon: PackageCheck, workType: 'rental' },
      // Shortcut straight to the manned-trailer daily log (today it lives under
      // On Site Services > Manned Trailer). Not net-new — just a faster door.
      { label: 'Daily Ticket', desc: 'Manned-trailer daily log (shortcut)', icon: ClipboardCheck, workType: 'field_service', serviceType: 'on_site_services', subtype: 'manned_trailer' },
      // Net-new: return rental gear with item selection (partial OK — e.g. just
      // monitors today). Distinct from "Return & Close" which ends the rental.
      { label: 'Return', desc: 'Return gear — partial OK, or Finish Job to close it out', icon: RotateCcw, redirectTo: '/rentals/return' },
      { label: 'Other / General Service', desc: "Doesn't quite fit — add billable lines + notes", icon: ClipboardList, workType: 'field_service', serviceType: 'general' },
    ],
  },
  {
    id: 'D6',
    qbDivision: 'D6',
    label: 'D6 Inspection',
    subhead: 'Equipment inspection → shop as needed',
    icon: ClipboardCheck,
    entries: [
      { label: 'Equipment Inspection', desc: 'Inspect field equipment; failed units transfer to the shop', icon: ClipboardCheck, workType: 'field_inspection' },
      { label: 'Other / General Service', desc: "T&M field ticket that bills under D6", icon: ClipboardList, workType: 'field_service', serviceType: 'general' },
    ],
  },
  {
    id: 'D8',
    qbDivision: 'D8',
    label: 'Occ Health',
    subhead: 'Fit testing & audiometric',
    icon: ShieldCheck,
    entries: [
      { label: 'Fit Test / Audiometric', desc: 'Occ Health visit for one or both services', icon: ShieldCheck, workType: 'fit_test' },
    ],
  },
  {
    id: 'SHOP_FILL',
    // ADR-0017: in-shop air bills as safety service (D3), not FEX.
    qbDivision: 'D3',
    label: 'Shop Fill',
    subhead: 'In-shop air fills',
    icon: Wind,
    entries: [
      { label: 'Air Fill', desc: 'Truck fills and cascades — in shop only', icon: Wind, workType: 'air_fill' },
    ],
  },
]
