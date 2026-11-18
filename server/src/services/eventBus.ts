/**
 * eventBus.ts
 *
 * Tiny in-process pub/sub for domain events. Used to decouple side effects
 * (approvals engine, signature triggers, QB queue, Enverus queue) from the
 * state-machine code paths that produce them.
 *
 * Stays in-process by design — no Redis pub/sub yet. If we add a second
 * API instance behind a load balancer, listeners will fire only on the
 * instance that handled the originating request. That's acceptable for
 * now: Sundog runs single-instance in prod, and most listeners are
 * idempotent (they re-check DB state before acting).
 *
 * Listener errors are caught + logged so one bad handler can't take out
 * the others. Order is registration order.
 */

import type { RentalComposition } from './rentalComposition.js';

export type SundogEventMap = {
  /** A ServiceTicket changed status. Emitted from the transition handlers. */
  'ticket.transitioned': {
    ticketId: string;
    fromStatus: string;
    toStatus: string;
    actorUserId: string | null; // null = system (auto-approval, etc.)
    reason?: string;
    bulk?: boolean;
  };

  /** Enverus receipt for a ServiceTicket transitioned to Approved. */
  'enverus.receipt.approved': {
    ticketId: string;
    queueEntryId: string;
    approvedAt: string; // ISO
  };

  /** Enverus receipt for a ServiceTicket was Disputed by the buyer. */
  'enverus.receipt.disputed': {
    ticketId: string;
    queueEntryId: string;
    disputedBy: string | null;
    disputedAt: string; // ISO
  };

  /** Enverus invoice (Invoice or PIDX-rip field_ticket) was approved/accepted. */
  'enverus.invoice.approved': {
    invoiceId: string;
    queueEntryId: string;
    invoiceNumber: string | null;
    sourceEntityType: 'invoice' | 'field_ticket';
    approvedAt: string; // ISO
  };

  /** Enverus invoice was disputed/rejected by buyer. */
  'enverus.invoice.disputed': {
    invoiceId: string;
    queueEntryId: string;
    invoiceNumber: string | null;
    sourceEntityType: 'invoice' | 'field_ticket';
    disputedBy: string | null;
    disputedAt: string; // ISO
  };

  /** Receipt status moved to a non-terminal value we don't have a dedicated
   *  event for (e.g. InReview, Pending). Listeners can update timestamps or
   *  surface "buyer is looking at it" badges. Polling continues. */
  'enverus.receipt.status_flipped': {
    ticketId: string;
    queueEntryId: string;
    fromStatus: string | null;
    toStatus: string;
    flippedAt: string; // ISO
  };

  /** Receipt was paid by the buyer — terminal positive after Approved. */
  'enverus.receipt.paid': {
    ticketId: string;
    queueEntryId: string;
    paidAt: string; // ISO
  };

  /** Invoice (or PIDX-rip field_ticket) status moved to a non-terminal value
   *  we don't have a dedicated event for. Polling continues. */
  'enverus.invoice.status_flipped': {
    invoiceId: string;
    queueEntryId: string;
    invoiceNumber: string | null;
    sourceEntityType: 'invoice' | 'field_ticket';
    fromStatus: string | null;
    toStatus: string;
    flippedAt: string; // ISO
  };

  /** Invoice was paid by the buyer — terminal positive. */
  'enverus.invoice.paid': {
    invoiceId: string;
    queueEntryId: string;
    invoiceNumber: string | null;
    sourceEntityType: 'invoice' | 'field_ticket';
    paidAt: string; // ISO
  };

  /** A training cert was accepted by BlueLion (added or idempotent-skipped).
   *  Carries the BlueLion person id + training sequence now stored on the
   *  roster record. */
  'bluelion.training.synced': {
    rosterRecordId: string;
    ticketId: string;
    externalId: string;
    personId: string | null;
    trainingSeq: number | null;
    syncedAt: string; // ISO
  };

  /** A training cert push needs a human: BlueLion returned `ambiguous`
   *  (multiple matching persons) or `invalid` (bad/unmapped classCode, etc.).
   *  The queue row holds candidates / the error for resolution. */
  'bluelion.training.needs_attention': {
    rosterRecordId: string;
    ticketId: string;
    externalId: string;
    resultStatus: string; // 'ambiguous' | 'invalid'
    reason: string;
  };

  /** An Occ Health cert (FIT-TEST or AUDIO from a FitTestRecord) was accepted
   *  by BlueLion (added or idempotent-skipped). */
  'bluelion.occhealth.synced': {
    fitTestRecordId: string;
    certType: 'fit_test' | 'audiometric';
    ticketId: string;
    externalId: string;
    personId: string | null;
    trainingSeq: number | null;
    syncedAt: string; // ISO
  };

  /** An Occ Health cert push needs a human (ambiguous person / invalid). */
  'bluelion.occhealth.needs_attention': {
    fitTestRecordId: string;
    certType: 'fit_test' | 'audiometric';
    ticketId: string;
    externalId: string;
    resultStatus: string; // 'ambiguous' | 'invalid'
    reason: string;
  };

  /** BlueLion printed a physical wallet card (the one inbound BlueLion call —
   *  docs/bluelion/SERVICEPRO-CARD-FLAG.md). matchedEntity* identify the
   *  Sundog row stamped with the card-issued flag, when one matched. */
  'bluelion.card.issued': {
    cardId: string;
    personId: string;
    certCode: string;
    issuedOn: string; // ISO
    matchedEntityType: string | null;
    matchedEntityId: string | null;
  };

  /** A pad's pendingReview flag was cleared (approved / DMR-activated /
   *  merged into another pad / fully resolved). Listeners can rescore
   *  tickets blocked by the missing_location rule on this pad.
   *  resolution: which path cleared the flag, for logging/audit. */
  'location.resolved': {
    padId: string;
    resolution: 'approved' | 'merged' | 'dmr_activated' | 'resolved';
    actorUserId: string | null;
    resolvedAt: string; // ISO
  };

  /** A RentalAgreement was created via POST /api/rentals (dispatch or
   *  walk-in). Drives the RingCentral "rentals" channel notification —
   *  the goal being that firing this automatically makes manually typing
   *  the same thing into RingCentral chat redundant.
   *  `composition` is the dispatch-time equipment spec (trailer/monitors/
   *  etc — see rentalComposition.ts) and is usually the only equipment
   *  info available, since `items` (real serialized equipment) is empty
   *  until pickup for anything but a walk-in. */
  'rental.agreement.created': {
    ringCentralChannel?: import('./webhookSettings.js').RingCentralChannel;
    agreementId: string;
    agreementNumber: string;
    companyId: string;
    companyName: string;
    pickupType: 'dispatch' | 'walk_in';
    status: string;
    createdByUserId: string | null;
    composition: RentalComposition | null;
    items: { productName: string }[];
  };

  /** A ShopWorkOrder was created (batch intake) via POST /api/shop-orders.
   *  Drives the RingCentral "intake" channel notification. */
  'shopwo.intake.created': {
    workOrderId: string;
    workOrderNumber: string;
    companyId: string;
    companyName: string;
    itemCount: number;
    /** WO priority as set at intake: 1=urgent, 2=high, 5=normal, 10=low. */
    priority?: number;
    /** Top-level units per equipment category (SCBA components are not
     *  counted separately, unlike `itemCount`). */
    categoryCounts?: { category: string; count: number }[];
    createdByUserId: string;
  };
};

export type EventName = keyof SundogEventMap;

type Handler<E extends EventName> = (payload: SundogEventMap[E]) => void | Promise<void>;

// Internal storage uses `unknown` payload because TS can't unify the per-event
// handler type with a single Map entry. Public API stays fully typed.
const handlers = new Map<EventName, Array<(payload: unknown) => void | Promise<void>>>();

/**
 * Subscribe to an event. Returns an unsubscribe fn.
 */
export function onEvent<E extends EventName>(event: E, handler: Handler<E>): () => void {
  const list = handlers.get(event) ?? [];
  const erased = handler as (payload: unknown) => void | Promise<void>;
  list.push(erased);
  handlers.set(event, list);
  return () => {
    const idx = list.indexOf(erased);
    if (idx >= 0) list.splice(idx, 1);
  };
}

/**
 * Emit an event. Fires handlers concurrently and waits for all of them so
 * the caller can await side effects when it cares (e.g. integration tests),
 * or simply not await for fire-and-forget. Errors are caught per-handler.
 */
export async function emitEvent<E extends EventName>(
  event: E,
  payload: SundogEventMap[E],
): Promise<void> {
  const list = handlers.get(event);
  if (!list || list.length === 0) return;
  await Promise.all(
    list.map(async h => {
      try {
        await h(payload);
      } catch (err) {
        console.error(
          `[Event ${event}] handler errored:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
}
