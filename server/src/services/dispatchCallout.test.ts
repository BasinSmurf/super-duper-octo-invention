import { beforeEach, describe, expect, it, vi } from 'vitest';
const tx = vi.hoisted(() => ({ serviceTicket: { create: vi.fn() }, auditLog: { create: vi.fn() } }));
const prisma = vi.hoisted(() => ({ serviceTicket: { findUnique: vi.fn() }, company: { findUnique: vi.fn() }, user: { findUnique: vi.fn() },
  pad: { findUnique: vi.fn() }, rentalAgreement: { findUnique: vi.fn() }, customerBillingProfile: { findMany: vi.fn() }, $transaction: vi.fn() }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
vi.mock('../utils/ticketNumber.js', () => ({ generateTicketNumber: vi.fn(async () => 'FS-2026-001') }));
vi.mock('./eventBus.js', () => ({ emitEvent: vi.fn() }));
import { dispatchCallout } from './dispatchCallout.js';
import { emitEvent } from './eventBus.js';
const requestId = '6f415682-66fb-4cbb-9f9a-f91c12fc8a82';
const lineId = '3f415682-66fb-4cbb-9f9a-f91c12fc8a82';
const actor = { userId: 'dispatcher', role: 'dispatch' };
const body = { requestId, ticket: { companyId: 'customer', assignedTechId: 'tech', ticketType: 'field_service', serviceSubtype: 'general',
  serviceDate: '2026-10-08', division: 'D3', dispatchNotes: 'Call site contact first', customData: { isCallOut: true,
    wizardDraft: { version: 1, step: 2, data: { workType: 'field_service', serviceType: 'general', lineItems: [{ id: lineId, partNumber: '148', rate: 175 }] } } } },
  lineItems: [{ id: lineId, lineType: 'misc_charge', partNumber: '148', description: 'Emergency Call out Fee', quantity: 1, rate: 175 }] };
beforeEach(() => {
  vi.resetAllMocks();
  prisma.serviceTicket.findUnique.mockResolvedValue(null);
  prisma.company.findUnique.mockResolvedValue({ id: 'customer', name: 'Customer', isActive: true, creditHold: false });
  prisma.user.findUnique.mockResolvedValue({ id: 'tech', isActive: true });
  prisma.customerBillingProfile.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation(async callback => callback(tx));
  tx.serviceTicket.create.mockImplementation(async ({ data }) => data);
});
describe('dispatcher ticket preparation', () => {
  it('persists the chosen notification division without changing billing division', async () => {
    const ticket = await dispatchCallout({ ...body, ticket: { ...body.ticket,
      customData: { ...body.ticket.customData, dispatchNotificationDivision: 'D4' } } }, actor);
    expect(ticket.division).toBe('D3');
    expect(ticket.customData.dispatchNotificationDivision).toBe('D4');
  });
  it('rejects invalid notification routing before any writes', async () => {
    await expect(dispatchCallout({ ...body, ticket: { ...body.ticket,
      customData: { dispatchNotificationDivision: 'billing' } } }, actor)).rejects.toThrow('Choose D3 or D4');
    expect(tx.serviceTicket.create).not.toHaveBeenCalled();
  });
  it('creates the assigned ticket and adjustable fee atomically without on-site times or results', async () => {
    const ticket = await dispatchCallout(body, actor);
    expect(ticket.status).toBe('dispatched');
    expect(ticket.assignedTechId).toBe('tech');
    expect(ticket.dispatchedById).toBe('dispatcher');
    expect(ticket.arrivalTime).toBeUndefined();
    expect(ticket.departureTime).toBeUndefined();
    expect(ticket.total.toNumber()).toBe(175);
    expect(ticket.lineItems.create[0]).toMatchObject({ id: lineId, partNumber: '148', rate: 175 });
    expect(ticket.lineItems.create[0].testResult).toBeUndefined();
    expect(ticket.customData.wizardDraft.step).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith('ticket.transitioned', expect.objectContaining({ ticketId: requestId, toStatus: 'dispatched' }));
  });
  it('preserves the RA link and rejects a different customer', async () => {
    prisma.rentalAgreement.findUnique.mockResolvedValue({ id: 'ra', companyId: 'different-customer' });
    await expect(dispatchCallout({ ...body, ticket: { ...body.ticket, linkedRentalAgreementId: 'ra' } }, actor)).rejects.toThrow('different customer');
    expect(tx.serviceTicket.create).not.toHaveBeenCalled();
    prisma.rentalAgreement.findUnique.mockResolvedValue({ id: 'ra', companyId: 'customer' });
    expect((await dispatchCallout({ ...body, ticket: { ...body.ticket, linkedRentalAgreementId: 'ra' } }, actor)).linkedRentalAgreementId).toBe('ra');
  });
  it('rejects inactive users, missing rates, credit holds, and non-dispatch roles', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'tech', isActive: false });
    await expect(dispatchCallout(body, actor)).rejects.toThrow('active assigned');
    prisma.user.findUnique.mockResolvedValue({ id: 'tech', isActive: true });
    await expect(dispatchCallout({ ...body, lineItems: [{ ...body.lineItems[0], rate: null }] }, actor)).rejects.toThrow('rate');
    prisma.company.findUnique.mockResolvedValue({ id: 'customer', isActive: true, creditHold: true });
    await expect(dispatchCallout(body, actor)).rejects.toThrow();
    await expect(dispatchCallout(body, { ...actor, role: 'field_tech' })).rejects.toThrow('Dispatch is not permitted');
    expect(tx.serviceTicket.create).not.toHaveBeenCalled();
  });
  it('retries the same request without another ticket or charge', async () => {
    prisma.serviceTicket.findUnique.mockResolvedValue({ id: requestId, createdById: actor.userId, customData: { dispatchPrepared: true } });
    expect((await dispatchCallout(body, actor)).id).toBe(requestId);
    expect(tx.serviceTicket.create).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
