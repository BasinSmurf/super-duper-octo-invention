import { describe, expect, it } from 'vitest';
import { approveTicketAllocation, approvedInvoiceAllocations, invoiceApprovalTickets, ticketAllocationContext } from './ticketApprovalAllocation.js';
import { billingApprovalPlan, splitBillingApprovals } from './billingApprovalSplit.js';

const profiles = [{ id: 'hse', appliesToTicketTypes: ['inspection'] }, { id: 'sampling', appliesToTicketTypes: ['ih_sampling'] }];
const ticket = { id: 't1', ticketNumber: 'TEST', ticketType: 'inspection', serviceSubtype: 'ih_h2s',
  customData: { ihSubtypes: ['ih_h2s', 'ih_sampling'] },
  lineItems: [
    { id: 'hours', description: 'Technician time', quantity: 4, rate: 100, total: 400, unitOfMeasure: 'HR' },
    { id: 'miles', description: 'Mileage', quantity: 40, rate: 2, total: 80, unitOfMeasure: 'MI' },
  ],
};
const allocations = [
  { key: 'hours', parts: [{ profileId: 'hse', quantity: 1 }, { profileId: 'sampling', quantity: 3 }] },
  { key: 'miles', parts: [{ profileId: 'hse', quantity: 10 }, { profileId: 'sampling', quantity: 30 }] },
  { key: 'shared:t1', parts: [{ profileId: 'sampling', quantity: 1 }] },
];
const approve = () => approveTicketAllocation(profiles, ticket, allocations, ticketAllocationContext(profiles, ticket).plan.version, 'reviewer', true);

describe('approval-owned time and mileage allocation', () => {
  it('requires review for a mixed ticket, including an explicit destination for generated charges', () => {
    const { plan } = ticketAllocationContext(profiles, ticket);
    expect(plan.requiresReview).toBe(true);
    expect(plan.rows.map(row => [row.key, row.quantity, row.unitOfMeasure])).toEqual([
      ['hours', 4, 'HR'], ['miles', 40, 'MI'], ['shared:t1', 1, 'assignment'],
    ]);
    // Also gates bulk approval and unattended approval, which have no human allocations.
    expect(() => approveTicketAllocation(profiles, ticket, undefined, undefined, 'reviewer', true)).toThrow('during ticket approval');
  });
  it('saves reviewer attribution and preserves independent time and mileage splits after status changes', () => {
    const record = approve();
    expect(record.approvedById).toBe('reviewer');
    expect(record.approvedAt).toBeTruthy();
    const approved = { ...ticket, billingApprovalAllocation: record, updatedAt: new Date() };
    // Invoice pricing may change, but approved quantities and groups may not.
    const source = ticketAllocationContext(profiles, ticket).lines.slice(0, 2).map(line => ({ ...line, rate: line.rate * 2, amount: line.amount * 2 }));
    const invoicePlan = billingApprovalPlan(profiles, [approved], source);
    const parts = splitBillingApprovals(profiles, [approved], source, approvedInvoiceAllocations(profiles, [approved], source), invoicePlan.version);
    expect(parts.map(part => [part.billingProfileId, part.lines.map(line => line.quantity), part.lines.reduce((sum, line) => sum + line.amount, 0)]))
      .toEqual([['hse', [1, 10], 240], ['sampling', [3, 30], 720]]);
  });
  it('uses the approved destination for generated fees', () => {
    const source = [{ lineNumber: 1, sourceTicketId: 't1', description: 'Callout', quantity: 1, rate: 150, amount: 150, isTaxable: false }];
    expect(approvedInvoiceAllocations(profiles, [{ ...ticket, billingApprovalAllocation: approve() }], source)[0].parts)
      .toEqual([{ profileId: 'sampling', quantity: 1 }]);
  });
  it('rejects missing, changed, and unattributed approval records', () => {
    for (const record of [{ ...approve(), version: 'stale' }, { ...approve(), approvedById: null }]) {
      expect(() => approvedInvoiceAllocations(profiles, [{ ...ticket, billingApprovalAllocation: record }], [])).toThrow('ticket approval');
    }
    const changed = { ...ticket, billingApprovalAllocation: approve(), lineItems: [{ ...ticket.lineItems[0], quantity: 5 }, ticket.lineItems[1]] };
    expect(() => approvedInvoiceAllocations(profiles, [changed], [])).toThrow('ticket approval');
  });
  it('requires new review when billed quantities no longer equal approved quantities', () => {
    const lines = ticketAllocationContext(profiles, ticket).lines.slice(0, 2);
    lines[0].quantity = 5;
    expect(() => approvedInvoiceAllocations(profiles, [{ ...ticket, billingApprovalAllocation: approve() }], lines)).toThrow('Billed quantities differ');
  });
  it('automatically routes tickets with one approval group', () => {
    const single = { ...ticket, customData: null };
    expect(approveTicketAllocation(profiles, single, undefined, undefined, 'reviewer').splitEnabled).toBe(false);
    expect(approveTicketAllocation(profiles, single, undefined, undefined, 'reviewer').allocations[0].parts)
      .toEqual([{ profileId: 'hse', quantity: 4 }]);
  });
  it('keeps mixed work together unless the approver explicitly enables splitting', () => {
    const record = approveTicketAllocation(profiles, ticket, undefined, undefined, 'reviewer');
    expect(record.splitEnabled).toBe(false);
    expect(record.allocations.every(row => row.parts.length === 1 && row.parts[0].profileId === 'hse')).toBe(true);
    const approved = { ...ticket, billingApprovalAllocation: record };
    const lines = ticketAllocationContext(profiles, ticket).lines.slice(0, 2);
    const sources = invoiceApprovalTickets(profiles, [approved]);
    const plan = billingApprovalPlan(profiles, sources, lines);
    expect(splitBillingApprovals(profiles, sources, lines, approvedInvoiceAllocations(profiles, [approved], lines), plan.version)).toHaveLength(1);
  });
  it('offers optional splitting for non-IH work at another customer', () => {
    const otherProfiles = [{ id: 'ops', notes: 'Operations', appliesToTicketTypes: ['field_service'] },
      { id: 'projects', notes: 'Projects', appliesToTicketTypes: ['field_service'] }];
    const other = { ...ticket, companyId: 'another-customer', ticketType: 'field_service', serviceSubtype: null, customData: null };
    const { plan } = ticketAllocationContext(otherProfiles, other);
    expect(plan.groups.map(group => group.id).sort()).toEqual(['ops', 'projects']);
    const choices = plan.rows.map(row => ({ key: row.key, parts: [{ profileId: 'projects', quantity: row.quantity }] }));
    const record = approveTicketAllocation(otherProfiles, other, choices, plan.version, 'reviewer', true);
    expect(record.splitEnabled).toBe(true);
    const approved = { ...other, billingApprovalAllocation: record };
    const lines = ticketAllocationContext(otherProfiles, other).lines.slice(0, 2);
    const sources = invoiceApprovalTickets(otherProfiles, [approved]);
    const invoicePlan = billingApprovalPlan(otherProfiles, sources, lines);
    const invoices = splitBillingApprovals(otherProfiles, sources, lines,
      approvedInvoiceAllocations(otherProfiles, [approved], lines), invoicePlan.version);
    expect(invoices[0].billingProfileId).toBe('projects');
  });

});
