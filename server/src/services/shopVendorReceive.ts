/**
 * shopVendorReceive.ts — WI-09: what the receive moment has to capture.
 *
 * Sending a unit out and getting it back already worked. What came back with it
 * did not: an invoice that existed only as a PDF somebody had to open, and a
 * yes/no `isWarranty` flag standing in for a four-way business decision.
 *
 * FOUR DISPOSITIONS, NOT A BOOLEAN. Three of the four are non-billable, and the
 * reasons are not interchangeable. "The vendor covered it", "we chose to eat
 * it", and "this was our own gear" produce an identical invoice and completely
 * different answers when somebody asks, a quarter later, what outside service
 * actually cost. A boolean throws that away at the moment it is cheapest to
 * record.
 *
 * THE DISPOSITION IS REQUIRED TO RECEIVE. Not because the tech always knows,
 * but because "nobody decided yet" and "not billable" are indistinguishable
 * once the unit is back on the shelf — and the ambiguity resolves in the
 * customer's favour every single time, silently. Making it required is the only
 * version of this that stays true after the first busy week.
 *
 * ── THE NOTES FIELD ──────────────────────────────────────────────────────
 *
 * The spec asks that the billing notes be impossible to parse for amounts,
 * rather than merely discouraged. That is a real distinction and it is worth
 * saying how it is achieved, because it is not achieved here:
 *
 *   `vendorBillingNotes` is a column on ShopWorkOrderItem that is deliberately
 *   ABSENT from `ShopBillingItem` — the projection type the billing derivation
 *   is handed. `buildShopBillingLines` receives a value whose type has no such
 *   field. A future author who wants to scrape dollar amounts out of the notes
 *   cannot; they would first have to widen the projection, in a different file,
 *   in a diff that says exactly what they are doing.
 *
 * That is why the notes went into their own column instead of into the existing
 * `billing` JSONB blob: the blob is passed through whole, so anything inside it
 * is reachable. A field is only unreadable if it is genuinely not there.
 *
 * Vendor cost comes from `vendorInvoiceTotal`; an override uses the selected service price.
 */

import type { PrismaClient, AttachmentKind, ShopVendorDisposition } from '../db.js';

/** Check durable ticket paperwork, never a client-supplied count or filename. */
export async function vendorReturnDocumentError(
  db: Pick<PrismaClient, 'attachment'>,
  shopItemId: string,
  disposition: ShopVendorDisposition,
): Promise<string | null> {
  const kinds: AttachmentKind[] = disposition === 'warranty'
    ? ['vendor_invoice', 'packing_slip'] : ['vendor_invoice'];
  const count = await db.attachment.count({
    where: {
      shopItemId,
      kind: { in: kinds },
      fileSizeBytes: { gt: 0 },
      OR: [{ bufferKey: { not: null } }, { remoteKey: { not: null } }],
    },
  });
  if (count > 0) return null;
  return disposition === 'warranty'
    ? 'Attach a vendor invoice or packing slip to this ticket before receiving a warranty return. Wait for the upload to finish.'
    : 'Attach a vendor invoice to this ticket before receiving the unit back. Wait for the upload to finish.';
}

export const VENDOR_DISPOSITIONS: ShopVendorDisposition[] = [
  'warranty',
  'pass_thru_repair',
  'no_charge',
  'internal',
];

export const VENDOR_DISPOSITION_LABEL: Record<ShopVendorDisposition, string> = {
  warranty: 'Warranty — vendor covered it',
  pass_thru_repair: 'Billable vendor work — pass-through or catalog service',
  no_charge: 'No charge / goodwill',
  internal: 'Internal — Basin’s own equipment',
};

/** Statuses a unit is in while it is out at a vendor. */
export const SENT_OUT_STATUSES: readonly string[] = ['outside_service', 'warranty_out'];

/**
 * The ONE disposition that bills the customer.
 *
 * Written as a positive test against a single value rather than as a list of
 * exclusions, so a fifth disposition added later defaults to non-billable. A
 * new value that silently starts charging customers is the failure mode worth
 * designing against.
 */
export function isCustomerBillableDisposition(
  disposition: ShopVendorDisposition | null | undefined,
): boolean {
  return disposition === 'pass_thru_repair';
}

/** Every disposition that suppresses customer billing (i.e. all but one). */
export function suppressesCustomerBilling(
  disposition: ShopVendorDisposition | null | undefined,
): boolean {
  return disposition != null && !isCustomerBillableDisposition(disposition);
}

export function isVendorDisposition(v: unknown): v is ShopVendorDisposition {
  return typeof v === 'string' && (VENDOR_DISPOSITIONS as string[]).includes(v);
}

export interface ReceivePayload {
  disposition: ShopVendorDisposition;
  invoiceNumber: string | null;
  invoiceTotal: number | null;
  allocationNote: string | null;
  billingNotes: string | null;
  receivedBackNotes: string | null;
  billingMode?: 'passthrough' | 'catalog_service';
  service?: unknown;
}

export interface ReceiveParseResult {
  ok: boolean;
  error?: string;
  payload?: ReceivePayload;
}

/**
 * Validate and normalise what the receive step sends.
 *
 * Returns a verdict rather than throwing so the two call sites (the dedicated
 * receive endpoint and the plain status transition, which is the path the UI
 * actually uses) can share one implementation and raise their own errors.
 */
export function parseReceivePayload(body: unknown): ReceiveParseResult {
  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  const disposition = src.vendorDisposition;
  if (!isVendorDisposition(disposition)) {
    return {
      ok: false,
      error:
        'Receiving a unit back from a vendor needs a billable-to-customer selection. '
        + `Choose one of: ${VENDOR_DISPOSITIONS.join(', ')}.`,
    };
  }

  // The keyed total. Parsed strictly: an unparseable total is rejected rather
  // than quietly becoming 0, because 0 is a real and very different claim.
  let invoiceTotal: number | null = null;
  const rawTotal = src.vendorInvoiceTotal;
  if (rawTotal !== undefined && rawTotal !== null && rawTotal !== '') {
    const n = typeof rawTotal === 'number' ? rawTotal : Number(String(rawTotal).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) {
      return { ok: false, error: 'The vendor invoice total is not a number.' };
    }
    if (n < 0) {
      return {
        ok: false,
        error:
          'The vendor invoice total cannot be negative. A credit note is a real thing, '
          + 'but it is not an invoice total — record it on the billing card instead.',
      };
    }
    invoiceTotal = Math.round(n * 100) / 100;
  }

  // A pass-through with nothing to pass through bills the customer nothing and
  // says nothing about it. Caught here as well as at the database, because the
  // person who can still fix it is standing at the counter right now.
  if (disposition === 'pass_thru_repair' && invoiceTotal === null) {
    return {
      ok: false,
      error:
        'Billable vendor work needs the vendor invoice total recorded as our cost. '
        + 'Choose cost pass-through or catalog service billing on the unit.',
    };
  }

  const billingMode = src.vendorBillingMode ?? 'passthrough';
  if (disposition === 'pass_thru_repair') {
    if (billingMode !== 'passthrough' && billingMode !== 'catalog_service') {
      return { ok: false, error: 'Choose bill through or override with our service.' };
    }
    if (billingMode === 'catalog_service' && !src.vendorService) {
      return { ok: false, error: 'Select the service to bill for the override.' };
    }
  }
  const str = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

  return {
    ok: true,
    payload: {
      disposition,
      ...(disposition === 'pass_thru_repair' ? {
        billingMode: billingMode as 'passthrough' | 'catalog_service',
        ...(billingMode === 'catalog_service' ? { service: src.vendorService } : {}),
      } : {}),
      invoiceNumber: str(src.vendorInvoiceNumber, 100),
      invoiceTotal,
      allocationNote: str(src.vendorInvoiceAllocationNote, 500),
      billingNotes: str(src.vendorBillingNotes, 4000),
      receivedBackNotes: str(src.receivedBackNotes, 2000),
    },
  };
}

/** The columns a receive writes. Shared so both paths write the same shape. */
export function receiveUpdateData(payload: ReceivePayload, now: Date = new Date()) {
  return {
    status: 'received' as const,
    receivedBackDate: now,
    receivedBackNotes: payload.receivedBackNotes,
    vendorDisposition: payload.disposition,
    vendorInvoiceNumber: payload.invoiceNumber,
    vendorInvoiceTotal: payload.invoiceTotal,
    vendorInvoiceAllocationNote: payload.allocationNote,
    vendorBillingNotes: payload.billingNotes,
  };
}

/** A one-line summary for the status log — what a person reads six weeks later. */
export function receiveLogNote(payload: ReceivePayload): string {
  const bits = [
    `Received back — ${VENDOR_DISPOSITION_LABEL[payload.disposition]}`,
    payload.billingMode === 'catalog_service' ? 'override with our catalog service' : payload.billingMode === 'passthrough' ? 'bill through vendor cost' : null,
    payload.invoiceTotal !== null ? `invoice total $${payload.invoiceTotal.toFixed(2)}` : null,
    payload.invoiceNumber ? `inv ${payload.invoiceNumber}` : null,
    payload.allocationNote ? `(${payload.allocationNote})` : null,
    payload.receivedBackNotes,
  ].filter(Boolean);
  return bits.join(' — ').slice(0, 500);
}
