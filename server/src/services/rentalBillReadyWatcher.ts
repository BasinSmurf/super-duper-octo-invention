/**
 * rentalBillReadyWatcher.ts
 *
 * Nags the people who SEND rentals for billing once a rental is due and has
 * not been sent. It used to tell Billing that every open rental had hit its
 * cadence — but an open rental is no longer AR's to act on until the field
 * sends it (services/rentalBillingRelease.ts), so that message now goes to
 * whoever holds `rentals:release_billing`, and only about rentals that are
 * actually waiting on them:
 *
 *   - open, not sent, and past the billing cadence (for monthly billing that is
 *     the last day of the month — the "send it for end of month" reminder
 *     supervisors used to send by hand);
 *   - closed, but stuck behind tickets that still need approval.
 *
 * Dedup is period-based, not time-based: `lastBillReadyNotifiedFor` stores the
 * date already notified for (the due date, or the close date). Once billing
 * actually advances, the next due date differs and it notifies again on its
 * own — no blind cooldown to tune. The standing reminder between nags is the
 * dashboard banner, not a repeat message.
 */

import { prisma } from '../db.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';
import { listRentalsForRelease } from './rentalBillingRelease.js';
import { getEffectiveMatrix } from './permissions.js';
import { sendMail, mailerConfigured, FROM_ADDRESS, BILLING_CC } from './mailer.js';
import { notify as ringcentralNotify, isConfigured as ringcentralConfigured } from './ringcentralNotify.js';

const ENABLED = process.env.RENTAL_BILL_READY_ENABLED !== 'false';
export const CHECK_INTERVAL_MS = parseInt(
  process.env.RENTAL_BILL_READY_CHECK_INTERVAL_MS || `${6 * 60 * 60 * 1000}`, // 6 hours
  10,
);

let timer: ReturnType<typeof setInterval> | null = null;

export interface DueRental {
  id: string;
  agreementNumber: string | null;
  companyName: string;
  /** What `lastBillReadyNotifiedFor` is set to once this has been announced. */
  notifyFor: Date;
  /** One line, ready to print. */
  detail: string;
}

type ReleaseRow = Awaited<ReturnType<typeof listRentalsForRelease>>[number];
export type NagRow = Pick<ReleaseRow, 'id' | 'agreementNumber' | 'state' | 'endDate' | 'unbilledFrom' | 'unbilledDays'
  | 'overdue' | 'nextDueDate' | 'lastBillReadyNotifiedFor'> & {
    company: { name: string } | null;
    blockers: { ticketNumber: string }[];
  };

/** Rentals waiting on the field that have not been announced for this period. Pure. */
export function dueForNag(rows: NagRow[]): DueRental[] {
  const due: DueRental[] = [];
  for (const r of rows) {
    let notifyFor: Date | null = null;
    let detail = '';
    if (r.state === 'closed_blocked') {
      notifyFor = r.endDate ?? r.unbilledFrom;
      detail = `closed, ${r.blockers.length} ticket${r.blockers.length === 1 ? '' : 's'} to approve (${r.blockers.map(b => b.ticketNumber).join(', ')})`;
    } else if (r.overdue && r.nextDueDate) {
      notifyFor = r.nextDueDate;
      detail = `${r.unbilledDays} day${r.unbilledDays === 1 ? '' : 's'} unbilled, not sent`;
    }
    if (!notifyFor) continue;
    if (r.lastBillReadyNotifiedFor && r.lastBillReadyNotifiedFor.getTime() === notifyFor.getTime()) continue;
    due.push({ id: r.id, agreementNumber: r.agreementNumber, companyName: r.company?.name ?? 'Unknown', notifyFor, detail });
  }
  return due;
}

async function notifyDue(due: DueRental[]): Promise<void> {
  // Whoever can send rentals for billing — by capability, so a role the admin
  // grants it to on the Permissions page is included without a code change.
  const roles = getEffectiveMatrix()['rentals:release_billing'] ?? [];
  const recipients = await prisma.user.findMany({
    where: { role: { in: roles as any }, isActive: true },
    select: { email: true, notificationPrefs: true },
  });
  // Daily/weekly recipients receive persistent rental exceptions in the operations digest.
  const emails = recipients
    .filter(u => ((u.notificationPrefs as any)?.default?.cadence ?? 'immediate') === 'immediate')
    .map(u => u.email)
    .filter(Boolean);

  const lines = due.map(d => `${d.companyName} — ${d.agreementNumber ?? 'Pending...'} (${d.detail})`);
  const headline = `${due.length} rental${due.length === 1 ? '' : 's'} to send for billing`;

  if (emails.length > 0 && mailerConfigured) {
    try {
      await sendMail({
        from: FROM_ADDRESS,
        to: emails.join(','),
        cc: BILLING_CC,
        subject: headline,
        html: `<p>These rentals are due and have not been sent for billing. Send them from the dashboard Rental Billing tab:</p><ul>${
          lines.map(l => `<li>${l}</li>`).join('')
        }</ul>`,
      });
    } catch (err) {
      console.error('[RentalBillReady] sendMail failed:', err instanceof Error ? err.message : err);
    }
  }

  if (await ringcentralConfigured('billing')) {
    await ringcentralNotify('billing', `**${headline}**\n${lines.join('\n')}`);
  }
}

async function processTick(): Promise<void> {
  const due = dueForNag(await listRentalsForRelease());
  if (due.length === 0) return;

  await notifyDue(due);

  await prisma.$transaction(
    due.map(d =>
      prisma.rentalAgreement.update({ where: { id: d.id }, data: { lastBillReadyNotifiedFor: d.notifyFor } }),
    ),
  );

  console.log(`[RentalBillReady] Notified for ${due.length} rental${due.length === 1 ? '' : 's'} waiting to be sent for billing`);
}

export function startRentalBillReadyWatcher(): void {
  if (!ENABLED) {
    console.log('[RentalBillReady] Skipped — RENTAL_BILL_READY_ENABLED=false');
    return;
  }

  console.log(`[RentalBillReady] Starting watcher (check every ${CHECK_INTERVAL_MS / 1000}s)`);

  const runTick = () => { heartbeat('rental-bill'); return runScheduledJob('rental.bill-ready', 600, processTick); };

  timer = setInterval(runTick, CHECK_INTERVAL_MS);
  setTimeout(runTick, 60_000);
}

export function stopRentalBillReadyWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
