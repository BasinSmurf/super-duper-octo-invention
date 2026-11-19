import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(), company: { findUnique: vi.fn() }, user: { findUnique: vi.fn() },
  rentalAgreement: { create: vi.fn(), findUnique: vi.fn() }, serviceTicket: { create: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/auditLog.js', () => ({ createAuditLog: vi.fn() }));
vi.mock('../utils/ticketNumber.js', () => ({ generateRentalAgreementNumber: vi.fn(async () => 'RA-1'), generateTicketNumber: vi.fn(async () => 'FS-1') }));
vi.mock('../services/webhookSettings.js', () => ({ WEBHOOK_CHANNELS: ['billing', 'dispatch', 'dispatch_d3', 'rentals', 'intake'], resolveWebhook: vi.fn(async () => ({ enabled: true, url: 'configured' })) }));
vi.mock('../services/eventBus.js', () => ({ emitEvent: vi.fn() }));
import { rentalsRouter } from './rentals.js';
import { emitEvent } from '../services/eventBus.js';

const route = rentalsRouter.stack.find(entry => entry.route?.path === '/' && entry.route.methods.post)!.route;
const body = { companyId: 'customer', assignedTechId: 'tech', ringCentralChannel: 'rentals', pickupType: 'dispatch', billingRateType: 'daily', startDate: '2026-10-08', status: 'scheduled', items: [] };
async function create(overrides = {}) {
  const json = vi.fn(), next = vi.fn();
  await route.stack[0].handle({ body: { ...body, ...overrides }, user: { userId: 'dispatcher' } }, { status: () => ({ json }) }, next);
  return { json, next };
}
beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async action => action(prisma));
  prisma.company.findUnique.mockResolvedValue({ id: 'customer', name: 'Customer', isActive: true });
  prisma.user.findUnique.mockResolvedValue({ isActive: true, homeSiteId: 'shop' });
  prisma.rentalAgreement.create.mockResolvedValue({ id: 'rental', agreementNumber: 'RA-1' });
  prisma.rentalAgreement.findUnique.mockResolvedValue({ id: 'rental', status: 'scheduled', items: [] });
});
describe('rental dispatch', () => {
  it.each([
    { assignedTechId: undefined },
    { ringCentralChannel: undefined },
    { assignedTechId: undefined, ringCentralChannel: undefined },
  ])('creates a rental with optional dispatch fields omitted: %j', async overrides => {
    const result = await create(overrides);
    expect(result.next).not.toHaveBeenCalled();
    expect(result.json).toHaveBeenCalled();
    expect(prisma.rentalAgreement.create).toHaveBeenCalled();
    if ('assignedTechId' in overrides) {
      expect(prisma.serviceTicket.create).not.toHaveBeenCalled();
    } else {
      expect(prisma.serviceTicket.create).toHaveBeenCalled();
    }
  });
  it('creates an assigned deploy ticket with the agreement and routes its dispatch card', async () => {
    const result = await create();
    expect(result.next).not.toHaveBeenCalled();
    expect(prisma.serviceTicket.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      assignedTechId: 'tech', linkedRentalAgreementId: 'rental', status: 'dispatched',
      customData: { workType: 'rental_deploy', dispatchNotificationDivision: 'D4' },
    }) });
    expect(emitEvent).toHaveBeenCalledWith('rental.agreement.created', expect.objectContaining({ ringCentralChannel: 'rentals' }));
  });
  it('rejects inactive assignees before creating the agreement', async () => {
    prisma.user.findUnique.mockResolvedValue({ isActive: false });
    expect((await create()).next.mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.rentalAgreement.create).not.toHaveBeenCalled();
  });
  it('rejects unknown notification destinations before creating the agreement', async () => {
    expect((await create({ ringCentralChannel: 'unknown' })).next.mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.rentalAgreement.create).not.toHaveBeenCalled();
  });
});
