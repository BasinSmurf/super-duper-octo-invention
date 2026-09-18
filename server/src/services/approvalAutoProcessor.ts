/**
 * approvalAutoProcessor.ts
 *
 * Background job: auto-transitions "routine" tickets from supervisor_review
 * to billing_queue after a configurable delay if no supervisor intervenes.
 *
 * Rules for a ticket to auto-approve:
 *   1. Status is supervisor_review
 *   2. reviewSignal.verdict === 'green' (no fails, no warnings)
 *   3. reviewSignalRanAt is older than DELAY_HOURS
 *   4. Customer's active billing profile does not have autoApprovalEnabled=false
 *
 * Same pattern as enverusQueueProcessor: simple setInterval, in-process,
 * local Prisma client, isProcessing lock to prevent overlap.
 *
 * Env vars:
 *   AUTO_APPROVE_ENABLED          - set to 'false' to disable entirely
 *   AUTO_APPROVE_DELAY_HOURS      - default 4
 *   AUTO_APPROVE_CHECK_INTERVAL_MS - default 900000 (15 minutes)
 */

import { prisma, Prisma } from '../db.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';
import { emitEvent } from './eventBus.js';
import { shouldRecordOnly, recordTicketAsRentalLog } from './rentalTicketRecord.js';

// Local Prisma client to avoid circular imports with index.ts

const ENABLED = process.env.AUTO_APPROVE_ENABLED !== 'false';
const DELAY_HOURS = parseInt(process.env.AUTO_APPROVE_DELAY_HOURS || '4', 10);
export const CHECK_INTERVAL_MS = parseInt(
  process.env.AUTO_APPROVE_CHECK_INTERVAL_MS || '900000',
  10,
);

let timer: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

async function processTick(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const cutoff = new Date(Date.now() - DELAY_HOURS * 60 * 60 * 1000);

    // Find candidates. We filter verdict and billing profile here instead
    // of in Prisma because reviewSignal is JsonB — raw SQL would be cleaner
    // for the verdict filter but Prisma's relational filter for the profile
    // is simpler to maintain.
    const candidates = await prisma.serviceTicket.findMany({
      where: {
        status: 'supervisor_review',
        reviewSignalRanAt: { lte: cutoff },
      },
      include: {
        company: {
          include: {
            billingProfiles: {
              where: { isActive: true },
              orderBy: { effectiveFrom: 'desc' },
              take: 1,
              select: { autoApprovalEnabled: true },
            },
          },
        },
        billingProfile: { select: { autoApprovalEnabled: true } },
      },
      take: 100, // process in chunks so one tick doesn't monopolize the DB
    });

    if (candidates.length === 0) return;

    let approved = 0;
    let skipped = 0;
    let recordOnly = 0;

    for (const ticket of candidates) {
      // In-memory verdict filter
      const signal = ticket.reviewSignal as { verdict?: string } | null;
      if (signal?.verdict !== 'green') {
        skipped++;
        continue;
      }

      // Kill switch check
      const profile =
        ticket.billingProfile ?? ticket.company.billingProfiles[0] ?? null;
      if (profile?.autoApprovalEnabled === false) {
        skipped++;
        continue;
      }

      // A rental-linked ticket with nothing to charge is a log-only record, not
      // something to approve into billing — close it against the rental's daily
      // log instead. Without this the job silently parked such tickets in
      // `billing_queue`, where no queue renders them (rentalTicketRecord.ts).
      try {
        if (await shouldRecordOnly(ticket)) {
          await recordTicketAsRentalLog(ticket, ticket.linkedRentalAgreementId!, null);
          recordOnly++;
          continue;
        }
      } catch (err) {
        console.error(`[auto-approve] record-only close failed for ${ticket.id}:`, err);
        skipped++;
        continue;
      }

      try {
        // Transition to billing_queue
        await prisma.serviceTicket.update({
          where: { id: ticket.id },
          data: {
            status: 'billing_queue',
            reviewedAt: new Date(),
            autoApproved: true,
            // reviewedById stays null — no human operator on auto approvals
          },
        });

        // Audit log entry. userId is omitted since the system is acting,
        // and we tag the change set so it's filterable.
        await prisma.auditLog.create({
          data: {
            userId: null,
            entityType: 'service_ticket',
            entityId: ticket.id,
            action: 'status_change',
            changes: {
              from: 'supervisor_review',
              to: 'billing_queue',
              auto_approved: true,
              reason: 'routine_delay_elapsed',
              delayHours: DELAY_HOURS,
            } as Prisma.InputJsonValue,
          },
        });

        void emitEvent('ticket.transitioned', {
          ticketId: ticket.id,
          fromStatus: 'supervisor_review',
          toStatus: 'billing_queue',
          actorUserId: null, // system actor
          reason: 'auto_approved',
        });

        approved++;
      } catch (err) {
        console.error(
          `[AutoApproval] Failed to auto-approve ${ticket.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (approved > 0 || skipped > 0) {
      console.log(
        `[AutoApproval] Tick complete: ${approved} auto-approved, ${skipped} skipped (${candidates.length} candidates examined)`,
      );
    }
  } catch (err) {
    console.error('[AutoApproval] Unexpected error in processing loop:', err);
  } finally {
    isProcessing = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export function startAutoApprovalProcessor(): void {
  if (!ENABLED) {
    console.log('[AutoApproval] Skipped — AUTO_APPROVE_ENABLED=false');
    return;
  }

  console.log(
    `[AutoApproval] Starting processor (check every ${CHECK_INTERVAL_MS / 1000}s, delay ${DELAY_HOURS}h)`,
  );

  // Wrap each tick in runScheduledJob so two API instances can't both
  // auto-approve the same ticket and so each tick lands in job_runs.
  // TTL = 30 min leaves wide headroom over typical sub-second tick duration.
  const runTick = () => { heartbeat('approval'); return runScheduledJob('approval.auto', 1800, processTick); };

  timer = setInterval(runTick, CHECK_INTERVAL_MS);

  // First tick shortly after startup (server warmup buffer)
  setTimeout(runTick, 30_000);
}

export function stopAutoApprovalProcessor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log('[AutoApproval] Processor stopped');
}
