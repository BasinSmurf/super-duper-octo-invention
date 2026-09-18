/**
 * locationRescoreListener.ts
 *
 * On `location.resolved`, re-run the supervisor-review signal for any
 * ticket sitting in `supervisor_review` against the just-cleared pad.
 *
 * Why this exists:
 *   The `missing_location` rule fails when `pad.pendingReview === true`.
 *   Once an approver resolves the pad (Approvals → Locations sub-tab),
 *   tickets blocked behind the location stay red until something rescores
 *   them. Without this listener, the supervisor has to remember to bounce
 *   each ticket through the review queue manually after every pad resolve.
 *
 *   With it: the auto-approval processor (which only sweeps green tickets)
 *   picks them up on its next tick, so a pad resolution naturally clears
 *   the downstream ticket queue too.
 *
 * Scope:
 *   Only tickets in `supervisor_review` are rescored — that's where the
 *   review signal is consumed. Already-billed tickets don't care.
 */

import { onEvent } from './eventBus.js';
import { runAndCacheReviewSignal } from './ticketReviewRules.js';
import { prisma } from '../db.js';


export function startLocationRescoreListener(): void {
  onEvent('location.resolved', async ({ padId, resolution }) => {
    const tickets = await prisma.serviceTicket.findMany({
      where: {
        padId,
        status: 'supervisor_review',
      },
      select: { id: true },
    });

    if (tickets.length === 0) return;

    let rescored = 0;
    let failed = 0;
    for (const t of tickets) {
      try {
        await runAndCacheReviewSignal(t.id);
        rescored++;
      } catch (err) {
        failed++;
        console.error(
          `[LocationRescore] Failed to rescore ${t.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log(
      `[LocationRescore] pad=${padId} resolution=${resolution} → rescored ${rescored}/${tickets.length}` +
        (failed > 0 ? ` (${failed} failed)` : ''),
    );
  });

  console.log('[LocationRescore] Listener registered for location.resolved');
}
