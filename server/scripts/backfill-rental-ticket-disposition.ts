/**
 * Backfill: dispose of rental-linked tickets stranded in `billing_queue`.
 *
 * Root cause (fixed): the "rental-linked ticket with nothing to charge is a
 * log-only record" rule lived in exactly ONE of the four paths that can move a
 * ticket to `billing_queue` — the single-ticket transition. Bulk approve from
 * the Approvals UI, the background auto-approval job, and `/sync/push` all
 * skipped it, so tickets landed in `billing_queue`. And because
 * `GET /invoices/uninvoiced/tickets` excludes every rental-linked ticket (the
 * double-invoice guard, ADR-0014 mechanism #3), a rental-linked ticket in
 * `billing_queue` renders in NO queue: it reads "Billing Queue" on the ticket
 * and is absent from the billing queue, permanently.
 *
 * This sorts the ones already stranded:
 *
 *   no billable lines → closed as a log-only record against the rental's daily
 *                       log, via the same recordTicketAsRentalLog() the live
 *                       paths now call.
 *   billable lines    → LEFT ALONE. They're real charges that must still roll
 *                       onto their rental's invoice, and they're now visible on
 *                       the rental's card in Rentals to Bill. Reported here so
 *                       AR knows which rentals are carrying unbilled tickets.
 *
 * Attribution: each ticket's own assignedTech (falling back to createdBy) owns
 * the daily-log row — the shift was theirs. A ticket with neither is skipped
 * and reported rather than attributed to a fabricated author.
 *
 * Usage: npx tsx scripts/backfill-rental-ticket-disposition.ts [--dry-run]
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { recordTicketAsRentalLog } from '../src/services/rentalTicketRecord.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const stranded = await prisma.serviceTicket.findMany({
    where: {
      status: 'billing_queue',
      linkedRentalAgreementId: { not: null },
    },
    select: {
      id: true,
      ticketNumber: true,
      status: true,
      workDescription: true,
      customData: true,
      serviceDate: true,
      linkedRentalAgreementId: true,
      assignedTechId: true,
      createdById: true,
      linkedRentalAgreement: { select: { agreementNumber: true } },
      lineItems: { select: { total: true } },
    },
    orderBy: { serviceDate: 'asc' },
  });

  console.log(
    `${DRY_RUN ? '[dry-run] ' : ''}Found ${stranded.length} rental-linked ticket(s) stranded in billing_queue.\n`,
  );

  let closed = 0;
  const billable: string[] = [];
  const unattributable: string[] = [];

  for (const t of stranded) {
    const ra = t.linkedRentalAgreement?.agreementNumber ?? t.linkedRentalAgreementId;
    const total = t.lineItems.reduce(
      (sum, li) => sum + (li.total ? parseFloat(li.total.toString()) : 0),
      0,
    );

    if (total > 0) {
      billable.push(`  ${t.ticketNumber}  ${ra}  $${total.toFixed(2)}  — left for the rental invoice`);
      continue;
    }

    if (!t.assignedTechId && !t.createdById) {
      unattributable.push(`  ${t.ticketNumber}  ${ra}  — no tech or creator to own the log row`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`  would close  ${t.ticketNumber}  ${ra}  — log-only, no billable lines`);
      closed++;
      continue;
    }

    try {
      await recordTicketAsRentalLog(t, t.linkedRentalAgreementId!, null);
      console.log(`  closed  ${t.ticketNumber}  ${ra}  — log-only, no billable lines`);
      closed++;
    } catch (err) {
      console.error(
        `  FAILED  ${t.ticketNumber}  ${ra}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (billable.length) {
    console.log(`\nBillable — still to be rolled onto their rental's invoice (${billable.length}):`);
    billable.forEach(l => console.log(l));
  }
  if (unattributable.length) {
    console.log(`\nSkipped, needs a human (${unattributable.length}):`);
    unattributable.forEach(l => console.log(l));
  }

  console.log(
    `\n${DRY_RUN ? '[dry-run] ' : ''}Done: ${closed} closed log-only, ${billable.length} left billable, ${unattributable.length} skipped.`,
  );
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
