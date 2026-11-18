import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  serviceTicket: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  ticketLineItem: { count: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
import { ticketsRouter } from './tickets.js';

beforeEach(() => {
  vi.clearAllMocks();
  const ticket = { id: 'ticket', status: 'supervisor_review', assignedTechId: 'actor', serviceSubtype: 'other' };
  prisma.serviceTicket.findUnique.mockResolvedValue(ticket);
  prisma.serviceTicket.findMany.mockResolvedValue([ticket]);
  prisma.ticketLineItem.count.mockResolvedValue(1);
});

describe('ticket approval permission errors', () => {
  it.each(['/:id/transition', '/bulk-transition'])('explains the allowed roles through %s without approving', async path => {
    const route = ticketsRouter.stack.find(layer => layer.route?.path === path)!.route;
    const res = { json: vi.fn() }, next = vi.fn();
    await route.stack.at(-1).handle({ params: { id: 'ticket' }, body: { ticketIds: ['ticket'], targetStatus: 'billing_queue' }, user: { userId: 'actor', role: 'billing_ar' } }, res, next);
    const message = 'Cannot approve tickets due to permissions. Must be Field Supervisor or Platform Admin to continue.';
    if (path === '/bulk-transition') {
      expect(next).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0]).toMatchObject({ succeeded: 0, failed: 1, results: [{ ticketId: 'ticket', success: false, error: message }] });
    } else {
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, message }));
    }
    expect(prisma.serviceTicket.updateMany).not.toHaveBeenCalled();
  });
});
