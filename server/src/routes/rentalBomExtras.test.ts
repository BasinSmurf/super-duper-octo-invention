import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  rentalAgreement: { findUnique: vi.fn(), update: vi.fn() },
  invoice: { findFirst: vi.fn() },
}));
const prisma = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
import { rentalsRouter } from './rentals.js';
import { correctBomExtras, unpricedCompositionLines } from '../services/rentalComposition.js';

const route = rentalsRouter.stack.find(entry => entry.route?.path === '/:id/bom-extras' && entry.route.methods.put)!.route;
async function save(extras: unknown) {
  const json = vi.fn(), next = vi.fn();
  // stack[0] is requirePermission; exercise the handler itself.
  await route.stack[1].handle({ params: { id: 'r1' }, body: { extras }, user: { userId: 'ar' } }, { json }, next);
  return { json, next };
}

const extras = [
  { id: 'bomx-monitor_personal', label: 'Additional Area Gas Monitor Rental (over baseline)', productId: null, qty: 2, rate: null },
  { id: 'bomx-misc', label: 'Misc (over baseline)', productId: null, qty: 2, rate: null },
];
const composition = { trailer: { manned: true, rate: 0 }, gasMonitors: [], other: [], drillingRig: false,
  bomPackage: { label: 'Package', qty: 1, rate: 500 }, bomExtras: extras };

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation(async callback => callback(tx));
  tx.rentalAgreement.findUnique.mockResolvedValue({ id: 'r1', status: 'completed', composition,
    billingPolicy: { pauses: [], ticketRates: null, compositionHistory: [
      { effectiveDate: '0001-01-01', composition }, { effectiveDate: '2026-10-10', composition: { ...composition, gasMonitors: [] } },
    ] } });
  tx.invoice.findFirst.mockResolvedValue(null);
  tx.rentalAgreement.update.mockImplementation(async ({ data }) => ({ id: 'r1', ...data }));
});

describe('over-baseline extra correction', () => {
  it('prices one extra and drops the other in every composition window, unblocking the invoice', async () => {
    const { json, next } = await save([{ key: 'bomx-monitor_personal', qty: 2, rate: 35 }]);
    expect(next).not.toHaveBeenCalled();
    const data = tx.rentalAgreement.update.mock.calls[0][0].data;
    expect(data.composition.bomExtras).toEqual([{ ...extras[0], rate: 35 }]);
    for (const window of data.billingPolicy.compositionHistory) {
      expect(window.composition.bomExtras).toEqual([{ ...extras[0], rate: 35 }]);
      expect(unpricedCompositionLines(window.composition)).toEqual([]);
    }
    expect(json).toHaveBeenCalled();
  });

  it('removing every extra leaves no bomExtras key behind', async () => {
    await save([]);
    expect('bomExtras' in tx.rentalAgreement.update.mock.calls[0][0].data.composition).toBe(false);
  });

  it('refuses once any invoice exists, since extras reprice billed days', async () => {
    tx.invoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-1' });
    const { next } = await save([{ key: 'bomx-misc', qty: 2, rate: 10 }]);
    expect(next.mock.calls[0][0].statusCode).toBe(409);
    expect(tx.rentalAgreement.update).not.toHaveBeenCalled();
  });

  it('rejects unknown keys, bad quantities and negative rates', async () => {
    expect((await save([{ key: 'nope', qty: 1, rate: 1 }])).next.mock.calls[0][0].statusCode).toBe(409);
    expect((await save([{ key: 'bomx-misc', qty: 0, rate: 1 }])).next.mock.calls[0][0].statusCode).toBe(400);
    expect((await save([{ key: 'bomx-misc', qty: 1, rate: -5 }])).next.mock.calls[0][0].statusCode).toBe(400);
    expect(tx.rentalAgreement.update).not.toHaveBeenCalled();
  });
});

describe('unpriced extra message', () => {
  it('names an extra once even when deploy already labelled it', () => {
    expect(unpricedCompositionLines({ bomExtras: [{ label: 'Misc (over baseline)', rate: null }] })).toEqual(['Misc (over baseline)']);
    expect(unpricedCompositionLines({ bomExtras: [{ label: 'Monitor', rate: null }] })).toEqual(['Monitor (over baseline)']);
  });
  it('extras without ids are matched by position', () => {
    const out = correctBomExtras({ bomExtras: [{ label: 'A', qty: 1 }, { label: 'B', qty: 1 }] }, [{ key: 'extra-1', qty: 3, rate: 0 }]);
    expect(out.bomExtras).toEqual([{ label: 'B', qty: 3, rate: 0 }]);
  });
});
