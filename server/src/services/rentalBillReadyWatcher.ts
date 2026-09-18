/**
 * rentalBillReadyWatcher.ts
 *
 * Periodically checks active rental agreements against their billing cadence
 * and notifies Supervisors (field_super) + Billing (billing_ar) once a
 * period is due, so billing doesn't rely on someone remembering to check.
 * Modeled on qbInvoiceDiffWatcher.ts, but on an hours-scale interval —
 * billing periods are day/week/month scale, not the QB watcher's 30-min.
 *
 * Dedup is period-based, not time-based: `lastBillReadyNotifiedFor` stores
 * the due date already notified for. Once billing actually advances (a new
 * invoice posts, moving nextDueDate forward), the next tick notifies again
 * for the new period on its own — no blind cooldown to tune.
 */

import { prisma } from '../index.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';
import { computeRentalBillingState } from './rentalBilling.js';
import { sendMail, mailerConfigured, FROM_ADDRESS, BILLING_CC } from './mailer.js';
import { notify as ringcentralNotify, isConfigured as ringcentralConfigured } from './ringcentralNotify.js';

const ENABLED = process.env.RENTAL_BILL_READY_ENABLED !== 'false';
export const CHECK_INTERVAL_MS = parseInt(
  process.env.RENTAL_BILL_READY_CHECK_INTERVAL_MS || `${6 * 60 * 60 * 1000}`, // 6 hours
  10,
);

let timer: ReturnType<typeof setInterval> | null = null;

interface DueAgreement {
  id: string;
  agreementNumber: string | null;
  companyName: string;
  nextDueDate: Date;
}

async function findDueAgreements(): Promise<DueAgreement[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const agreements = await prisma.rentalAgreement.findMany({
    where: { status: 'active' },
    select: {
      id: true, agreementNumber: true, status: true, startDate: true, endDate: true,
      billingCadence: true, lastBillReadyNotifiedFor: true,
      company: { select: { name: true } },
    },
  });
  if (agreements.length === 0) return [];

  const invoices = await prisma.invoice.findMany({
    where: { rentalAgreementId: { in: agreements.map(a => a.id) }, status: { not: 'void' } },
    select: { rentalAgreementId: true, periodEnd: true },
  });
  const invoicesFor = new Map<string, { periodEnd: Date | null }[]>();
  for (const inv of invoices) {
    if (!inv.rentalAgreementId) continue;
    const list = invoicesFor.get(inv.rentalAgreementId) ?? [];
    list.push({ periodEnd: inv.periodEnd });
    invoicesFor.set(inv.rentalAgreementId, list);
  }

  const due: DueAgreement[] = [];
  for (const a of agreements) {
    const { nextDueDate } = computeRentalBillingState(a, invoicesFor.get(a.id) ?? []);
    if (!nextDueDate || nextDueDate > today) continue;
    const alreadyNotified =
      a.lastBillReadyNotifiedFor &&
      a.lastBillReadyNotifiedFor.getTime() === nextDueDate.getTime();
    if (alreadyNotified) continue;
    due.push({
      id: a.id,
      agreementNumber: a.agreementNumber,
      companyName: a.company?.name ?? 'Unknown',
      nextDueDate,
    });
  }
  return due;
}

async function notifyDue(due: DueAgreement[]): Promise<void> {
  const recipients = await prisma.user.findMany({
    where: { role: { in: ['field_super', 'billing_ar'] }, isActive: true },
    select: { email: true, notificationPrefs: true },
  });
  // No digest-batching mechanism exists anywhere yet — any non-'off' pref
  // just means "send now" (known gap, not a bug; digest queue is future work).
  const emails = recipients
    .filter(u => (u.notificationPrefs as any)?.default?.cadence !== 'off')
    .map(u => u.email)
    .filter(Boolean);

  const lines = due.map(d => `${d.companyName} — ${d.agreementNumber ?? 'Pending...'} (ready to invoice ${d.nextDueDate.toISOString().slice(0, 10)})`);

  if (emails.length > 0 && mailerConfigured) {
    try {
      await sendMail({
        from: FROM_ADDRESS,
        to: emails.join(','),
        cc: BILLING_CC,
        subject: `${due.length} rental agreement${due.length === 1 ? '' : 's'} ready to invoice`,
        html: `<p>The following active rentals have reached their billing cadence:</p><ul>${
          due.map(d => `<li>${d.companyName} — ${d.agreementNumber ?? 'Pending...'} (ready to invoice ${d.nextDueDate.toISOString().slice(0, 10)})</li>`).join('')
        }</ul>`,
      });
    } catch (err) {
      console.error('[RentalBillReady] sendMail failed:', err instanceof Error ? err.message : err);
    }
  }

  if (ringcentralConfigured('billing')) {
    const text = `💵 **Ready to invoice** — ${due.length} rental agreement${due.length === 1 ? '' : 's'}\n${lines.join('\n')}`;
    await ringcentralNotify('billing', text);
  }
}

async function processTick(): Promise<void> {
  const due = await findDueAgreements();
  if (due.length === 0) return;

  await notifyDue(due);

  await prisma.$transaction(
    due.map(d =>
      prisma.rentalAgreement.update({ where: { id: d.id }, data: { lastBillReadyNotifiedFor: d.nextDueDate } }),
    ),
  );

  console.log(`[RentalBillReady] Notified for ${due.length} agreement${due.length === 1 ? '' : 's'} ready to bill`);
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
