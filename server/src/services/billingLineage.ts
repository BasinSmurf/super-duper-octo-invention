// Billing Lineage Phase 2 — keep billing_doc_ref / billing_doc_line_ref
// current for every invoice going forward, not just the ones that existed
// when scripts/backfill-billing-doc-refs.ts ran once. Call this right after
// any `prisma.invoice.create(...)` succeeds. Same upsert shape as the
// backfill script (see that file for the fuller design notes: idempotent,
// only qbTxnId/invoiceDate get updated on an existing doc_ref, dangling
// sourceTicketId is logged and skipped rather than guessed).
//
// Bad-divorce rule: this never throws. A failure here must not break invoice
// creation — the next backfill script run picks up anything missed.

import { prisma } from '../db.js';

/**
 * Call after any invoice create, and again whenever qbInvoiceTxnId/invoiceDate
 * change (InvoiceAdd / SO→Invoice conversion in qbwc.ts) — re-fetches the
 * invoice + line items itself so every caller can just pass an id, no matter
 * how much of the invoice shape it already has in scope.
 */
export async function upsertDocRefAndLines(invoiceId: string): Promise<void> {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        invoiceNumber: true,
        invoiceDate: true,
        qbInvoiceTxnId: true,
        createdAt: true,
        lineItems: {
          select: { lineNumber: true, sourceTicketId: true, sourceTicketNumber: true, amount: true },
        },
      },
    });
    if (!invoice) return;

    let docRef = await prisma.billingDocRef.findFirst({
      where: { docNumber: invoice.invoiceNumber, revision: 1 },
      select: { id: true, qbTxnId: true, invoiceDate: true },
    });

    const desiredQbTxnId = invoice.qbInvoiceTxnId ?? null;
    const desiredInvoiceDate = desiredQbTxnId ? invoice.invoiceDate : null;

    if (!docRef) {
      docRef = await prisma.billingDocRef.create({
        data: {
          docType: 'invoice',
          docNumber: invoice.invoiceNumber,
          revision: 1,
          qbTxnId: desiredQbTxnId,
          invoiceDate: desiredInvoiceDate,
          createdAt: invoice.createdAt,
        },
        select: { id: true, qbTxnId: true, invoiceDate: true },
      });
    } else if (
      docRef.qbTxnId !== desiredQbTxnId ||
      docRef.invoiceDate?.getTime() !== desiredInvoiceDate?.getTime()
    ) {
      await prisma.billingDocRef.update({
        where: { id: docRef.id },
        data: { qbTxnId: desiredQbTxnId, invoiceDate: desiredInvoiceDate },
      });
    }

    const ticketIds = [...new Set(invoice.lineItems.map((li) => li.sourceTicketId).filter((id): id is string => !!id))];
    if (ticketIds.length === 0) return;

    const tickets = await prisma.serviceTicket.findMany({
      where: { id: { in: ticketIds } },
      select: { id: true, ticketNumber: true, serviceDate: true },
    });
    const ticketById = new Map(tickets.map((t) => [t.id, t]));

    for (const li of invoice.lineItems) {
      if (!li.sourceTicketId) continue;
      const ticket = ticketById.get(li.sourceTicketId);
      if (!ticket) {
        console.warn(`[billingLineage] invoice ${invoice.invoiceNumber} line ${li.lineNumber}: sourceTicketId ${li.sourceTicketId} does not resolve to a ticket — skipped, not guessed`);
        continue;
      }
      const existing = await prisma.billingDocLineRef.findFirst({
        where: { docRefId: docRef.id, lineNo: li.lineNumber },
        select: { id: true },
      });
      if (existing) continue;
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
  } catch (err) {
    console.error(`[billingLineage] failed to upsert doc_ref for invoice id=${invoiceId}:`, err);
  }
}
