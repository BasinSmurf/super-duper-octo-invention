/**
 * WI-09 — the external-vendor receive step.
 *
 * The load-bearing claim is the one the spec asked to be enforced structurally:
 * the billing notes are human-read only and can never contribute to a number.
 * That is a property of the SHAPE (see `toBillingItem`), so it is tested by
 * putting the most tempting possible content in the notes and asserting the
 * output does not move.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  VENDOR_DISPOSITIONS,
  isCustomerBillableDisposition,
  parseReceivePayload,
  receiveLogNote,
  receiveUpdateData,
  suppressesCustomerBilling,
  vendorReturnDocumentError,
} from './shopVendorReceive.js';
import {
  buildShopBillingLines,
  isBillableShopItem,
  toBillingItem,
  type ShopBillingItem,
} from './shopBillingLines.js';

describe('vendor return documents', () => {
  function database(documents: Array<{ shopItemId: string; kind: string; fileSizeBytes: number; bufferKey: string | null; remoteKey: string | null }>) {
    const count = vi.fn(async ({ where }: any) => documents.filter(d =>
      d.shopItemId === where.shopItemId && where.kind.in.includes(d.kind)
      && d.fileSizeBytes > where.fileSizeBytes.gt && (d.bufferKey !== null || d.remoteKey !== null),
    ).length);
    return { attachment: { count } } as unknown as Parameters<typeof vendorReturnDocumentError>[0];
  }
  const invoice = { shopItemId: 'item-1', kind: 'vendor_invoice', fileSizeBytes: 100, bufferKey: 'buffer/invoice', remoteKey: null };

  it.each(VENDOR_DISPOSITIONS)('requires an actual saved return document for %s', async disposition => {
    expect(await vendorReturnDocumentError(database([]), 'item-1', disposition)).toMatch(/Attach/);
    expect(await vendorReturnDocumentError(database([invoice]), 'item-1', disposition)).toBeNull();
  });

  it.each(VENDOR_DISPOSITIONS)('accepts a packing slip only for warranty, not %s otherwise', async disposition => {
    const error = await vendorReturnDocumentError(database([{ ...invoice, kind: 'packing_slip' }]), 'item-1', disposition);
    expect(error === null).toBe(disposition === 'warranty');
  });

  it('rejects serial test paperwork, another ticket, empty files and metadata without stored bytes', async () => {
    for (const document of [
      { ...invoice, kind: 'test_paperwork' },
      { ...invoice, shopItemId: 'another-item' },
      { ...invoice, fileSizeBytes: 0 },
      { ...invoice, bufferKey: null },
    ]) {
      expect(await vendorReturnDocumentError(database([document]), 'item-1', 'warranty')).not.toBeNull();
    }
  });

  it('accepts remote bytes after the buffer has been cleared', async () => {
    expect(await vendorReturnDocumentError(database([{ ...invoice, bufferKey: null, remoteKey: 'remote/invoice' }]), 'item-1', 'internal')).toBeNull();
  });
});

function item(overrides: Partial<ShopBillingItem> = {}): ShopBillingItem {
  return {
    id: 'i1',
    status: 'shop_complete',
    isWarranty: false,
    parentItemId: null,
    serialNumber: 'FE-1001',
    equipmentCategory: 'fire_extinguisher',
    equipmentDescription: null,
    serviceType: 'repair',
    productId: 'p1',
    partsUsed: null,
    billing: null,
    customData: null,
    hardClosesAt: null,
    vendorDisposition: null,
    vendorInvoiceTotal: null,
    product: { id: 'p1', partNumber: 'FE-1', name: 'Extinguisher service', defaultSellPrice: 25 },
    ...overrides,
  };
}

describe('parseReceivePayload', () => {
  it('refuses a receive with no billable-to-customer selection', () => {
    const r = parseReceivePayload({ receivedBackNotes: 'came back fine' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/billable-to-customer/i);
  });

  it('refuses a disposition that is not one of the four', () => {
    expect(parseReceivePayload({ vendorDisposition: 'free' }).ok).toBe(false);
  });

  it('accepts each of the four', () => {
    for (const d of VENDOR_DISPOSITIONS) {
      const body: Record<string, unknown> = { vendorDisposition: d };
      // pass-through is the one that also needs a number; see below.
      if (d === 'pass_thru_repair') body.vendorInvoiceTotal = 10;
      expect(parseReceivePayload(body).ok).toBe(true);
    }
  });

  it('refuses a pass-thru repair with no keyed total', () => {
    // Without it the vendor cost is never billed — silently. That is worse
    // than an error, because nobody finds out.
    const r = parseReceivePayload({ vendorDisposition: 'pass_thru_repair' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/total/i);
  });

  it('parses a keyed total out of what a human actually types', () => {
    const r = parseReceivePayload({ vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: '$1,234.56' });
    expect(r.payload!.invoiceTotal).toBe(1234.56);
  });

  it('rejects an unparseable total instead of quietly calling it zero', () => {
    // 0 is a real and very different claim from "I could not read this".
    const r = parseReceivePayload({ vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: 'about a grand' });
    expect(r.ok).toBe(false);
  });

  it('rejects a negative total', () => {
    const r = parseReceivePayload({ vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: -50 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/negative/i);
  });

  it('allows a zero total on a non-pass-through disposition', () => {
    const r = parseReceivePayload({ vendorDisposition: 'warranty', vendorInvoiceTotal: 0 });
    expect(r.ok).toBe(true);
    expect(r.payload!.invoiceTotal).toBe(0);
  });

  it('keeps the allocation note and the billing notes as separate fields', () => {
    const r = parseReceivePayload({
      vendorDisposition: 'pass_thru_repair',
      vendorInvoiceTotal: 100,
      vendorInvoiceAllocationNote: 'only lines 1 and 3 of this invoice',
      vendorBillingNotes: 'lines 1, 3, 5 from the DFE invoice bill to items 1-4',
    });
    expect(r.payload!.allocationNote).toBe('only lines 1 and 3 of this invoice');
    expect(r.payload!.billingNotes).toBe('lines 1, 3, 5 from the DFE invoice bill to items 1-4');
  });

  it('rounds to cents rather than carrying float noise into a Decimal column', () => {
    const r = parseReceivePayload({ vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: 10.005 });
    expect(r.payload!.invoiceTotal).toBe(10.01);
  });
});

describe('disposition semantics', () => {
  it('bills the customer for exactly one of the four', () => {
    const billable = VENDOR_DISPOSITIONS.filter(isCustomerBillableDisposition);
    expect(billable).toEqual(['pass_thru_repair']);
  });

  it('treats a not-stated disposition as not-suppressing', () => {
    // Every row before WI-09. These keep being decided by isWarranty and the
    // billing chunk, exactly as they were.
    expect(suppressesCustomerBilling(null)).toBe(false);
    expect(suppressesCustomerBilling(undefined)).toBe(false);
  });

  it('suppresses the other three', () => {
    expect(suppressesCustomerBilling('warranty')).toBe(true);
    expect(suppressesCustomerBilling('no_charge')).toBe(true);
    expect(suppressesCustomerBilling('internal')).toBe(true);
  });
});

describe('isBillableShopItem — vendor disposition', () => {
  it('keeps a pass-thru repair billable', () => {
    expect(isBillableShopItem(item({ vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: 100 }))).toBe(true);
  });

  for (const d of ['warranty', 'no_charge', 'internal'] as const) {
    it(`withholds a ${d} unit from billing`, () => {
      expect(isBillableShopItem(item({ vendorDisposition: d, vendorInvoiceTotal: 500 }))).toBe(false);
    });
  }

  it('leaves pre-WI-09 rows exactly as they were', () => {
    expect(isBillableShopItem(item({ vendorDisposition: null }))).toBe(true);
  });
});

describe('the keyed total drives the passthrough amount', () => {
  it('emits a passthrough line from the keyed total alone', () => {
    const lines = buildShopBillingLines([
      item({ vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: 240 }),
    ]);
    const pass = lines.find((l) => l.description.startsWith('Outside vendor service'));
    expect(pass).toBeTruthy();
    expect(pass!.total).toBe(240);
  });

  it('lets an explicit billing-card cost override the keyed total', () => {
    // The keyed total is what the vendor charged; the billing-card figure is a
    // later, more specific decision about what to charge through.
    const lines = buildShopBillingLines([
      item({
        vendorDisposition: 'pass_thru_repair',
        vendorInvoiceTotal: 240,
        billing: { vendor: { cost: 180 } },
      }),
    ]);
    const pass = lines.find((l) => l.description.startsWith('Outside vendor service'));
    expect(pass!.total).toBe(180);
  });

  it('applies freight and markup to the keyed total', () => {
    const lines = buildShopBillingLines([
      item({
        vendorDisposition: 'pass_thru_repair',
        vendorInvoiceTotal: 100,
        billing: { vendor: { markupPct: 20, freight: 15 } },
      }),
    ]);
    const pass = lines.find((l) => l.description.startsWith('Outside vendor service'));
    expect(pass!.total).toBe(135); // 100 * 1.2 + 15
  });

  it('emits NO passthrough line for a warranty unit, even with a cost recorded', () => {
    // Belt and braces: isBillableShopItem already filters these out upstream.
    // A warranty unit's vendor cost reaching an invoice is exactly the failure
    // that must not be possible by a route somebody forgot to guard.
    const lines = buildShopBillingLines([
      item({ vendorDisposition: 'warranty', vendorInvoiceTotal: 900, billing: { vendor: { cost: 900 } } }),
    ]);
    expect(lines.some((l) => l.description.startsWith('Outside vendor service'))).toBe(false);
  });
});

// ============================================================
// THE ONE THE SPEC ASKED FOR
// ============================================================

describe('billing notes are never consumed by a calculation', () => {
  /** The most tempting content a notes field could possibly hold. */
  const TEMPTING = [
    'Vendor invoice total $9,999.99 — bill all of it',
    'lines 1, 3, 5 from DFE invoice #4471 billable to items 1-4 on this ticket',
    '450.00 freight + 12% markup, charge customer 1200',
    'TOTAL: 5000',
  ].join('\n');

  it('produces byte-identical lines with and without notes', () => {
    const withoutNotes = buildShopBillingLines([
      item({ vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: 240 }),
    ]);
    // The notes are passed the only way they CAN be passed — through the
    // projection — which is to say: not at all.
    const withNotes = buildShopBillingLines([
      toBillingItem({
        ...item({ vendorDisposition: 'pass_thru_repair', vendorInvoiceTotal: 240 }),
        vendorBillingNotes: TEMPTING,
      } as unknown as Record<string, unknown>),
    ]);
    expect(withNotes).toEqual(withoutNotes);
    expect(JSON.stringify(withNotes)).not.toContain('9,999.99');
    expect(JSON.stringify(withNotes)).not.toContain('5000');
  });

  it('drops the notes at the projection boundary', () => {
    // The structural half of the claim: the value handed to the derivation does
    // not merely ignore the notes, it does not contain them. If this assertion
    // ever fails, the wall came down and the rule is back to being a rule.
    const projected = toBillingItem({
      ...item(),
      vendorBillingNotes: TEMPTING,
    } as unknown as Record<string, unknown>);
    expect('vendorBillingNotes' in projected).toBe(false);
    expect(Object.values(projected).join(' ')).not.toContain('9,999.99');
  });

  it('carries the keyed total through the projection', () => {
    // The other half: the number that IS allowed to drive billing survives.
    const projected = toBillingItem({
      ...item({ vendorInvoiceTotal: 240 }),
      vendorBillingNotes: TEMPTING,
    } as unknown as Record<string, unknown>);
    expect(projected.vendorInvoiceTotal).toBe(240);
  });
});

describe('receiveUpdateData / receiveLogNote', () => {
  it('writes every captured field', () => {
    const p = parseReceivePayload({
      vendorDisposition: 'pass_thru_repair',
      vendorInvoiceTotal: '250.00',
      vendorInvoiceNumber: 'DFE-4471',
      vendorInvoiceAllocationNote: 'partial — 2 of 6 lines',
      vendorBillingNotes: 'rest of this invoice belongs to SW-2026-00044',
      receivedBackNotes: 'box was open on arrival',
    }).payload!;
    const data = receiveUpdateData(p, new Date('2026-08-31T12:00:00Z'));
    expect(data.status).toBe('received');
    expect(data.vendorInvoiceTotal).toBe(250);
    expect(data.vendorInvoiceNumber).toBe('DFE-4471');
    expect(data.vendorDisposition).toBe('pass_thru_repair');
    expect(data.vendorBillingNotes).toBe('rest of this invoice belongs to SW-2026-00044');
    expect(data.receivedBackDate).toEqual(new Date('2026-08-31T12:00:00Z'));
  });

  it('summarises the receive for the status log', () => {
    const p = parseReceivePayload({ vendorDisposition: 'warranty', receivedBackNotes: 'no charge' }).payload!;
    const note = receiveLogNote(p);
    expect(note).toMatch(/Warranty/);
    expect(note.length).toBeLessThanOrEqual(500);
  });

  it('keeps the log note inside the column budget for absurd input', () => {
    const p = parseReceivePayload({
      vendorDisposition: 'pass_thru_repair',
      vendorInvoiceTotal: 1,
      vendorInvoiceAllocationNote: 'x'.repeat(500),
      receivedBackNotes: 'y'.repeat(2000),
    }).payload!;
    expect(receiveLogNote(p).length).toBeLessThanOrEqual(500);
  });
});
