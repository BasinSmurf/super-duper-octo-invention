import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({ $transaction: vi.fn(), $queryRaw: vi.fn(), invoice: { findFirst: vi.fn() }, rentalAgreement: { findUnique: vi.fn(), update: vi.fn() } }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
import { rentalsRouter } from './rentals.js';
import { createAuditLog } from '../utils/auditLog.js';

const policy = { pauses: [{ startDate: '2026-09-19', endDate: '2026-09-20' }], ticketRates: { manned: 500, unmanned: 200 } };
const route = rentalsRouter.stack.find(entry => entry.route?.path === '/:id/billing-policy')!.route;
async function save(body: unknown) {
  const json = vi.fn();
  const next = vi.fn();
  await route.stack[1].handle({ params: { id: 'r1' }, body, user: { userId: 'u1' } }, { json }, next);
  return { json, next };
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async action => action(prisma));
  prisma.$queryRaw.mockResolvedValue([]);
  prisma.invoice.findFirst.mockResolvedValue(null);
  prisma.rentalAgreement.findUnique.mockResolvedValue({ id: 'r1', status: 'active', billingPolicy: { pauses: [], ticketRates: null } });
  prisma.rentalAgreement.update.mockResolvedValue({ id: 'r1', billingPolicy: policy });
});
describe('rental billing settings', () => {
  it('saves and audits billing settings without changing job or equipment status', async () => {
    const result = await save(policy);
    expect(result.next).not.toHaveBeenCalled();
    expect(prisma.rentalAgreement.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { billingPolicy: policy } });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'r1', action: 'update',
      changes: { billingPolicy: { before: { pauses: [], ticketRates: null }, after: policy } } }));
  });
  it('rejects malformed settings before writing', async () => {
    const result = await save({ pauses: [{ startDate: '2026-09-21', endDate: '2026-09-20' }] });
    expect(result.next.mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.rentalAgreement.update).not.toHaveBeenCalled();
  });
  it('requires authentication at the billing-settings endpoint', () => {
    const json = vi.fn();
    const next = vi.fn();
    route.stack[0].handle({}, { status: () => ({ json }) }, next);
    expect(json).toHaveBeenCalledWith({ error: 'Not authenticated' });
    expect(next).not.toHaveBeenCalled();
  });
  it('requires an effective date for changed rates, and retains the prior rate', async () => {
    prisma.rentalAgreement.findUnique.mockResolvedValue({ status: 'active', billingPolicy: policy });
    const changed = { pauses: [], ticketRates: { manned: 600, unmanned: 300 } };
    expect((await save(changed)).next.mock.calls[0][0].statusCode).toBe(400);
    const result = await save({ ...changed, effectiveDate: '2026-09-21' });
    expect(result.next).not.toHaveBeenCalled();
    expect(prisma.rentalAgreement.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { billingPolicy: {
      pauses: [], ticketRates: policy.ticketRates, rateChanges: [{ effectiveDate: '2026-09-21', manned: 600, unmanned: 300 }],
    } } });
  });
});

describe('composition revisions', () => {
  const editRoute = () => rentalsRouter.stack.find(entry => entry.route?.path === '/:id' && entry.route?.methods?.put)!.route.stack[0].handle;
  const corrected = { trailer: null, other: [{ label: '2 Bottle Breathing Air System', qty: 1, rate: 45 }] };
  async function correct(body: any = { composition: corrected, compositionCorrection: true, reason: 'Trailer was never on this job' }) {
    const next = vi.fn();
    await editRoute()({ params: { id: 'r1' }, body, user: { userId: 'u1' } }, { json: vi.fn() }, next);
    return next;
  }
  it('resyncs historical billing even when the current RA already has the corrected charges', async () => {
    prisma.rentalAgreement.findUnique.mockResolvedValue({ id: 'r1', composition: corrected, billingPolicy: {
      pauses: [], ticketRates: null, compositionHistory: [
        { effectiveDate: '0001-01-01', composition: { bomPackage: { label: 'Trailer', rate: 500 } } },
        { effectiveDate: '2026-11-11', composition: corrected },
      ],
    } });
    expect(await correct()).not.toHaveBeenCalled();
    expect(prisma.rentalAgreement.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      billingPolicy: { pauses: [], ticketRates: null, compositionHistory: [{ effectiveDate: '0001-01-01', composition: corrected }] },
    }) }));
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ changes: expect.objectContaining({ compositionCorrection: true, reason: 'Trailer was never on this job' }) }));
  });
  it('requires a reason and corrected charges', async () => {
    expect((await correct({ composition: corrected, compositionCorrection: true })).mock.calls[0][0].statusCode).toBe(400);
    expect((await correct({ compositionCorrection: true, reason: 'Fix' })).mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.rentalAgreement.update).not.toHaveBeenCalled();
  });
  it('blocks historical corrections when a non-void invoice exists', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ invoiceNumber: 'INV-1' });
    expect((await correct()).mock.calls[0][0].statusCode).toBe(409);
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith({ where: { rentalAgreementId: 'r1', status: { not: 'void' } } });
    expect(prisma.rentalAgreement.update).not.toHaveBeenCalled();
  });
  it('preserves the original contract and records a dated revision', async () => {
    const before = {gasMonitors:[{productId:'p',qty:1,rate:10}]};
    const after = {gasMonitors:[{productId:'p',qty:1,rate:20}]};
    prisma.rentalAgreement.findUnique.mockResolvedValue({id:'r1',status:'active',composition:before,billingPolicy:{pauses:[],ticketRates:null}});
    const update = rentalsRouter.stack.find(entry => entry.route?.path === '/:id' && entry.route?.methods?.put)!.route.stack[0].handle;
    const next=vi.fn();
    await update({params:{id:'r1'},body:{composition:after,effectiveDate:'2026-08-16'}},{json:vi.fn()},next);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.rentalAgreement.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({billingPolicy:{pauses:[],ticketRates:null,compositionHistory:[{effectiveDate:'0001-01-01',composition:before},{effectiveDate:'2026-08-16',composition:after}]}})}));
  });
});
