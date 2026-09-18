/**
 * Billing Lineage Phase 2 — backfill billing_doc_ref / billing_doc_line_ref
 * from existing invoices and their line items.
 *
 * Usage: npx tsx scripts/backfill-billing-doc-refs.ts [--dry-run]
 *
 * Per the handoff §5 step 2: "Log unresolvable references rather than
 * guessing; produce an exceptions report for review." This script never
 * synthesizes a ticket link that isn't already on the line item — a line
 * with no sourceTicketId (shop/rental/product-only lines) is legitimately
 * out of scope for ticket-lineage and is counted, not treated as an error; a
 * line WITH a sourceTicketId that doesn't resolve to a real ticket is a real
 * exception and goes in the report.
 *
 * Deliberately NOT sharing code with services/billingLineage.ts (the live
 * per-invoice hook called from invoices.ts/qbwc.ts) even though the upsert
 * logic is similar — this script needs batch ticket-resolution, --dry-run,
 * and a structured exceptions report; the live hook needs to be a single
 * fire-and-forget call that never throws. Keep both in sync by hand if the
 * upsert rule (doc_ref by docNumber+revision, only qbTxnId/invoiceDate ever
 * updated) changes.
 *
 * Idempotent / safe to re-run:
 *   - doc_ref is looked up by (docNumber, revision:1) before creating. If it
 *     already exists, only qbTxnId/invoiceDate are updated (the only fields
 *     the immutability trigger allows to change) — re-running after an
 *     invoice progresses in QB picks up the new txn id/date with no
 *     duplicate rows.
 *   - doc_line_ref is looked up by (docRefId, lineNo) before creating;
 *     existing rows are left alone (service_date/amount are fixed
 *     operational facts of the ticket→invoice mapping, not mirrors — nothing
 *     to reconcile).
 *
 * Scope: every non-void Invoice gets a doc_ref (even pre-QB drafts — a
 * ServicePRO invoice is a real document with a real invoiceNumber the moment
 * it's created; qbTxnId/invoiceDate just start null and fill in later, which
 * is exactly what the trigger's allowed-to-change list is for). Void
 * invoices are skipped: the existing void-guard in tickets.ts/invoices.ts
 * only allows voiding an invoice that never reached QB, so there's no QB
 * document to reference and nothing useful to backfill.
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '../src/db.js';

const DRY_RUN = process.argv.includes('--dry-run');

interface Exception {
  kind: 'dangling_source_ticket';
  invoiceNumber: string;
  lineNumber: number;
  sourceTicketId: string;
}

async function main() {
  const invoices = await prisma.invoice.findMany({
    where: { status: { not: 'void' } },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      qbInvoiceTxnId: true,
      createdAt: true,
      lineItems: {
        select: { lineNumber: true, sourceTicketId: true, sourceTicketNumber: true, amount: true },
      },
    },
  });
  console.log(`Found ${invoices.length} non-void invoice(s).`);

  // Batch-resolve every distinct sourceTicketId referenced by any line item,
  // in one query, instead of N+1-ing per invoice.
  const allTicketIds = new Set<string>();
  for (const inv of invoices) {
    for (const li of inv.lineItems) {
      if (li.sourceTicketId) allTicketIds.add(li.sourceTicketId);
    }
  }
  const tickets = await prisma.serviceTicket.findMany({
    where: { id: { in: [...allTicketIds] } },
    select: { id: true, ticketNumber: true, serviceDate: true },
  });
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  console.log(`Resolved ${ticketById.size} of ${allTicketIds.size} referenced ticket(s).`);

  let docRefsCreated = 0;
  let docRefsUpdated = 0;
  let lineRefsCreated = 0;
  let linesOutOfScope = 0; // no sourceTicketId at all — expected (shop/rental/product-only lines)
  const exceptions: Exception[] = [];

  for (const inv of invoices) {
    let docRef = await prisma.billingDocRef.findFirst({
      where: { docNumber: inv.invoiceNumber, revision: 1 },
      select: { id: true, qbTxnId: true, invoiceDate: true },
    });

    const desiredQbTxnId = inv.qbInvoiceTxnId ?? null;
    const desiredInvoiceDate = desiredQbTxnId ? inv.invoiceDate : null;

    if (!docRef) {
      docRefsCreated++;
      if (!DRY_RUN) {
        docRef = await prisma.billingDocRef.create({
          data: {
            docType: 'invoice',
            docNumber: inv.invoiceNumber,
            revision: 1,
            qbTxnId: desiredQbTxnId,
            invoiceDate: desiredInvoiceDate,
            createdAt: inv.createdAt, // preserve real history, not the backfill run time
          },
          select: { id: true, qbTxnId: true, invoiceDate: true },
        });
      }
    } else if (
      docRef.qbTxnId !== desiredQbTxnId ||
      docRef.invoiceDate?.getTime() !== desiredInvoiceDate?.getTime()
    ) {
      docRefsUpdated++;
      if (!DRY_RUN) {
        await prisma.billingDocRef.update({
          where: { id: docRef.id },
          data: { qbTxnId: desiredQbTxnId, invoiceDate: desiredInvoiceDate },
        });
      }
    }

    // In dry-run, docRef stays null when it doesn't exist yet (we don't
    // create it) — use a placeholder id purely so the line-level counting
    // below still runs; it never matches a real row, so the "does this line
    // ref already exist" check below correctly always misses and everything
    // still tallies as "would create."
    const docRefId = docRef?.id ?? '__dry_run_placeholder__';

    for (const li of inv.lineItems) {
      if (!li.sourceTicketId) {
        linesOutOfScope++;
        continue;
      }
      const ticket = ticketById.get(li.sourceTicketId);
      if (!ticket) {
        exceptions.push({
          kind: 'dangling_source_ticket',
          invoiceNumber: inv.invoiceNumber,
          lineNumber: li.lineNumber,
          sourceTicketId: li.sourceTicketId,
        });
        continue;
      }

      const existingLineRef = await prisma.billingDocLineRef.findFirst({
        where: { docRefId, lineNo: li.lineNumber },
        select: { id: true },
      });
      if (existingLineRef) continue;

      lineRefsCreated++;
      if (!DRY_RUN && docRef) {
        await prisma.billingDocLineRef.create({
          data: {
            docRefId: docRef.id,
            lineNo: li.lineNumber,
            ticketId: ticket.id,
            ticketNumber: li.sourceTicketNumber ?? ticket.ticketNumber,
            serviceDate: ticket.serviceDate,
            amount: li.amount,
          },
        });
      }
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Summary:`);
  console.log(`  doc_ref created:        ${docRefsCreated}`);
  console.log(`  doc_ref updated:        ${docRefsUpdated} (qbTxnId/invoiceDate only)`);
  console.log(`  doc_line_ref created:   ${lineRefsCreated}`);
  console.log(`  lines out of scope:     ${linesOutOfScope} (no sourceTicketId — shop/rental/product-only, expected)`);
  console.log(`  exceptions (dangling):  ${exceptions.length}`);

  if (exceptions.length > 0) {
    const outFile = join(process.cwd(), 'scripts', 'data', `billing-doc-ref-backfill-exceptions-${Date.now()}.json`);
    writeFileSync(outFile, JSON.stringify(exceptions, null, 2), 'utf-8');
    console.log(`\nException detail written to ${outFile} — review before treating the backfill as complete.`);
  }

  if (DRY_RUN) console.log('\nDry run — no rows were written.');
}

main()
  .catch((e) => {
    console.error('BACKFILL ERROR', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
