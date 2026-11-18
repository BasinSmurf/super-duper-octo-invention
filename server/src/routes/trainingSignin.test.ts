import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  serviceTicket: { findFirst: vi.fn(), findUnique: vi.fn() },
  trainingRosterRecord: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(), $queryRaw: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../services/employerMatch.js', () => ({ matchEmployer: vi.fn(async () => ({ companyId: 'employer' })) }));
import { trainingSigninRouter } from './trainingSignin.js';
const serviceDate = new Date('2026-09-24T00:00:00.000Z');
const signature = 'data:image/png;base64,synthetic';
const ticket = { id: 'class', status: 'draft', serviceDate, customData: { courseName: 'H2S CLEAR' }, _count: { trainingRosterRecords: 1 } };
const preregistered = { id: 'student', employeeName: 'SYNTHETIC STUDENT', employerName: 'SYNTHETIC CUSTOMER', employerCompanyId: 'employer', participantSignature: null, contactPhone: null, contactEmail: null };
async function signIn() {
  const route = trainingSigninRouter.stack.find(l => l.route?.path === '/:token' && l.route?.methods.post)!.route;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  await route.stack[0].handle({ params: { token: 'a'.repeat(32) }, body: { employeeName: 'SYNTHETIC STUDENT', employerName: 'SYNTHETIC CUSTOMER', signature } }, res, next);
  return { res, next };
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.serviceTicket.findFirst.mockResolvedValue(ticket);
  prisma.serviceTicket.findUnique.mockResolvedValue(ticket);
  prisma.trainingRosterRecord.findMany.mockResolvedValue([preregistered]);
  prisma.trainingRosterRecord.update.mockResolvedValue({ id: 'student' });
  prisma.trainingRosterRecord.create.mockResolvedValue({ id: 'new' });
  prisma.$transaction.mockImplementation(fn => fn(prisma));
});
describe('QR training arrival', () => {
  it('attaches a signature to the unique preregistered student without adding a billable seat', async () => {
    const { next } = await signIn();
    expect(next).not.toHaveBeenCalled();
    expect(prisma.trainingRosterRecord.create).not.toHaveBeenCalled();
    expect(prisma.trainingRosterRecord.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'student' }, data: expect.objectContaining({ participantSignature: signature }) }));
  });
  it('records the class service date separately from the actual signature time', async () => {
    prisma.trainingRosterRecord.findMany.mockResolvedValue([]);
    await signIn();
    expect(prisma.trainingRosterRecord.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ trainedAt: serviceDate, signedAt: expect.any(Date) }) }));
  });
  it('acknowledges an identical retry without adding another seat', async () => {
    prisma.trainingRosterRecord.findMany.mockResolvedValue([{ ...preregistered, participantSignature: signature }]);
    const { res, next } = await signIn();
    expect(next).not.toHaveBeenCalled();
    expect(prisma.trainingRosterRecord.create).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, id: 'student' });
  });
  it('does not guess between people sharing a name and employer', async () => {
    prisma.trainingRosterRecord.findMany.mockResolvedValue([preregistered, { ...preregistered, id: 'other' }]);
    const { next } = await signIn();
    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 409 });
    expect(prisma.trainingRosterRecord.create).not.toHaveBeenCalled();
  });
  it('rechecks class status after locking so a concurrent closeout wins', async () => {
    prisma.serviceTicket.findUnique.mockResolvedValue({ ...ticket, status: 'completed' });
    const { next } = await signIn();
    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 409 });
    expect(prisma.trainingRosterRecord.create).not.toHaveBeenCalled();
  });
});
