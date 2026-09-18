/**
 * blueLionEnqueue.ts
 *
 * Turns a training ticket's roster — or an Occ Health ticket's fit-test
 * records — into BlueLion sync-queue rows. Called by the ticket.transitioned
 * listener (auto, on completion) and by the manual sync / backfill routes.
 *
 * Rules:
 *   - Only `passed` attendees get a cert pushed (a failed attendee earns none).
 *   - One queue row per cert, keyed by externalId: `sp-tr-<rosterId>` for
 *     training certs, `sp-ft-<fitTestRecordId>` for FIT-TEST certs,
 *     `sp-aud-<fitTestRecordId>` for AUDIO certs (one Occ Health record can
 *     yield both). The unique constraint makes re-enqueues idempotent; `force`
 *     lets the manual route re-push (e.g. after a card number is filled in).
 *   - A course with no BlueLion classCode mapping is enqueued straight to
 *     `needs_attention` (never sent — BlueLion would reject it) so it's visible.
 */

import { prisma } from '../db.js';
import { mapCategoryToAssetKind } from './blueLionClassMap.js';
import { blueLionDocTypeForAttachmentKind } from './equipmentDocuments.js';
import { closeStateOf } from './shopSoftClose.js';
import { resolveClassCode } from './courseCatalog.js';

// Training ticket statuses at/after which the class is "done" and certs are
// real. The listener fires on each transition; enqueue is idempotent, so
// whichever of these a training ticket lands on, the roster gets queued once.
export const FINALIZED_TRAINING_STATUSES = [
  'completed',
  'supervisor_review',
  'awaiting_signature',
  'billing_queue',
  'invoiced',
  'closed',
];

export interface EnqueueResult {
  enqueued: number;
  skipped: number;
  needsAttention: number;
}

// Re-exported from the generated client rather than re-typed by hand. The
// local copy had already drifted once (it was missing 'attachment' the moment
// the enum grew), and a hand-maintained mirror of a schema enum only ever
// drifts in the direction of a compile error nobody expects.
type BlueLionEntityType = import('../db.js').BlueLionEntityType;

// Equipment-inspection outcomes that write a BlueLion ledger record. Only
// terminal outcomes count: a 'pass' (incl. visual-only) and a 'condemn' (DEAD
// record). A 'fail' / 'requires_parts' is mid-flight (routes to repair), and a
// failed FIELD inspection writes NOTHING — it only spawns a Shop WO (Wave 4).
const LEDGER_OUTCOMES = new Set(['pass', 'condemn']);

/**
 * Create (or, with force, reset) the queue row for one cert. Returns false when
 * the row already exists and force is off — the idempotent no-op path.
 */
async function upsertQueueRow(args: {
  entityType: BlueLionEntityType;
  entityId: string;
  externalId: string;
  /** null = no classCode → park as needs_attention instead of pending */
  errorMessage: string | null;
  force?: boolean;
}): Promise<boolean> {
  const existing = await prisma.blueLionSyncQueue.findUnique({
    where: { externalId: args.externalId },
  });
  if (existing && !args.force) return false;

  const initialStatus = args.errorMessage ? 'needs_attention' : 'pending';
  const resultStatus = args.errorMessage ? 'invalid' : null;

  if (existing) {
    // force re-push of an existing row
    await prisma.blueLionSyncQueue.update({
      where: { id: existing.id },
      data: {
        status: initialStatus,
        resultStatus,
        errorMessage: args.errorMessage,
        requestPayload: null,
        responsePayload: null,
        responseStatusCode: null,
        retryCount: 0,
        submittedAt: null,
        respondedAt: null,
        candidates: undefined,
      },
    });
  } else {
    await prisma.blueLionSyncQueue.create({
      data: {
        entityType: args.entityType,
        entityId: args.entityId,
        externalId: args.externalId,
        action: 'push',
        status: initialStatus,
        resultStatus,
        errorMessage: args.errorMessage,
      },
    });
  }
  return true;
}

export async function enqueueTrainingRosterForTicket(
  ticketId: string,
  opts: { force?: boolean } = {},
): Promise<EnqueueResult> {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      ticketType: true,
      trainingRosterRecords: true,
    },
  });

  const result: EnqueueResult = { enqueued: 0, skipped: 0, needsAttention: 0 };
  if (!ticket || ticket.ticketType !== 'training') return result;

  for (const r of ticket.trainingRosterRecords) {
    if (!r.passed) {
      result.skipped++;
      continue;
    }

    const classCode = await resolveClassCode(r.courseName);
    // Unmapped course → can't be sent; park it as needs_attention immediately.
    const errorMessage = classCode
      ? null
      : `No BlueLion classCode mapping for course "${r.courseName}". Set it on the course in the catalog (Admin → Courses) or add a cert type in BlueLion.`;

    const wrote = await upsertQueueRow({
      entityType: 'training',
      entityId: r.id,
      externalId: `sp-tr-${r.id}`,
      errorMessage,
      force: opts.force,
    });

    if (!wrote) result.skipped++;
    else if (classCode) result.enqueued++;
    else result.needsAttention++;
  }

  return result;
}

/** Stable asset externalId — one BlueLion asset per (kind, serial), spec §3.2. */
export function assetExternalId(category: string, serialNumber: string): string {
  return `sp-asset-${mapCategoryToAssetKind(category)}-${serialNumber.trim()}`;
}

/**
 * Ensure a unit-registration (`asset`) queue row exists for this inspection's
 * kind+serial. Idempotent; never forced — a unit registration doesn't change.
 * Also called from the processor for legacy service rows enqueued before the
 * asset stage existed.
 */
export async function ensureAssetRow(insp: {
  id: string;
  category: string;
  serialNumber: string;
}): Promise<boolean> {
  return upsertQueueRow({
    entityType: 'asset',
    entityId: insp.id,
    externalId: assetExternalId(insp.category, insp.serialNumber),
    errorMessage: null,
  });
}

/**
 * Enqueue a LOCKED equipment inspection as a BlueLion service event. Called when
 * an inspection locks (online lock route + offline sync replay). Only locked,
 * terminal-outcome inspections write a record — BlueLion is the unit ledger:
 * field pass, shop pass/visual-only, and condemn (a DEAD record). All other
 * outcomes (and unlocked drafts) are no-ops.
 *
 * Two queue rows ride along per unit: an `asset` registration (one per
 * kind+serial, idempotent on `sp-asset-<kind>-<serial>`) that must sync first —
 * BlueLion returns the assetId the service event references as unitId — and the
 * `equipment_inspection` service row itself (externalId `sp-insp-<id>`, kept
 * from Wave 3 so already-enqueued rows stay idempotent). `force` re-pushes the
 * service row (e.g. after a correction); the asset row is never forced — the
 * unit registration doesn't change.
 */
export async function enqueueInspectionRecord(
  inspectionId: string,
  opts: { force?: boolean } = {},
): Promise<EnqueueResult> {
  const result: EnqueueResult = { enqueued: 0, skipped: 0, needsAttention: 0 };

  const insp = await prisma.equipmentInspection.findUnique({
    where: { id: inspectionId },
    select: {
      id: true, outcome: true, lockedAt: true, serialNumber: true, category: true,
      shopItem: { select: { softClosedAt: true, hardClosesAt: true, status: true, closedById: true } },
    },
  });
  // Only locked, terminal-outcome inspections are real ledger events.
  if (!insp || !insp.lockedAt || !LEDGER_OUTCOMES.has(insp.outcome)) {
    result.skipped++;
    return result;
  }

  // WI-05: a SHOP inspection's push waits for the unit's hard close. The
  // 48-hour window exists so the shop can correct what it just did, and
  // VaultPRO records are immutable — pushing at soft close would mean every
  // correction becomes a contradictory second record in the unit's permanent
  // ledger. shopHardCloseSweep re-calls this once the window shuts.
  //
  // FIELD inspections (no shopItem) are unaffected: they have no soft window.
  if (insp.shopItem && closeStateOf(insp.shopItem) === 'soft') {
    result.skipped++;
    return result;
  }

  // Unit registration first (created before the service row, so the ordered
  // queue processes it earlier). entityId = this inspection; the asset builder
  // reads serial + category from it.
  await ensureAssetRow(insp);

  const wrote = await upsertQueueRow({
    entityType: 'equipment_inspection',
    entityId: insp.id,
    externalId: `sp-insp-${insp.id}`,
    errorMessage: null,
    force: opts.force,
  });
  if (wrote) result.enqueued++;
  else result.skipped++;
  return result;
}

/**
 * Enqueue a per-unit attachment (photo / UE report / Pozi report) as a VaultPRO
 * document push (WI-04).
 *
 * ServicePRO keeps its own copy and stays the immediate read path; this is a
 * background errand. Deliberately NOT awaited on the capture path -- a tech
 * photographing a cracked regulator must never wait on, or be blocked by, an
 * integration two networks away. §2's "bad divorce design": optional and
 * downstream components degrade to a queue, never to a stopped technician.
 *
 * Like the service rows, an `asset` registration rides along so the document
 * has a unit to attach to. Until BlueLion returns that assetId the document row
 * simply stays pending -- that is the normal early state for a freshly
 * photographed unit, not a failure.
 */
export async function enqueueAttachment(
  attachmentId: string,
  opts: { force?: boolean } = {},
): Promise<EnqueueResult> {
  const result: EnqueueResult = { enqueued: 0, skipped: 0, needsAttention: 0 };

  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      kind: true,
      serialNumber: true,
      shopItem: { select: { equipmentCategory: true, serialNumber: true } },
      inspection: { select: { category: true, serialNumber: true } },
    },
  });
  if (!attachment) {
    result.skipped++;
    return result;
  }

  // Only kinds BlueLion has a docType for are worth queueing at all — a row
  // whose only possible outcome is 'skipped' still lands on the Ops dashboard's
  // queue count on the way there. Invoices, packing slips, signatures and
  // loose documents stay ServicePRO-only.
  if (!blueLionDocTypeForAttachmentKind(attachment.kind)) {
    result.skipped++;
    return result;
  }

  // A document is evidence ABOUT A UNIT. With no serial there is nothing in
  // VaultPRO to hang it on, so it stays a ServicePRO-only record rather than
  // being pushed somewhere it cannot be filed.
  const serialNumber =
    attachment.serialNumber
    || attachment.shopItem?.serialNumber
    || attachment.inspection?.serialNumber
    || null;
  const category = attachment.shopItem?.equipmentCategory || attachment.inspection?.category || null;
  if (!serialNumber || !category) {
    result.skipped++;
    return result;
  }

  await ensureAssetRow({ id: attachment.id, category, serialNumber });

  const wrote = await upsertQueueRow({
    entityType: 'attachment',
    entityId: attachment.id,
    externalId: `sp-att-${attachment.id}`,
    errorMessage: null,
    force: opts.force,
  });
  if (wrote) result.enqueued++;
  else result.skipped++;
  return result;
}

/**
 * Enqueue an Occ Health ticket's fit-test records. One record can yield two
 * certs: FIT-TEST (only when the fit test was taken AND passed — a failed test
 * earns no cert) and AUDIO (whenever an audiometric exam happened; baseline vs
 * retest is carried in the cert notes, it isn't pass/fail). Occ Health tickets
 * are ticketType 'training' + serviceSubtype 'fit_test', but the real driver
 * is having fitTestRecords, so we gate on those.
 */
export async function enqueueOccHealthForTicket(
  ticketId: string,
  opts: { force?: boolean } = {},
): Promise<EnqueueResult> {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      ticketType: true,
      fitTestRecords: {
        select: {
          id: true,
          includesFitTest: true,
          includesAudiometric: true,
          passFail: true,
        },
      },
    },
  });

  const result: EnqueueResult = { enqueued: 0, skipped: 0, needsAttention: 0 };
  if (!ticket || ticket.ticketType !== 'training') return result;

  for (const r of ticket.fitTestRecords) {
    if (r.includesFitTest) {
      if (r.passFail === 'pass') {
        const wrote = await upsertQueueRow({
          entityType: 'fit_test',
          entityId: r.id,
          externalId: `sp-ft-${r.id}`,
          errorMessage: null,
          force: opts.force,
        });
        if (wrote) result.enqueued++;
        else result.skipped++;
      } else {
        result.skipped++; // failed fit test — no cert
      }
    }

    if (r.includesAudiometric) {
      const wrote = await upsertQueueRow({
        entityType: 'audiometric',
        entityId: r.id,
        externalId: `sp-aud-${r.id}`,
        errorMessage: null,
        force: opts.force,
      });
      if (wrote) result.enqueued++;
      else result.skipped++;
    }
  }

  return result;
}
