import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./enverusClient.js', () => ({ getSupplierDuns: () => 'SUPPLIER' }));
import { buildCurrentInvoiceReceipt, rebuildInvoiceSubmission, serializeInvoiceSubmission } from './enverusInvoiceSubmission.js';

const db: any = { invoice: { findUnique: vi.fn() }, serviceTicket: { findMany: vi.fn() }, rentalAgreement: { findUnique: vi.fn() }, customerBillingProfile: { findMany: vi.fn() } };
let invoice: any;
let profile: any;
const receiptOf = (payload: any) => payload.events[0].data.transform.receipt;
const entry = (requestPayload: string) => ({ entityId: 'i1', entityType: 'field_ticket', requestPayload });

beforeEach(() => {
  vi.clearAllMocks();
  profile = { id: 'bp1', buyerDuns: 'BUYER', enverusEnabled: true, enverusReceiptMode: 'openticket',
    defaultPriceBookNumber: '422493', defaultAfeNumber: 'AFE-OLD', defaultMajor: 'OLD',
    defaultServiceApprover: 'OLD APPROVER', facilityCodeAdfKey: 'facility',
    defaultAdditionalDataFields: [{ itemID: '99872', name: 'Invoice Approver', value: 'OLD', referenceDetailId: 'STALE' },
      { itemID: 'facility', value: 'OLD FACILITY' }] };
  invoice = { id: 'i1', companyId: 'co1', billingProfileId: 'bp1', invoiceNumber: 'INV-2026-01379', status: 'approved', invoiceDate: new Date('2026-10-20'),
    companyName: 'Buyer', total: 205, company: { billingProfiles: [profile] }, lineItems: [
      { lineNumber: 1, description: 'Primary', quantity: 1, rate: 185, amount: 185, partNumber: '0311001', sourceTicketId: 't1',
        product: { partNumber: '0311001' } },
      { lineNumber: 2, description: 'Additional', quantity: 1, rate: 20, amount: 20, partNumber: '0311004', product: { partNumber: '0311004' } },
    ] };
  db.customerBillingProfile.findMany.mockImplementation(async () => invoice.company.billingProfiles);
  db.invoice.findUnique.mockImplementation(async () => invoice);
  db.serviceTicket.findMany.mockResolvedValue([{ id: 't1', well: { facilityCode: 'CURRENT FACILITY' }, assignedTech: { name: 'CURRENT TECH' } }]);
});

describe('rebuilding invoice receipt submissions', () => {
  it('uses each D3 visit date and location rather than the consolidated invoice period', async () => {
    invoice.division = 'D3';
    invoice.periodStart = new Date('2026-10-01');
    invoice.periodEnd = new Date('2026-10-31');
    invoice.lineItems[1].sourceTicketId = 't2';
    db.serviceTicket.findMany.mockResolvedValue([
      { id: 't1', division: 'D3', serviceDate: new Date('2026-10-12'), serviceDateTo: new Date('2026-10-14'), locationDisplay: 'Patterson' },
      { id: 't2', division: 'D3', serviceDate: new Date('2026-10-20'), locationDisplay: 'Clawson' },
    ]);
    const receipt = receiptOf(await buildCurrentInvoiceReceipt(db, invoice, profile, 'field_ticket'));
    expect(receipt.lineItems[0]).toMatchObject({ location: 'Patterson', serviceDateFrom: '2026-10-12', serviceDateTo: '2026-10-12' });
    expect(receipt.lineItems[1]).toMatchObject({ location: 'Clawson', serviceDateFrom: '2026-10-20', serviceDateTo: '2026-10-20' });
    expect(receipt).toMatchObject({ serviceDateFrom: '2026-10-12', serviceDateTo: '2026-10-20' });
    expect(receipt).not.toHaveProperty('location');
  });
  it.each([['2026-10-01', '2026-10-15'], ['2026-10-16', '2026-10-31']])(
    'uses the rental billed window %s through %s, not the whole rental', async (from, to) => {
      invoice.division = 'D4';
      invoice.rentalAgreementId = 'r1';
      invoice.periodStart = new Date(from);
      invoice.periodEnd = new Date(to);
      db.rentalAgreement.findUnique.mockResolvedValue({ startDate: new Date('2026-09-01'), endDate: new Date('2026-11-12'),
        well: { wellName: 'Rental well' }, items: [] });
      db.serviceTicket.findMany.mockResolvedValue([]);
      const receipt = receiptOf(await buildCurrentInvoiceReceipt(db, invoice, profile, 'field_ticket'));
      expect(receipt).toMatchObject({ location: 'Rental well', serviceDateFrom: from, serviceDateTo: to });
      for (const line of receipt.lineItems) expect(line).toMatchObject({ location: 'Rental well', serviceDateFrom: from, serviceDateTo: to });
    });
  it('clips rental item dates to deployment/return inside the billed window', async () => {
    invoice.rentalAgreementId = 'r1';
    invoice.periodStart = new Date('2026-10-01');
    invoice.periodEnd = new Date('2026-10-31');
    invoice.lineItems[0].sourceRentalItemId = 'ri1';
    db.rentalAgreement.findUnique.mockResolvedValue({ startDate: new Date('2026-09-01'), endDate: null,
      items: [{ id: 'ri1', deployedDate: new Date('2026-10-05'), returnedDate: new Date('2026-10-19') }] });
    const receipt = receiptOf(await buildCurrentInvoiceReceipt(db, invoice, profile, 'field_ticket'));
    expect(receipt.lineItems[0]).toMatchObject({ serviceDateFrom: '2026-10-05', serviceDateTo: '2026-10-19' });
  });
  it('uses current invoice, product, profile, source location and crew rather than the saved wire payload', async () => {
    const overrides = { priceBookNumber: '422493', afeNumber: 'AFE-OLD', major: 'OLD', serviceApprover: 'OLD APPROVER',
      additionalDataFields: structuredClone(profile.defaultAdditionalDataFields) };
    const payload = await buildCurrentInvoiceReceipt(db, invoice, profile, 'field_ticket', overrides);
    const saved = serializeInvoiceSubmission(payload, invoice, profile, overrides);
    profile.defaultPriceBookNumber = '422493-2';
    profile.defaultAfeNumber = 'AFE-NEW';
    profile.defaultMajor = 'NEW';
    profile.buyerDuns = 'NEW BUYER';
    profile.defaultServiceApprover = 'NEW APPROVER';
    profile.defaultAdditionalDataFields[0] = { ...profile.defaultAdditionalDataFields[0], value: 'NEW', referenceDetailId: 'VALID' };
    invoice.lineItems[0].product.enverusProductServiceCode = 'CURRENT-CODE';
    invoice.lineItems[0].quantity = 2;
    invoice.total = 390;
    const result = await rebuildInvoiceSubmission(db, entry(saved));
    const receipt = receiptOf(result.payload);
    expect(receipt).toMatchObject({ buyerParty: { partyDUNS: 'NEW BUYER' }, contract: { number: '422493-2' },
      afe: { number: 'AFE-NEW' }, orderedByName: 'NEW APPROVER', totalAmount: 390 });
    expect(receipt.lineItems[0]).toMatchObject({ productServiceCode: 'CURRENT-CODE', quantity: 2, major: { code: 'NEW' }, crewMember: 'CURRENT TECH' });
    expect(receipt.additionalDataFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemID: '99872', value: 'NEW', referenceDetailId: 'VALID' }),
      expect.objectContaining({ itemID: 'facility', value: 'CURRENT FACILITY' }),
    ]));
    expect(result.payload).not.toHaveProperty('_sundogSubmission');
    expect(receipt.lineItems[1]).toMatchObject({ productServiceCode: '0311004', quantity: 1, rate: 20 });
  });
  it('preserves deliberate overrides and explicit clears across repeated retries, using current ADE resolver IDs', async () => {
    const overrides = { priceBookNumber: 'SELECTED-BOOK', contractNumber: 'CONTRACT', major: '',
      additionalDataFields: [{ ...profile.defaultAdditionalDataFields[0], value: 'MANUAL' }] };
    const saved = serializeInvoiceSubmission(await buildCurrentInvoiceReceipt(db, invoice, profile, 'field_ticket', overrides), invoice, profile, overrides);
    profile.defaultAdditionalDataFields[0].referenceDetailId = 'CORRECTED';
    profile.defaultPriceBookNumber = 'NEW DEFAULT';
    const first = await rebuildInvoiceSubmission(db, entry(saved));
    const second = await rebuildInvoiceSubmission(db, entry(first.requestPayload));
    expect(receiptOf(second.payload)).toMatchObject({ contract: { number: 'SELECTED-BOOK' } });
    expect(receiptOf(second.payload).lineItems[0]).not.toHaveProperty('major');
    expect(receiptOf(second.payload).additionalDataFields).toContainEqual(expect.objectContaining({ value: 'MANUAL', referenceDetailId: 'CORRECTED' }));
  });
  it('repairs legacy pricebook-as-PO snapshots and replaces old ADE identifiers with current settings', async () => {
    const old = { events: [{ data: { transform: { receipt: { receiptType: 'lem', priceBookNumber: '422493',
      poNumber: '422493-2', contract: { number: '422493-2' }, afe: { number: 'MANUAL-AFE' },
      additionalDataFields: [{ itemID: '99872', value: 'OLD', referenceDetailId: 'STALE' }],
      lineItems: [{ serviceCode: 'OLD DESCRIPTION' }],
    } } } }] };
    profile.defaultAdditionalDataFields[0].referenceDetailId = 'CURRENT';
    const result = await rebuildInvoiceSubmission(db, entry(JSON.stringify(old)));
    const receipt = receiptOf(result.payload);
    expect(receipt.contract).toEqual({ number: '422493-2' });
    expect(receipt).not.toHaveProperty('poNumber');
    expect(receipt).not.toHaveProperty('priceBookNumber');
    expect(receipt.afe).toEqual({ number: 'AFE-OLD' });
    expect(receipt.lineItems[0].productServiceCode).toBe('0311001');
    expect(receipt.additionalDataFields[0].referenceDetailId).toBe('CURRENT');
    expect(JSON.parse(result.requestPayload)._sundogSubmission.version).toBe(1);
  });
  it('retains a legacy manual AFE when neither invoice nor profile supplies one', async () => {
    profile.defaultAfeNumber = null;
    const saved = JSON.stringify({ events: [{ data: { transform: { receipt: { afe: { number: 'MANUAL' } } } } }] });
    expect(receiptOf((await rebuildInvoiceSubmission(db, entry(saved))).payload).afe.number).toBe('MANUAL');
  });
  it('uses the current sandbox ADE field and reference IDs for a saved manual approver value', async () => {
    const overrides = { additionalDataFields: [
      { ...profile.defaultAdditionalDataFields[0], value: 'JAJEHN' },
    ] };
    const saved = JSON.parse(serializeInvoiceSubmission(await buildCurrentInvoiceReceipt(db, invoice, profile, 'field_ticket', overrides), invoice, profile, overrides));
    // Older override metadata had only the field key and value.
    delete saved._sundogSubmission.additionalDataFields[0].name;
    delete saved._sundogSubmission.additionalDataFields[0].code;
    profile.defaultAdditionalDataFields[0] = { itemID: '85068', code: 'FIPP', name: 'Invoice Approver', value: 'JAJEHN', referenceDetailId: '3251126' };
    const first = await rebuildInvoiceSubmission(db, entry(JSON.stringify(saved)));
    const second = await rebuildInvoiceSubmission(db, entry(first.requestPayload));
    const approvers = receiptOf(second.payload).additionalDataFields.filter((f: any) => f.name === 'Invoice Approver');
    expect(approvers).toEqual([{ itemID: '85068', code: 'FIPP', name: 'Invoice Approver', value: 'JAJEHN', referenceDetailId: '3251126' }]);
    expect(JSON.stringify(second.payload)).not.toContain('99872');
  });
  it('recovers a selected book from a correct contract-only legacy snapshot', async () => {
    const old = { events: [{ data: { transform: { receipt: { contract: { number: 'SELECTED-BOOK' } } } } }] };
    const receipt = receiptOf((await rebuildInvoiceSubmission(db, entry(JSON.stringify(old)))).payload);
    expect(receipt.contract).toEqual({ number: 'SELECTED-BOOK' });
    expect(receipt).not.toHaveProperty('poNumber');
  });
  it.each(['missing invoice', 'missing profile', 'unapproved invoice', 'disabled mode'])('fails instead of replaying stale data for %s', async problem => {
    if (problem === 'missing invoice') db.invoice.findUnique.mockResolvedValue(null);
    if (problem === 'missing profile') { invoice.company.billingProfiles = []; invoice.billingProfileId = null; invoice.lineItems = []; }
    if (problem === 'unapproved invoice') invoice.status = 'draft';
    if (problem === 'disabled mode') profile.enverusReceiptMode = 'none';
    await expect(rebuildInvoiceSubmission(db, entry('{}'))).rejects.toThrow('Cannot rebuild');
  });
});
