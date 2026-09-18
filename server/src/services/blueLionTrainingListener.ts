/**
 * blueLionTrainingListener.ts
 *
 * On `ticket.transitioned`, when a training ticket reaches a finalized status,
 * enqueue its passed roster records for the BlueLion push. Idempotent — the
 * enqueue dedups on externalId, so it doesn't matter which finalized status the
 * ticket lands on (or how many transitions it makes).
 *
 * Skips if BlueLion isn't configured so we don't pile up a queue nobody drains.
 */

import { onEvent } from './eventBus.js';
import { prisma } from '../db.js';
import { isConfigured } from './blueLionClient.js';
import {
  enqueueTrainingRosterForTicket,
  enqueueOccHealthForTicket,
  FINALIZED_TRAINING_STATUSES,
} from './blueLionEnqueue.js';

export function startBlueLionTrainingListener(): void {
  if (!isConfigured()) {
    console.log('[BlueLion] Training listener skipped — not configured');
    return;
  }

  onEvent('ticket.transitioned', async ({ ticketId, toStatus }) => {
    if (!FINALIZED_TRAINING_STATUSES.includes(toStatus)) return;

    // Cheap type gate before touching the roster.
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: ticketId },
      select: { ticketType: true },
    });
    if (ticket?.ticketType !== 'training') return;

    // A training ticket carries roster records (classes) or fit-test records
    // (Occ Health visits — serviceSubtype 'fit_test'); each enqueue no-ops on
    // the kind the ticket doesn't have.
    const roster = await enqueueTrainingRosterForTicket(ticketId);
    const occ = await enqueueOccHealthForTicket(ticketId);
    const res = {
      enqueued: roster.enqueued + occ.enqueued,
      skipped: roster.skipped + occ.skipped,
      needsAttention: roster.needsAttention + occ.needsAttention,
    };
    if (res.enqueued > 0 || res.needsAttention > 0) {
      console.log(
        `[BlueLion] ticket ${ticketId} → ${toStatus}: enqueued ${res.enqueued}, needs-attention ${res.needsAttention}, skipped ${res.skipped}`,
      );
    }
  });

  console.log('[BlueLion] Training listener registered for ticket.transitioned');
}
