import { reconcileEnverusFailures } from './enverusQueueReconciliation.js';
import { applyCustomerDescriptions } from './customerDescriptions.js';
/**
 * enverusQueueProcessor.ts
 *
 * Background processor for the Enverus sync queue.  Two loops:
 *
 * 1. **Submission loop** (every 60s) — picks the next `pending`/`retrying`
 *    entry from EnverusSyncQueue and calls the appropriate Enverus API.
 *
 * 2. **Status poll loop** (every 5 min) — checks `submitted` entries against
 *    Enverus to detect approved/disputed transitions.
 *
 * Same pattern as QBWC's in-process approach — simple setInterval, not BullMQ.
 * Skips entirely if `ENVERUS_PFX_PATH` is not configured.
 */

import { prisma } from '../db.js';
import {
  submitReceiptWithAttachment,
  cancelReceipt,
  submitInvoice,
  pollReceiptStatus,
  pollReceiptById,
  pollInvoiceResponses,
  EnverusApiError,
} from './enverusClient.js';
import { buildReceiptPayload } from './enverusPayloadBuilder.js';
import { rebuildInvoiceSubmission } from './enverusInvoiceSubmission.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';
import { emitEvent } from './eventBus.js';
import { recordObservation, recordDocRefObservationByDocNumber } from './billingObservations.js';

import { getTicketPdfBuffer, getInvoicePdfBuffer } from '../utils/ticketPdfBuffer.js';

// Use a local Prisma client to avoid circular imports with index.ts

export const SUBMIT_INTERVAL_MS = parseInt(process.env.ENVERUS_SUBMIT_INTERVAL_MS || '60000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.ENVERUS_POLL_INTERVAL_MS || '300000', 10);
const MAX_RETRIES = parseInt(process.env.ENVERUS_MAX_RETRIES || '3', 10);

let submitTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;
let isPolling = false;

/**
 * Rebuild a ticket-receipt payload from CURRENT ticket + billing-profile data.
 *
 * The queue stores the payload snapshotted at enqueue time. If a submission fails
 * because of a config mistake (e.g. a bad buyerSiteUuid), fixing the profile is
 * useless unless the retry regenerates the payload — otherwise the processor just
 * replays the stale JSON forever. Ticket receipts are fully deterministic from
 * ticket+profile (no per-submission overrides), so regenerating is lossless.
 * Returns null if it can't rebuild (ticket gone, no enabled profile) — caller then
 * falls back to the stored snapshot.
 */
async function rebuildReceiptPayload(ticketId: string): Promise<unknown | null> {
  try {
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: ticketId },
      include: {
        lineItems: { include: { product: true }, orderBy: { lineNumber: 'asc' } },
        billingProfile: true,
        company: true,
      },
    });
    if (!ticket) return null;

    let profile = ticket.billingProfile;
    if (!profile && ticket.companyId) {
      profile = await prisma.customerBillingProfile.findFirst({
        where: { companyId: ticket.companyId, enverusEnabled: true, isActive: true },
      });
    }
    if (!profile || !profile.enverusEnabled) return null;

    const receiptLines = ticket.lineItems.map(line => ({ ...line,
      description: line.description || line.product?.name || 'Service',
      qbItemListId: line.product?.qbItemListId,
    }));
    await applyCustomerDescriptions(prisma, ticket.companyId, receiptLines);
    return buildReceiptPayload(ticket, receiptLines, profile);
  } catch (err) {
    console.warn(
      '[Enverus Queue] Receipt payload rebuild failed, using stored snapshot:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Submission Loop
// ─────────────────────────────────────────────────────────────────────────────

export async function processNextSubmission(): Promise<void> {
  if (isProcessing) return; // prevent overlap
  isProcessing = true;

  try {
    await reconcileEnverusFailures(prisma).catch(error => console.warn('[Enverus] Alert reconciliation deferred:', error));
    // Pick oldest pending/retrying entry
    const entry = await prisma.enverusSyncQueue.findFirst({
      where: {
        status: { in: ['pending', 'retrying'] },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!entry) return; // nothing to process

    console.log(
      `[Enverus Queue] Processing ${entry.entityType} ${entry.action} (${entry.id}) — attempt ${entry.retryCount + 1}`,
    );

    try {
      let payload = entry.requestPayload ? JSON.parse(entry.requestPayload) : {};
      let response: { statusCode: number; body: unknown };

      // Route based on stored endpointUrl first (handles invoice-as-receipt correctly),
      // then fall back to entity type + action for legacy queue entries.
      const ep = entry.endpointUrl || '';
      if (ep.includes('receipt.submit') || (entry.entityType === 'receipt' && entry.action === 'submit') || (entry.entityType === 'field_ticket' && entry.action === 'submit')) {
        // Rebuild ticket-receipt payloads from live data so config fixes (e.g. a
        // corrected buyerSiteUuid) take effect on retry instead of replaying the
        // stale enqueue-time snapshot. Invoice submissions keep their explicit
        // input overrides separately, and also rebuild from current source data.
        if (entry.entityType === 'receipt') {
          const rebuilt = await rebuildReceiptPayload(entry.entityId);
          if (rebuilt) {
            payload = rebuilt;
            await prisma.enverusSyncQueue
              .update({ where: { id: entry.id }, data: { requestPayload: JSON.stringify(rebuilt) } })
              .catch(() => {}); // keep the queue record in sync; non-fatal if it fails
          }
        } else if (entry.action === 'submit' && (entry.entityType === 'invoice' || entry.entityType === 'field_ticket')) {
          const rebuilt = await rebuildInvoiceSubmission(prisma, entry);
          payload = rebuilt.payload;
          await prisma.enverusSyncQueue.update({ where: { id: entry.id }, data: { requestPayload: rebuilt.requestPayload } });
        }

        // Try to attach a PDF to the receipt
        let pdfBuffer: Buffer | undefined;
        let pdfFileName = 'field-ticket.pdf';
        try {
          if (entry.entityType === 'receipt') {
            const pdf = await getTicketPdfBuffer(entry.entityId, prisma);
            pdfBuffer = pdf.buffer;
            pdfFileName = pdf.fileName;
          } else if (entry.entityType === 'invoice' || entry.entityType === 'field_ticket') {
            const pdf = await getInvoicePdfBuffer(entry.entityId, prisma);
            pdfBuffer = pdf.buffer;
            pdfFileName = pdf.fileName;
          }
          if (pdfBuffer) {
            console.log(`[Enverus Queue] Attaching PDF: ${pdfFileName} (${pdfBuffer.length} bytes)`);
          }
        } catch (pdfErr) {
          console.warn('[Enverus Queue] PDF generation failed, submitting without attachment:', pdfErr instanceof Error ? pdfErr.message : pdfErr);
        }
        response = await submitReceiptWithAttachment(payload, pdfBuffer, pdfFileName);
      } else if (ep.includes('receipt.cancel') || (entry.entityType === 'receipt' && entry.action === 'cancel')) {
        response = await cancelReceipt(payload);
      } else if (ep.includes('v3/invoice') || (entry.entityType === 'invoice' && entry.action === 'submit')) {
        response = await submitInvoice(payload);
      } else {
        throw new Error(`Unknown entity/action combo: ${entry.entityType}/${entry.action} (endpoint: ${ep})`);
      }

      // Success — extract itemId from response if available.
      // Receipt responses nest under events[0].data.output.receipt.
      // Invoice v3 responses have itemID/invoiceId at top level.
      const responseBody = response.body as Record<string, unknown>;
      let enverusItemId: string | null = null;
      try {
        const events = (responseBody as any)?.events;
        const receipt = events?.[0]?.data?.output?.receipt;
        enverusItemId = receipt?.itemID?.toString() || receipt?.receiptUuid || null;
      } catch { /* not event-envelope format */ }
      if (!enverusItemId) {
        enverusItemId =
          (responseBody?.itemID as string) ||
          (responseBody?.id as string) ||
          (responseBody?.invoiceId as string) ||
          null;
      }

      // Update queue entry
      await prisma.enverusSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: 'submitted',
          responseStatusCode: response.statusCode,
          responsePayload: JSON.stringify(response.body),
          enverusItemId,
          submittedAt: new Date(),
          errorMessage: null,
        },
      });

      await reconcileEnverusFailures(prisma).catch(error => console.warn('[Enverus] Alert reconciliation deferred:', error));
      // Update source entity
      if (entry.entityType === 'receipt') {
        await prisma.serviceTicket.update({
          where: { id: entry.entityId },
          data: {
            enverusReceiptStatus: entry.action === 'cancel' ? 'cancelled' : 'submitted',
            enverusReceiptId: enverusItemId,
          },
        }).catch(() => {}); // ticket may have been deleted
      } else if (entry.entityType === 'invoice' || entry.entityType === 'field_ticket') {
        await prisma.invoice.update({
          where: { id: entry.entityId },
          data: {
            enverusStatus: 'submitted',
            enverusReceiptId: enverusItemId,
            enverusSubmittedAt: new Date(),
          },
        }).catch(() => {});
      }

      console.log(
        `[Enverus Queue] ✓ ${entry.entityType} ${entry.action} submitted (${entry.id}) — itemId: ${enverusItemId ?? 'n/a'}`,
      );
    } catch (err: unknown) {
      const isApiError = err instanceof EnverusApiError;
      const isRetryable = isApiError && err.isRetryable;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const statusCode = isApiError ? err.statusCode : null;
      const responseBody = isApiError ? err.responseBody : undefined;

      if (isRetryable && entry.retryCount < MAX_RETRIES) {
        // Retryable — increment count and try again next cycle
        await prisma.enverusSyncQueue.update({
          where: { id: entry.id },
          data: {
            status: 'retrying',
            retryCount: entry.retryCount + 1,
            errorMessage: errorMessage.slice(0, 2000),
            responseStatusCode: statusCode,
            responsePayload: responseBody?.slice(0, 10000),
          },
        });

        console.warn(
          `[Enverus Queue] ↻ Retryable error on ${entry.id} (attempt ${entry.retryCount + 1}/${MAX_RETRIES}): ${errorMessage}`,
        );
      } else {
        // Permanent failure — mark as error
        await prisma.enverusSyncQueue.update({
          where: { id: entry.id },
          data: {
            status: 'error',
            errorMessage: errorMessage.slice(0, 2000),
            responseStatusCode: statusCode,
            responsePayload: responseBody?.slice(0, 10000),
            respondedAt: new Date(),
          },
        });

        console.error(
          `[ENVERUS ALERT] ✗ Permanent failure on ${entry.entityType} ${entry.action} (${entry.id}): ${errorMessage}`,
        );
      }
    }
  } catch (err) {
    console.error('[Enverus Queue] Unexpected error in submission loop:', err);
  } finally {
    isProcessing = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Polling Loop
// ─────────────────────────────────────────────────────────────────────────────

async function pollSubmittedEntries(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    // Find all submitted entries to check. We keep polling entries in
    // 'submitted' status — intermediate buyer-side flips (e.g. InReview)
    // do not change our queue status; that only flips on terminal
    // accepted/rejected. lastSeenStatus tracks the buyer-side string for
    // transition detection between polls.
    const entries = await prisma.enverusSyncQueue.findMany({
      where: { status: 'submitted' },
      orderBy: { submittedAt: 'asc' },
      take: 20, // batch limit
    });

    if (entries.length === 0) return;

    console.log(`[Enverus Poll] Checking ${entries.length} submitted entries...`);

    for (const entry of entries) {
      try {
        if (entry.entityType === 'receipt') {
          await pollReceiptEntry(entry);
        } else if (entry.entityType === 'invoice') {
          await pollInvoiceEntry(entry);
        } else if (entry.entityType === 'field_ticket') {
          await pollFieldTicketEntry(entry);
        }
      } catch (err) {
        console.warn(
          `[Enverus Poll] Error polling ${entry.entityType} ${entry.id}:`,
          err instanceof Error ? err.message : err,
        );
        // Non-fatal — continue with next entry
      }
    }
  } catch (err) {
    console.error('[Enverus Poll] Unexpected error in polling loop:', err);
  } finally {
    isPolling = false;
  }
}

// Slice E: classify the buyer-side status string into a category our
// transition handlers can act on. Anything we don't recognize is
// 'intermediate' so the receipt/invoice keeps polling until terminal.
type StatusCategory = 'approved' | 'paid' | 'disputed' | 'submitted' | 'intermediate';

function categorizeStatus(s: string | null | undefined): StatusCategory {
  if (!s) return 'submitted';
  const lower = s.toLowerCase();
  if (lower === 'approved' || lower === 'accepted') return 'approved';
  if (lower === 'paid') return 'paid';
  if (lower === 'disputed' || lower === 'rejected') return 'disputed';
  if (lower === 'submitted') return 'submitted';
  return 'intermediate';
}

async function pollReceiptEntry(entry: {
  id: string;
  entityId: string;
  enverusItemId: string | null;
  lastSeenStatus: string | null;
}): Promise<void> {
  // Try to poll by itemId first (more reliable), then by receipt number
  let data: Record<string, unknown> | null = null;

  if (entry.enverusItemId) {
    try {
      const result = await pollReceiptById(entry.enverusItemId);
      data = result.body as Record<string, unknown>;
    } catch {
      // Fall through to receipt number lookup
    }
  }

  if (!data) {
    // Look up ticket number for receipt number polling
    const ticket = await prisma.serviceTicket.findUnique({
      where: { id: entry.entityId },
      select: { ticketNumber: true },
    });
    if (!ticket) return;

    const result = await pollReceiptStatus(ticket.ticketNumber);
    const items = result.body?.value;
    if (Array.isArray(items) && items.length > 0) {
      data = items[0] as Record<string, unknown>;
    }
  }

  if (!data) return;

  // Detect status transitions. Slice E: handle the full Submitted →
  // (intermediate) → Approved → Paid lifecycle, plus Disputed at any point.
  const rawStatus = (data.status as string | undefined) ?? null;
  const category = categorizeStatus(rawStatus);
  const previousStatus = entry.lastSeenStatus;
  const statusChanged = (rawStatus ?? null) !== (previousStatus ?? null);

  // Always record what we just saw + when, even on no-op polls.
  await prisma.enverusSyncQueue.update({
    where: { id: entry.id },
    data: {
      lastSeenStatus: rawStatus,
      lastPolledAt: new Date(),
    },
  }).catch(() => {});

  if (category === 'approved' || data.approvedDatetime) {
    await prisma.enverusSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: 'accepted',
        respondedAt: new Date(),
        responsePayload: JSON.stringify(data),
      },
    });

    await prisma.serviceTicket.update({
      where: { id: entry.entityId },
      data: { enverusReceiptStatus: 'approved' },
    }).catch(() => {});

    // Mirror — billing_observation, not just the bare enverusReceiptStatus
    // column above. as_of is Enverus's own approvedDatetime; skip the write
    // entirely rather than fabricate a timestamp if Enverus didn't send one.
    if (data.approvedDatetime) {
      await recordObservation(prisma, { ticketId: entry.entityId }, {
        factKey: 'accepted',
        factValue: { approvedByName: data.approvedByName ?? null },
        source: 'openinvoice',
        asOf: new Date(data.approvedDatetime as string),
      }).catch((err) => console.error('[Enverus Poll] observation write failed (approved):', err));
    }

    console.log(`[Enverus Poll] ✓ Receipt ${entry.entityId} APPROVED`);
    void emitEvent('enverus.receipt.approved', {
      ticketId: entry.entityId,
      queueEntryId: entry.id,
      approvedAt: (data.approvedDatetime as string | undefined) ?? new Date().toISOString(),
    });
  } else if (category === 'paid') {
    await prisma.enverusSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: 'accepted', // queue exits via accepted; the ticket carries 'paid'
        respondedAt: new Date(),
        responsePayload: JSON.stringify(data),
      },
    });

    await prisma.serviceTicket.update({
      where: { id: entry.entityId },
      data: { enverusReceiptStatus: 'paid' },
    }).catch(() => {});

    {
      const paidAt = (data.paidDatetime ?? data.lastActionDatetime) as string | undefined;
      if (paidAt) {
        await recordObservation(prisma, { ticketId: entry.entityId }, {
          factKey: 'paid',
          factValue: { totalAmount: data.totalAmount ?? null },
          source: 'openinvoice',
          asOf: new Date(paidAt),
        }).catch((err) => console.error('[Enverus Poll] observation write failed (paid):', err));
      }
    }

    console.log(`[Enverus Poll] $ Receipt ${entry.entityId} PAID`);
    void emitEvent('enverus.receipt.paid', {
      ticketId: entry.entityId,
      queueEntryId: entry.id,
      paidAt: ((data.paidDatetime ?? data.lastActionDatetime) as string | undefined) ?? new Date().toISOString(),
    });
  } else if (category === 'disputed' || data.disputedDatetime) {
    await prisma.enverusSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: 'rejected',
        respondedAt: new Date(),
        responsePayload: JSON.stringify(data),
        errorMessage: `Disputed by ${data.disputedByName || 'buyer'}`,
      },
    });

    await prisma.serviceTicket.update({
      where: { id: entry.entityId },
      data: { enverusReceiptStatus: 'disputed' },
    }).catch(() => {});

    if (data.disputedDatetime) {
      await recordObservation(prisma, { ticketId: entry.entityId }, {
        factKey: 'disputed',
        factValue: { disputedByName: data.disputedByName ?? null },
        source: 'openinvoice',
        asOf: new Date(data.disputedDatetime as string),
      }).catch((err) => console.error('[Enverus Poll] observation write failed (disputed):', err));
    }

    console.error(
      `[ENVERUS ALERT] ⚠ Receipt ${entry.entityId} DISPUTED by ${data.disputedByName || 'buyer'}`,
    );
    void emitEvent('enverus.receipt.disputed', {
      ticketId: entry.entityId,
      queueEntryId: entry.id,
      disputedBy: (data.disputedByName as string | null | undefined) ?? null,
      disputedAt: (data.disputedDatetime as string | undefined) ?? new Date().toISOString(),
    });
  } else if (category === 'intermediate' && statusChanged && rawStatus) {
    // Buyer moved the receipt to a non-terminal state we don't act on
    // (InReview, Pending, etc.) — surface it but keep polling.
    console.log(
      `[Enverus Poll] Receipt ${entry.entityId} status flipped: ${previousStatus ?? '(none)'} → ${rawStatus}`,
    );
    void emitEvent('enverus.receipt.status_flipped', {
      ticketId: entry.entityId,
      queueEntryId: entry.id,
      fromStatus: previousStatus,
      toStatus: rawStatus,
      flippedAt: (data.lastActionDatetime as string | undefined) ?? new Date().toISOString(),
    });
  }
  // else still 'Submitted' / unchanged — no change
}

async function pollInvoiceEntry(entry: {
  id: string;
  entityId: string;
  enverusItemId: string | null;
  lastSeenStatus: string | null;
}): Promise<void> {
  // For invoices, we poll by buyer DUNS from the invoice's company billing profile
  const invoice = await prisma.invoice.findUnique({
    where: { id: entry.entityId },
    include: {
      company: {
        include: {
          billingProfiles: {
            where: { enverusEnabled: true, isActive: true },
            take: 1,
            select: { buyerDuns: true },
          },
        },
      },
    },
  });

  if (!invoice?.company?.billingProfiles?.[0]?.buyerDuns) return;

  const buyerDuns = invoice.company.billingProfiles[0].buyerDuns as string;

  try {
    const result = await pollInvoiceResponses(buyerDuns, 'received');
    const items = result.body?.value;

    if (!Array.isArray(items)) return;

    // Try to find our invoice in the responses
    const match = items.find((item: unknown) => {
      const i = item as Record<string, unknown>;
      return (
        i.invoiceNumber === invoice.invoiceNumber ||
        i.itemID === entry.enverusItemId
      );
    });

    if (!match) return;

    const matchData = match as Record<string, unknown>;
    const responseStatus = matchData.status as string | undefined;

    const category = categorizeStatus(responseStatus);
    const previousStatus = entry.lastSeenStatus;
    const statusChanged = (responseStatus ?? null) !== (previousStatus ?? null);

    await prisma.enverusSyncQueue.update({
      where: { id: entry.id },
      data: {
        lastSeenStatus: responseStatus ?? null,
        lastPolledAt: new Date(),
      },
    }).catch(() => {});

    // No billing_observation write in this branch — pollInvoiceResponses'
    // $filter-based response doesn't surface a modification timestamp (see
    // the emitEvent calls below falling back to new Date()), and Rule 3
    // forbids stamping the sync-run time as as_of. The field-ticket poll
    // below (pollReceiptStatus) does carry real timestamps and mirrors them.
    if (category === 'approved') {
      await prisma.enverusSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: 'accepted',
          respondedAt: new Date(),
          responsePayload: JSON.stringify(matchData),
        },
      });

      await prisma.invoice.update({
        where: { id: entry.entityId },
        data: { enverusStatus: 'accepted' },
      }).catch(() => {});

      console.log(`[Enverus Poll] ✓ Invoice ${invoice.invoiceNumber} ACCEPTED`);
      void emitEvent('enverus.invoice.approved', {
        invoiceId: entry.entityId,
        queueEntryId: entry.id,
        invoiceNumber: invoice.invoiceNumber,
        sourceEntityType: 'invoice',
        approvedAt: new Date().toISOString(),
      });
    } else if (category === 'paid') {
      await prisma.enverusSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: 'accepted',
          respondedAt: new Date(),
          responsePayload: JSON.stringify(matchData),
        },
      });

      await prisma.invoice.update({
        where: { id: entry.entityId },
        data: { enverusStatus: 'paid' },
      }).catch(() => {});

      console.log(`[Enverus Poll] $ Invoice ${invoice.invoiceNumber} PAID`);
      void emitEvent('enverus.invoice.paid', {
        invoiceId: entry.entityId,
        queueEntryId: entry.id,
        invoiceNumber: invoice.invoiceNumber,
        sourceEntityType: 'invoice',
        paidAt: new Date().toISOString(),
      });
    } else if (category === 'disputed') {
      await prisma.enverusSyncQueue.update({
        where: { id: entry.id },
        data: {
          status: 'rejected',
          respondedAt: new Date(),
          responsePayload: JSON.stringify(matchData),
          errorMessage: `Disputed/Rejected by buyer`,
        },
      });

      await prisma.invoice.update({
        where: { id: entry.entityId },
        data: { enverusStatus: 'disputed' },
      }).catch(() => {});

      console.error(
        `[ENVERUS ALERT] ⚠ Invoice ${invoice.invoiceNumber} DISPUTED/REJECTED`,
      );
      void emitEvent('enverus.invoice.disputed', {
        invoiceId: entry.entityId,
        queueEntryId: entry.id,
        invoiceNumber: invoice.invoiceNumber,
        sourceEntityType: 'invoice',
        disputedBy: null, // pollInvoiceResponses doesn't surface this
        disputedAt: new Date().toISOString(),
      });
    } else if (category === 'intermediate' && statusChanged && responseStatus) {
      console.log(
        `[Enverus Poll] Invoice ${invoice.invoiceNumber} status flipped: ${previousStatus ?? '(none)'} → ${responseStatus}`,
      );
      void emitEvent('enverus.invoice.status_flipped', {
        invoiceId: entry.entityId,
        queueEntryId: entry.id,
        invoiceNumber: invoice.invoiceNumber,
        sourceEntityType: 'invoice',
        fromStatus: previousStatus,
        toStatus: responseStatus,
        flippedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    // Non-fatal — will retry on next poll cycle
    console.warn(
      `[Enverus Poll] Could not poll invoice responses for buyer ${buyerDuns}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function pollFieldTicketEntry(entry: {
  id: string;
  entityId: string;
  enverusItemId: string | null;
  lastSeenStatus: string | null;
}): Promise<void> {
  // After the PIDX rip, all field_ticket queue entries submit via
  // receipt.submit, so they're polled as receipts (by itemId or invoice number).
  let data: Record<string, unknown> | null = null;

  if (entry.enverusItemId) {
    try {
      const result = await pollReceiptById(entry.enverusItemId);
      data = result.body as Record<string, unknown>;
    } catch {
      // fall through to receipt-number lookup
    }
  }

  if (!data) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: entry.entityId },
      select: { invoiceNumber: true },
    });
    if (!invoice) return;

    const result = await pollReceiptStatus(invoice.invoiceNumber);
    const items = result.body?.value;
    if (Array.isArray(items) && items.length > 0) {
      data = items[0] as Record<string, unknown>;
    }
  }

  if (!data) return;

  const invoice = await prisma.invoice.findUnique({
    where: { id: entry.entityId },
    select: { invoiceNumber: true },
  });
  if (!invoice) return;

  const rawStatus = (data.status as string | undefined) ?? null;
  const category = categorizeStatus(rawStatus);
  const previousStatus = entry.lastSeenStatus;
  const statusChanged = (rawStatus ?? null) !== (previousStatus ?? null);

  await prisma.enverusSyncQueue.update({
    where: { id: entry.id },
    data: {
      lastSeenStatus: rawStatus,
      lastPolledAt: new Date(),
    },
  }).catch(() => {});

  if (category === 'approved' || data.approvedDatetime) {
    await prisma.enverusSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: 'accepted',
        respondedAt: new Date(),
        responsePayload: JSON.stringify(data),
      },
    });

    await prisma.invoice.update({
      where: { id: entry.entityId },
      data: { enverusStatus: 'accepted' },
    }).catch(() => {});

    if (data.approvedDatetime) {
      await recordDocRefObservationByDocNumber(prisma, invoice.invoiceNumber, {
        factKey: 'accepted',
        factValue: { approvedByName: data.approvedByName ?? null },
        source: 'openinvoice',
        asOf: new Date(data.approvedDatetime as string),
      });
    }

    console.log(`[Enverus Poll] Field ticket ${invoice.invoiceNumber} APPROVED`);
    void emitEvent('enverus.invoice.approved', {
      invoiceId: entry.entityId,
      queueEntryId: entry.id,
      invoiceNumber: invoice.invoiceNumber,
      sourceEntityType: 'field_ticket',
      approvedAt: (data.approvedDatetime as string | undefined) ?? new Date().toISOString(),
    });
  } else if (category === 'paid') {
    await prisma.enverusSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: 'accepted',
        respondedAt: new Date(),
        responsePayload: JSON.stringify(data),
      },
    });

    await prisma.invoice.update({
      where: { id: entry.entityId },
      data: { enverusStatus: 'paid' },
    }).catch(() => {});

    {
      const paidAt = (data.paidDatetime ?? data.lastActionDatetime) as string | undefined;
      if (paidAt) {
        await recordDocRefObservationByDocNumber(prisma, invoice.invoiceNumber, {
          factKey: 'paid',
          factValue: { totalAmount: data.totalAmount ?? null },
          source: 'openinvoice',
          asOf: new Date(paidAt),
        });
      }
    }

    console.log(`[Enverus Poll] $ Field ticket ${invoice.invoiceNumber} PAID`);
    void emitEvent('enverus.invoice.paid', {
      invoiceId: entry.entityId,
      queueEntryId: entry.id,
      invoiceNumber: invoice.invoiceNumber,
      sourceEntityType: 'field_ticket',
      paidAt: ((data.paidDatetime ?? data.lastActionDatetime) as string | undefined) ?? new Date().toISOString(),
    });
  } else if (category === 'disputed' || data.disputedDatetime) {
    await prisma.enverusSyncQueue.update({
      where: { id: entry.id },
      data: {
        status: 'rejected',
        respondedAt: new Date(),
        responsePayload: JSON.stringify(data),
        errorMessage: `Disputed by ${data.disputedByName || 'buyer'}`,
      },
    });

    await prisma.invoice.update({
      where: { id: entry.entityId },
      data: { enverusStatus: 'disputed' },
    }).catch(() => {});

    if (data.disputedDatetime) {
      await recordDocRefObservationByDocNumber(prisma, invoice.invoiceNumber, {
        factKey: 'disputed',
        factValue: { disputedByName: data.disputedByName ?? null },
        source: 'openinvoice',
        asOf: new Date(data.disputedDatetime as string),
      });
    }

    console.error(
      `[ENVERUS ALERT] Field ticket ${invoice.invoiceNumber} DISPUTED by ${data.disputedByName || 'buyer'}`,
    );
    void emitEvent('enverus.invoice.disputed', {
      invoiceId: entry.entityId,
      queueEntryId: entry.id,
      invoiceNumber: invoice.invoiceNumber,
      sourceEntityType: 'field_ticket',
      disputedBy: (data.disputedByName as string | null | undefined) ?? null,
      disputedAt: (data.disputedDatetime as string | undefined) ?? new Date().toISOString(),
    });
  } else if (category === 'intermediate' && statusChanged && rawStatus) {
    console.log(
      `[Enverus Poll] Field ticket ${invoice.invoiceNumber} status flipped: ${previousStatus ?? '(none)'} → ${rawStatus}`,
    );
    void emitEvent('enverus.invoice.status_flipped', {
      invoiceId: entry.entityId,
      queueEntryId: entry.id,
      invoiceNumber: invoice.invoiceNumber,
      sourceEntityType: 'field_ticket',
      fromStatus: previousStatus,
      toStatus: rawStatus,
      flippedAt: (data.lastActionDatetime as string | undefined) ?? new Date().toISOString(),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export function startEnverusQueueProcessor(): void {
  // Skip if Enverus is not configured
  if (!process.env.ENVERUS_PFX_PATH) {
    console.log('[Enverus Queue] Skipped — ENVERUS_PFX_PATH not configured');
    return;
  }

  // Name the tenant out loud. A sandbox holding a copy of production data is
  // indistinguishable from production in the console otherwise, and "which
  // Enverus am I submitting to" is the one question worth never guessing at.
  const baseUrl = process.env.ENVERUS_BASE_URL || 'https://onboard-api.openinvoice.com';
  const tenant = baseUrl.includes('onboard-api') ? 'SANDBOX' : 'PRODUCTION';
  console.log(
    `[Enverus Queue] Starting processor — ${tenant} (${baseUrl}), submit every ${SUBMIT_INTERVAL_MS / 1000}s, poll every ${POLL_INTERVAL_MS / 1000}s`,
  );

  // Run submission loop. runScheduledJob serializes across instances via the
  // Redis lock and records each tick to job_runs. The TTLs leave headroom
  // beyond worst-case fn duration so a slow run can't be lapped.
  const runSubmit = () => { heartbeat('enverus'); return runScheduledJob('enverus.submit', 600, processNextSubmission); };
  const runPoll = () => { heartbeat('enverus'); return runScheduledJob('enverus.poll', 900, pollSubmittedEntries); };

  submitTimer = setInterval(runSubmit, SUBMIT_INTERVAL_MS);
  pollTimer = setInterval(runPoll, POLL_INTERVAL_MS);

  // Also run once immediately on startup (after a short delay for server warmup)
  setTimeout(runSubmit, 5000);
  setTimeout(runPoll, 10000);
}

export function stopEnverusQueueProcessor(): void {
  if (submitTimer) {
    clearInterval(submitTimer);
    submitTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log('[Enverus Queue] Processor stopped');
}
