/**
 * The rental-linked ticket disposition rule.
 *
 * The claim under test is the AXIS of the decision. The rule used to be
 * "is the rental manned?", which was wrong in both directions:
 *
 *   - a MANNED daily carrying a real 461 line got closed as a non-billable
 *     record, silently dropping the charge;
 *   - an UNMANNED rental's empty log ticket was left to march into
 *     `billing_queue`, a status that renders nowhere for a rental-linked ticket
 *     (GET /invoices/uninvoiced/tickets excludes them all, by design, so they
 *     can't double-bill) — so it read "Billing Queue" on the ticket and was
 *     absent from the billing queue, permanently.
 *
 * The axis is BILLABILITY, and mannedness doesn't appear here at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();

// The service reaches for the live client via ../db.js, which opens a real
// connection on import. Only the one line-item lookup matters here.
vi.mock('../db.js', () => ({
  prisma: { ticketLineItem: { findFirst } },
  Prisma: { InputJsonValue: {} },
}));

const { shouldRecordOnly, hasBillableLines } = await import('./rentalTicketRecord.js');

beforeEach(() => findFirst.mockReset());

describe('shouldRecordOnly', () => {
  it('leaves a ticket with no rental alone, and does not even look at its lines', async () => {
    expect(await shouldRecordOnly({ id: 't1', linkedRentalAgreementId: null })).toBe(false);
    // A standalone field ticket bills through the normal queue. Querying its
    // lines here would be harmless but pointless — assert we short-circuit.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('closes a rental-linked ticket with nothing to charge', async () => {
    findFirst.mockResolvedValue(null);
    expect(await shouldRecordOnly({ id: 't2', linkedRentalAgreementId: 'ra1' })).toBe(true);
  });

  it('does NOT close a rental-linked ticket that carries a real charge', async () => {
    // The regression: FS-2026-00056's $150 mileage, and the $1,050 manned
    // daily. Both must survive to roll onto the rental's invoice.
    findFirst.mockResolvedValue({ id: 'li1' });
    expect(await shouldRecordOnly({ id: 't3', linkedRentalAgreementId: 'ra1' })).toBe(false);
  });
});

describe('hasBillableLines', () => {
  it('counts only lines that actually charge', async () => {
    findFirst.mockResolvedValue(null);
    expect(await hasBillableLines('t4')).toBe(false);

    // A line totalling 0 is deliberately free/included, or a qty-0 note line
    // (the "Equipment used:" annotation). Neither is a charge, so the filter
    // has to be `total > 0` — matching on the mere EXISTENCE of a line item
    // would keep every log-only ticket in the billing queue.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ticketId: 't4', total: { gt: 0 } },
      }),
    );
  });
});
