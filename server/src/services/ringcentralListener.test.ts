import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (payload: any) => Promise<void>>());
const prisma = vi.hoisted(() => ({
  serviceTicket: { findUnique: vi.fn() }, rentalAgreement: { findUnique: vi.fn() }, well: { findMany: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('./eventBus.js', () => ({ onEvent: vi.fn((event, handler) => handlers.set(event, handler)) }));
vi.mock('./ringcentralNotify.js', () => ({ notify: vi.fn(), isConfigured: vi.fn(async () => true) }));
import { startRingcentralListener } from './ringcentralListener.js';
import { notify, isConfigured } from './ringcentralNotify.js';

const ticket = {
  ticketNumber: 'FS-2026-0073', ticketType: 'field_service', division: 'D4', customData: null,
  company: { name: 'Customer' }, field: { name: 'North Field' }, pad: { name: 'Baker 27' },
  well: { wellName: 'Well 1' }, locationDisplay: 'Customer > Baker 27',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PUBLIC_APP_URL', 'https://service.example.com/');
  handlers.clear();
  startRingcentralListener();
  vi.mocked(isConfigured).mockResolvedValue(true);
  prisma.serviceTicket.findUnique.mockResolvedValue(ticket);
  prisma.rentalAgreement.findUnique.mockResolvedValue({ field: ticket.field, pad: ticket.pad, well: ticket.well, wellIds: ['w1', 'w2', 'w1'],
    startDate: new Date('2026-11-16T00:00:00.000Z') });
  prisma.well.findMany.mockResolvedValue([{ id: 'w1', wellName: 'Well 1' }, { id: 'w2', wellName: 'Well 2' }]);
});

describe('RingCentral business cards', () => {
  it.each([
    ['D3', null, 'dispatch_d3'],
    ['D4', null, 'dispatch'],
    ['D3', { dispatchNotificationDivision: 'D4' }, 'dispatch'],
    ['D4', { dispatchNotificationDivision: 'D3' }, 'dispatch_d3'],
    [null, null, 'dispatch'],
  ])('routes division %s with override %j to %s', async (division, customData, channel) => {
    prisma.serviceTicket.findUnique.mockResolvedValue({ ...ticket, division, customData });
    await handlers.get('ticket.transitioned')!({ ticketId: 'ticket-1', toStatus: 'dispatched' });
    expect(notify).toHaveBeenCalledWith(channel, expect.stringContaining('Location: North Field > Baker 27 > Well 1'));
    expect(notify).toHaveBeenCalledWith(channel, expect.stringContaining('[Ticket #FS-2026-0073](https://service.example.com/tickets/ticket-1)'));
  });
  it('routes rental creation independently and includes all wells and an agreement link', async () => {
    await handlers.get('rental.agreement.created')!({ agreementId: 'ra-1', agreementNumber: 'RA-2026-0045', companyName: 'Customer',
      ringCentralChannel: 'dispatch', composition: { trailer: { manned: false }, drillingRig: true }, items: [] });
    expect(notify).toHaveBeenCalledWith('rentals', expect.stringContaining('Location: North Field > Baker 27 > Well 1 > Well 2'));
    expect(notify).toHaveBeenCalledWith('rentals', expect.stringContaining('Start: Mon, Nov 16, 2026\n'));
    expect(notify).toHaveBeenCalledWith('rentals', expect.stringContaining('unmanned trailer + drilling rig'));
    expect(notify).toHaveBeenCalledWith('rentals', expect.stringContaining('[Agreement #RA-2026-0045](https://service.example.com/rentals/ra-1)'));
    expect(isConfigured).toHaveBeenCalledWith('rentals');
  });
  it('uses available facility/work-point names and retains an honest missing-location fallback', async () => {
    prisma.serviceTicket.findUnique.mockResolvedValue({ ...ticket, field: null, pad: null, well: null,
      facility: { name: 'Compressor Station' }, workPoint: { name: 'Tank 4' } });
    await handlers.get('ticket.transitioned')!({ ticketId: 't', toStatus: 'dispatched' });
    expect(notify).toHaveBeenLastCalledWith('dispatch', expect.stringContaining('Compressor Station > Tank 4'));
    prisma.serviceTicket.findUnique.mockResolvedValue({ ticketNumber: 'FS-2', ticketType: 'field_service', company: ticket.company });
    await handlers.get('ticket.transitioned')!({ ticketId: 't', toStatus: 'dispatched' });
    expect(notify).toHaveBeenLastCalledWith('dispatch', expect.stringContaining('no location set'));
  });
  it('breaks a shop intake down by category and shouts only when it is urgent', async () => {
    const intake = { workOrderNumber: 'SW-2026-00258', companyName: 'Customer', itemCount: 5 };
    await handlers.get('shopwo.intake.created')!({ ...intake, priority: 1,
      categoryCounts: [{ category: 'fire_extinguisher', count: 2 }, { category: 'scba', count: 3 }] });
    expect(notify).toHaveBeenLastCalledWith('intake',
      '🚨 **!! URGENT !!** 🚨\n📥 **Shop intake** — Customer\n' +
      'Dropped off: 3 × SCBA, 2 × Fire Extinguisher\nWork Order #SW-2026-00258');
    await handlers.get('shopwo.intake.created')!({ ...intake, priority: 2, categoryCounts: [{ category: 'scba', count: 1 }] });
    expect(notify).toHaveBeenLastCalledWith('intake',
      '📥 **Shop intake** — Customer\nDropped off: 1 × SCBA\nWork Order #SW-2026-00258');
    await handlers.get('shopwo.intake.created')!(intake);
    expect(notify).toHaveBeenLastCalledWith('intake', expect.stringContaining('5 items dropped off'));
  });
  it('does not post for other transitions, missing tickets, or a disabled destination', async () => {
    await handlers.get('ticket.transitioned')!({ ticketId: 't', toStatus: 'completed' });
    expect(prisma.serviceTicket.findUnique).not.toHaveBeenCalled();
    prisma.serviceTicket.findUnique.mockResolvedValue(null);
    await handlers.get('ticket.transitioned')!({ ticketId: 't', toStatus: 'dispatched' });
    prisma.serviceTicket.findUnique.mockResolvedValue(ticket);
    vi.mocked(isConfigured).mockResolvedValue(false);
    await handlers.get('ticket.transitioned')!({ ticketId: 't', toStatus: 'dispatched' });
    await handlers.get('rental.agreement.created')!({ agreementId: 'ra' });
    expect(notify).not.toHaveBeenCalled();
    expect(prisma.rentalAgreement.findUnique).not.toHaveBeenCalled();
  });
});
