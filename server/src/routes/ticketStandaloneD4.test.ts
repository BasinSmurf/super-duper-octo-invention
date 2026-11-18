import { beforeEach, describe, expect, it, vi } from 'vitest';
import { needsRental, RENTAL_REQUIRED_WHERE } from '../services/deploymentGate.js';

const prisma = vi.hoisted(() => ({
  serviceTicket: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  ticketLineItem: { findMany: vi.fn(), count: vi.fn() },
  $transaction: vi.fn(), $queryRaw: vi.fn(),
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
vi.mock('../services/eventBus.js', () => ({ emitEvent: vi.fn() }));
vi.mock('../services/rentalTicketRecord.js', () => ({ shouldRecordOnly: vi.fn().mockResolvedValue(false), recordTicketAsRentalLog: vi.fn() }));
vi.mock('../services/ticketApprovalAllocation.js', () => ({
  loadTicketAllocation: vi.fn().mockResolvedValue({ profiles: [], ticket: {} }),
  approveTicketAllocation: vi.fn().mockReturnValue({}),
}));
import { ticketsRouter } from './tickets.js';

const ticket = (serviceSubtype: string, ticketType = 'field_service') => ({
  id: 'ticket', ticketType, serviceSubtype, division: 'D4',
  status: 'supervisor_review', linkedRentalAgreementId: null,
  arrivalTime: new Date('2026-11-05T08:00:00Z'), departureTime: new Date('2026-11-05T09:00:00Z'),
  wellId: 'well', customData: { onSiteSubtype: 'manned_trailer' },
});

async function request(path: string) {
  const route = ticketsRouter.stack.find(layer => layer.route?.path === path)!.route;
  const res = { json: vi.fn() }, next = vi.fn();
  await route.stack.at(-1).handle({
    params: { id: 'ticket' }, query: {},
    body: { ticketIds: ['ticket'], targetStatus: 'billing_queue' },
    user: { userId: 'supervisor', role: 'field_super' },
  }, res, next);
  return { res, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(run => run(prisma));
  prisma.serviceTicket.updateMany.mockResolvedValue({ count: 1 });
  prisma.ticketLineItem.findMany.mockResolvedValue([{ total: 100 }]);
  prisma.ticketLineItem.count.mockResolvedValue(1);
});

describe('standalone D4 services', () => {
  for (const path of ['/:id/transition', '/bulk-transition']) {
    it.each(['on_site_services', 'general'])(`${path} approves %s without a rental`, async subtype => {
      const row = ticket(subtype);
      prisma.serviceTicket.findUnique.mockResolvedValue(row);
      prisma.serviceTicket.findMany.mockResolvedValue([row]);
      const { res, next } = await request(path);
      expect(next).not.toHaveBeenCalled();
      expect(prisma.serviceTicket.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'billing_queue' }) }));
      if (path === '/bulk-transition') expect(res.json.mock.calls[0][0]).toMatchObject({ succeeded: 1, failed: 0 });
    });

    it(`${path} still blocks rental deployments without an agreement`, async () => {
      const row = ticket('general', 'rental');
      prisma.serviceTicket.findUnique.mockResolvedValue(row);
      prisma.serviceTicket.findMany.mockResolvedValue([row]);
      const { res, next } = await request(path);
      expect(prisma.serviceTicket.updateMany).not.toHaveBeenCalled();
      if (path === '/bulk-transition') expect(res.json.mock.calls[0][0]).toMatchObject({ succeeded: 0, failed: 1 });
      else expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Attach a rental agreement') }));
    });
  }

  it('uses the standalone exception in the deployments queue query', async () => {
    prisma.serviceTicket.findMany.mockResolvedValue([]);
    const { next } = await request('/deployments-queue');
    expect(next).not.toHaveBeenCalled();
    expect(prisma.serviceTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { linkedRentalAgreementId: null, status: { in: ['dispatched', 'in_progress', 'completed', 'supervisor_review'] }, ...RENTAL_REQUIRED_WHERE },
    }));
  });

  it('preserves the rental requirement for other deployment classifications', () => {
    expect(needsRental(ticket('on_site_services'))).toBe(false);
    expect(needsRental(ticket('general'))).toBe(false);
    expect(needsRental(ticket('rental_deploy', 'rental'))).toBe(true);
    expect(needsRental(ticket('rental_return'))).toBe(true);
    expect(needsRental({ ticketType: 'rental', serviceSubtype: null, division: null })).toBe(true);
    expect(needsRental({ ticketType: 'field_service', serviceSubtype: null, division: 'D4' })).toBe(true);
    expect(needsRental({ ticketType: 'field_service', serviceSubtype: 'general', division: 'D3' })).toBe(false);
  });
});
