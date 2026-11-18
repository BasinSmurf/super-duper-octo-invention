import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma = vi.hoisted(() => ({
  serviceTicket: { findUnique: vi.fn(), update: vi.fn() },
  invoiceLineItem: { findFirst: vi.fn() },
  ticketLineItem: { findMany: vi.fn() }, product: { findUnique: vi.fn() },
  trainingRosterRecord: { count: vi.fn() },
  company: { findUnique: vi.fn() }, user: { findUnique: vi.fn() },
  customerBillingProfile: { findUnique: vi.fn() },
  rentalAgreement: { findUnique: vi.fn() },
}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma }))() }));
import { assertTicketEditable, assertDraftDeletion, assertOfflineStatus, editableTicket, validateLineInput, validateTicketInput, assertBillingEligible } from './ticketWritePolicy.js';
import { allowedFields, cycleLength, validDate, validateRentalInput } from './writeValidation.js';
import { safeErrorMessage } from '../middleware/errorHandler.js';

const actor = { userId: 'tech', role: 'field_tech' };
const ticket = { id: 'ticket', status: 'draft', assignedTechId: 'tech', ticketType: 'field_service', serviceSubtype: 'cascade_air', division: 'D3', padId: 'pad', arrivalTime: new Date(), departureTime: new Date() };
beforeEach(() => {
  vi.resetAllMocks();
  prisma.serviceTicket.findUnique.mockResolvedValue(ticket);
  prisma.company.findUnique.mockResolvedValue({ id: 'company' });
  prisma.ticketLineItem.findMany.mockResolvedValue([{ total: 50 }]);
});
describe('ticket write policy', () => {
  it('rejects new inactive part selections, including offline ticket replay', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'inactive', isActive: false });
    await expect(validateLineInput({ lineType: 'part', quantity: 1, productId: 'inactive' })).rejects.toThrow('Inactive parts');
    await expect(validateLineInput({ productId: 'inactive' }, { lineType: 'part', quantity: 1, productId: 'active' })).rejects.toThrow('Inactive parts');
  });
  it('preserves existing inactive part references when editing historical lines', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'inactive', isActive: false });
    await expect(validateLineInput({ productId: 'inactive', description: 'Corrected' }, { lineType: 'part', quantity: 1, productId: 'inactive' })).resolves.toMatchObject({ productId: 'inactive', description: 'Corrected' });
  });
  it('allows new active catalog selections', async () => {
    prisma.product.findUnique.mockResolvedValue({ id: 'active', isActive: true });
    await expect(validateLineInput({ lineType: 'part', quantity: 1, productId: 'active' })).resolves.toMatchObject({ productId: 'active' });
  });
  it('allows a callout linked to the same rental customer', async () => {
    prisma.rentalAgreement.findUnique.mockResolvedValue({ id: 'rental', companyId: 'company' });
    await expect(validateTicketInput({ companyId: 'company', linkedRentalAgreementId: 'rental' }, true)).resolves.toBeUndefined();
  });
  it('rejects linking a callout to another customer rental', async () => {
    prisma.rentalAgreement.findUnique.mockResolvedValue({ id: 'rental', companyId: 'other-company' });
    await expect(validateTicketInput({ companyId: 'company', linkedRentalAgreementId: 'rental' }, true)).rejects.toThrow('different customer');
  });
  it('allows course-derived training billing without invented ticket charges', async () => {
    prisma.ticketLineItem.findMany.mockResolvedValue([]);
    prisma.trainingRosterRecord.count.mockResolvedValue(4);
    await expect(assertBillingEligible({ ...ticket, ticketType: 'training', serviceSubtype: 'safety_training', division: 'D1' })).resolves.toBeUndefined();
    expect(prisma.trainingRosterRecord.count).toHaveBeenCalledWith({ where: { ticketId: ticket.id } });
  });
  it('still rejects empty training and occupational-health work without billing lines', async () => {
    prisma.ticketLineItem.findMany.mockResolvedValue([]);
    prisma.trainingRosterRecord.count.mockResolvedValue(0);
    await expect(assertBillingEligible({ ...ticket, ticketType: 'training', serviceSubtype: 'safety_training' })).rejects.toThrow(/line items/);
    prisma.trainingRosterRecord.count.mockResolvedValue(4);
    await expect(assertBillingEligible({ ...ticket, ticketType: 'training', serviceSubtype: 'fit_test' })).rejects.toThrow(/line items/);
  });
  it.each(['invoiced', 'closed', 'void'])('locks %s even for administrators', status => {
    expect(() => assertTicketEditable({ ...ticket, status }, { ...actor, role: 'platform_admin' })).toThrow(/locked/);
  });
  it('locks linked invoices even if the ticket status has been reverted', async () => {
    prisma.invoiceLineItem.findFirst.mockResolvedValue({ id: 'line' });
    await expect(editableTicket('ticket', actor)).rejects.toThrow(/active invoice/);
  });
  it('rejects another technician and protects submitted drafts from deletion', () => {
    expect(() => assertTicketEditable(ticket, { ...actor, userId: 'other' })).toThrow(/own/);
    expect(() => assertDraftDeletion({ ...ticket, status: 'billing_queue' })).toThrow(/Only drafts/);
  });
  it('allows offline Finish but refuses status rollback and approval through sync', () => {
    expect(() => assertOfflineStatus('draft', 'supervisor_review', 'field_tech')).not.toThrow();
    expect(() => assertOfflineStatus(null, 'supervisor_review', 'field_tech')).not.toThrow();
    expect(() => assertOfflineStatus('billing_queue', 'draft', 'dispatch')).toThrow();
    expect(() => assertOfflineStatus('completed', 'billing_queue', 'field_super')).toThrow();
  });
  it.each(['draft', 'dispatched', 'in_progress', 'completed', null])('allows dispatcher offline Finish from %s without approval authority', status => {
    expect(() => assertOfflineStatus(status, 'supervisor_review', 'dispatch')).not.toThrow();
    expect(() => assertOfflineStatus(status, 'billing_queue', 'dispatch')).toThrow();
    expect(() => assertOfflineStatus(status, 'invoiced', 'dispatch')).toThrow();
  });
  it('keeps boss ticket writes blocked consistently with the route allowlist', () => {
    expect(() => assertTicketEditable(ticket, { userId: 'tech', role: 'boss' })).toThrow(/not permitted/);
    expect(() => assertOfflineStatus(null, 'supervisor_review', 'boss')).toThrow();
  });
  it.each(['ticketNumber', 'subtotal', 'reviewedById', 'qbInvoiceTxnId'])('rejects mass-assigned %s', key => {
    expect(() => allowedFields({ [key]: 'forged' }, ['workDescription'])).toThrow(/not editable/);
  });
  it.each([-5, 0, '1', 1e21, 1.999])('rejects invalid quantity %s', async quantity => {
    await expect(validateLineInput({ lineType: 'service', quantity, rate: 50 })).rejects.toThrow();
  });
  it('computes money using decimal arithmetic, ignoring forged client totals', async () => {
    expect((await validateLineInput({ lineType: 'service', quantity: 1, rate: 50, total: 9999 })).total.toString()).toBe('50');
    expect((await validateLineInput({ lineType: 'service', quantity: 3, rate: 0.1 })).total.toString()).toBe('0.3');
  });
  it('recalculates partial updates using the stored quantity and rate', async () => {
    expect((await validateLineInput({ rate: 25 }, { lineType: 'service', quantity: '2.00', rate: '50.00' })).total.toString()).toBe('50');
  });
  it('rejects missing products, oversized descriptions, and null bytes', async () => {
    await expect(validateLineInput({ lineType: 'part', quantity: 1, rate: 1, productId: 'missing' })).rejects.toThrow(/productId/);
    await expect(validateLineInput({ description: 'x'.repeat(20000), lineType: 'service', quantity: 1 })).rejects.toThrow(/10000/);
    await expect(validateTicketInput({ workDescription: 'a\0b' })).rejects.toThrow(/text/);
  });
  it('preserves the occupational-health and IH wizard classifications', async () => {
    await expect(validateTicketInput({ ticketType: 'training', serviceSubtype: 'fit_test' })).resolves.toBeUndefined();
    await expect(validateTicketInput({ ticketType: 'inspection', serviceSubtype: 'ih_h2s' })).resolves.toBeUndefined();
    await expect(validateTicketInput({ ticketType: 'inspection', serviceSubtype: 'fit_test' })).rejects.toThrow();
    await expect(validateTicketInput({ ticketType: 'training', serviceSubtype: 'ih_h2s' })).rejects.toThrow();
  });
  it('enforces billing requirements but permits shop work without field times or location', async () => {
    prisma.ticketLineItem.findMany.mockResolvedValue([]);
    await expect(assertBillingEligible(ticket)).rejects.toThrow(/line items/);
    prisma.ticketLineItem.findMany.mockResolvedValue([{ total: 50 }]);
    await expect(assertBillingEligible({ ...ticket, arrivalTime: null })).rejects.toThrow(/Arrival/);
    await expect(assertBillingEligible({ ...ticket, ticketType: 'repair', padId: null, arrivalTime: null })).resolves.toBeUndefined();
  });
  it('still applies signature requirements to every approval path', async () => {
    prisma.customerBillingProfile.findUnique.mockResolvedValue({ signatureRequired: 'ticket' });
    await expect(assertBillingEligible({ ...ticket, billingProfileId: 'profile' })).rejects.toThrow(/signed ticket/);
  });
  it.each(['406', '0300002'])('allows approval of labor %s with cleared notes on repeated edits', async partNumber => {
    for (const notes of ['Original notes', 'Revised notes', '', null]) {
      prisma.ticketLineItem.findMany.mockResolvedValue([{ partNumber, total: 50, notes }]);
      await expect(assertBillingEligible(ticket)).resolves.toBeUndefined();
    }
  });
});
describe('boundary validation', () => {
  it.each([0, -3, 1.5, '6', 24])('rejects bad route cycles %s', value => expect(() => cycleLength(value)).toThrow());
  it.each(['yesterday', '1900-01-01', '2099-12-31'])('rejects invalid service dates %s', value => expect(() => validDate(value, 'serviceDate')).toThrow());
  it('rejects reversed rental dates, unexpected initial status and negative composition', () => {
    expect(() => validateRentalInput({ startDate: '2026-09-25', endDate: '2026-09-24' }, true)).toThrow();
    expect(() => validateRentalInput({ status: 'completed' }, true)).toThrow();
    expect(() => validateRentalInput({ composition: { gasMonitors: [{ qty: -1, rate: 10 }] } })).toThrow();
  });
  it('does not leak Prisma details through sync errors', () => {
    const err = new Error('Invalid query at C:\\private\\server.ts');
    err.name = 'PrismaClientValidationError';
    expect(safeErrorMessage(err)).not.toMatch(/Prisma|private|query/);
  });
});
