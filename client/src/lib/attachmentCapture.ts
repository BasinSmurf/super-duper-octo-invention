/**
 * Which attachment-capture buttons a surface offers.
 *
 * Capture options are contextual. Commercial paperwork stays on the shop
 * ticket; condition evidence follows the serial through the two-hop pipeline.
 *
 * That distinction is the point. A tech at the bench should not be offered
 * "Vendor Invoice" on the 95% of units that never leave the building, and a
 * receiving counter should not have to hunt for it under "Other". Same data,
 * different doors.
 *
 * Lives in its own module rather than beside the component because exporting
 * constants from a component file breaks React fast-refresh.
 */

import type { AttachmentKind } from './attachments'

export interface CaptureOption {
  kind: AttachmentKind
  label: string
  /** Opens the camera rather than a file picker. */
  camera?: boolean
}

/** The bench set — what a tech attaches while working a unit. */
export const BENCH_CAPTURE: CaptureOption[] = [
  { kind: 'photo', label: 'Photo', camera: true },
  { kind: 'ue_report', label: 'UE Report' },
  { kind: 'pozi_report', label: 'Posi-Check' },
  { kind: 'document', label: 'Other' },
]

/**
 * The receiving-counter set (WI-09). The vendor's invoice and paperwork from
 * testing someone else performed arrive together, but have different homes.
 * This set is serial evidence; invoices and packing slips are ticket paperwork.
 */
export const VENDOR_RECEIVE_CAPTURE: CaptureOption[] = [
  { kind: 'test_paperwork', label: 'Test Paperwork' },
  { kind: 'photo', label: 'Photo', camera: true },
  { kind: 'document', label: 'Other' },
]
