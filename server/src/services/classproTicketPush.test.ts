import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  cpScheduledSession: { findUnique: vi.fn(), update: vi.fn() },
  serviceTicket: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(), $queryRaw: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/ticketNumber.js', () => ({ generateTicketNumber: vi.fn(async () => 'TR-SYNTHETIC') }));
vi.mock('./employerMatch.js', () => ({ matchEmployer: vi.fn(async () => null) }));
import { pushSessionToTicket } from './classproTicketPush.js';
let savedTicketId: string | null;
beforeEach(() => {
  vi.clearAllMocks(); savedTicketId = null;
  prisma.cpScheduledSession.findUnique.mockImplementation(async () => ({
    id: 'session', ticketId: savedTicketId, status: savedTicketId ? 'pushed' : 'scheduled',
    companyId: 'synthetic-company', course: { name: 'H2S CLEAR', cardsOnSite: false },
    date: new Date('2026-09-24'), deliveryMode: 'in_house', registrations: [],
  }));
  prisma.serviceTicket.findFirst.mockImplementation(async () => savedTicketId ? { id: savedTicketId, ticketNumber: 'TR-SYNTHETIC', _count: { trainingRosterRecords: 0 } } : null);
  prisma.serviceTicket.create.mockImplementation(async () => ({ id: 'created-' + prisma.serviceTicket.create.mock.calls.length, ticketNumber: 'TR-SYNTHETIC' }));
  prisma.cpScheduledSession.update.mockImplementation(async ({ data }) => { savedTicketId = data.ticketId; });
  let queue = Promise.resolve();
  prisma.$transaction.mockImplementation(async fn => {
    let release!: () => void;
    const previous = queue;
    queue = new Promise<void>(resolve => { release = resolve; });
    const tx = { ...prisma, $queryRaw: vi.fn(async () => { await previous; }) };
    try { return await fn(tx); } finally { release(); }
  });
});
describe('ClassPRO push serialization', () => {
  it('creates a training ticket with the division required for normal billing approval', async () => {
    await pushSessionToTicket('session', 'admin');
    expect(prisma.serviceTicket.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      ticketType: 'training', serviceSubtype: 'safety_training', division: 'D1',
    }) }));
  });
  it('returns one ticket when two browser views make the class simultaneously', async () => {
    const results = await Promise.all([pushSessionToTicket('session', 'admin'), pushSessionToTicket('session', 'admin')]);
    expect(prisma.serviceTicket.create).toHaveBeenCalledTimes(1);
    expect(results[0].ticketId).toBe(results[1].ticketId);
    expect(results.filter(r => r.created)).toHaveLength(1);
  });
  it('retains the existing ticket on a later retry', async () => {
    const first = await pushSessionToTicket('session', 'admin');
    const retry = await pushSessionToTicket('session', 'admin');
    expect(retry).toMatchObject({ created: false, ticketId: first.ticketId });
    expect(prisma.serviceTicket.create).toHaveBeenCalledTimes(1);
  });
});
