import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  qbCustomer: { upsert: vi.fn() },
  company: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
}));
vi.mock('../db.js', () => ({ prisma: db }));
import {
  buildCustomerListQuery, parseCustomerListPage, applyCustomerListPage, suggestCompanyMatches, type QbCustomerRecord,
} from './qbCustomerListSync.js';

const ret = (id: string, fullName: string, extra = '') =>
  `<CustomerRet><ListID>${id}</ListID><TimeModified>2026-11-01T08:00:00-06:00</TimeModified><Name>${fullName.split(':').pop()}</Name><FullName>${fullName}</FullName><IsActive>true</IsActive>${extra}</CustomerRet>`;
const page = (body: string, remaining = 0, attrs = '') =>
  `<QBXML><QBXMLMsgsRs><CustomerQueryRs statusCode="0" statusSeverity="Info" iteratorRemainingCount="${remaining}" iteratorID="{synthetic}"${attrs}>${body}</CustomerQueryRs></QBXMLMsgsRs></QBXML>`;
const record = (over: Partial<QbCustomerRecord> = {}): QbCustomerRecord => ({
  listId: '8000-A', fullName: 'SYNTHETIC OIL', name: 'SYNTHETIC OIL', sublevel: 0, parentListId: null, isActive: true,
  companyName: null, phone: null, email: null, address: null, city: null, state: null, zip: null, timeModified: null, ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.qbCustomer.upsert.mockResolvedValue({ ignored: false });
  db.company.findFirst.mockResolvedValue(null);
  db.company.findMany.mockResolvedValue([]);
  db.company.updateMany.mockResolvedValue({ count: 1 });
});

describe('paged QuickBooks customer list query', () => {
  it('starts an iterator over the whole list with elements in qbXML sequence order', () => {
    const xml = buildCustomerListQuery();
    expect(xml).toContain('<CustomerQueryRq iterator="Start">');
    expect(xml.indexOf('<MaxReturned>100</MaxReturned>')).toBeLessThan(xml.indexOf('<ActiveStatus>All</ActiveStatus>'));
    expect(xml.indexOf('<ActiveStatus>')).toBeLessThan(xml.indexOf('<IncludeRetElement>'));
    expect(xml).not.toContain('ModifiedDate');
  });
  it('continues with the escaped iterator', () => {
    expect(buildCustomerListQuery('{a&b}')).toContain('iterator="Continue" iteratorID="{a&amp;b}"');
  });
});

describe('customer list page parsing', () => {
  it('reads customers and hands back the iterator while rows remain', () => {
    const { customers, nextIteratorId } = parseCustomerListPage(page(ret('8000-A', 'SYNTHETIC A &amp; B') + ret('8000-B', 'SYNTHETIC C'), 40));
    expect(customers.map(c => c.fullName)).toEqual(['SYNTHETIC A & B', 'SYNTHETIC C']);
    expect(nextIteratorId).toBe('{synthetic}');
    expect(parseCustomerListPage(page(ret('8000-A', 'SYNTHETIC A'))).nextIteratorId).toBeNull();
  });
  it("keeps a job's own identity instead of its parent's, and skips the name line of the address", () => {
    const [job] = parseCustomerListPage(page(ret('8000-JOB', 'SYNTHETIC A:Rig 5',
      '<ParentRef><ListID>8000-A</ListID><FullName>SYNTHETIC A</FullName></ParentRef><Sublevel>1</Sublevel>'
      + '<BillAddress><Addr1>Rig 5</Addr1><Addr2>1 Test St</Addr2><City>Williston</City><State>ND</State><PostalCode>58801</PostalCode></BillAddress>'))).customers;
    expect(job).toMatchObject({ listId: '8000-JOB', fullName: 'SYNTHETIC A:Rig 5', name: 'Rig 5', parentListId: '8000-A', sublevel: 1,
      address: '1 Test St', city: 'Williston', state: 'ND', zip: '58801' });
  });
  it('treats status 1 as an empty list', () => {
    expect(parseCustomerListPage('<CustomerQueryRs statusCode="1" statusMessage="No match"/>')).toEqual({ customers: [], nextIteratorId: null });
  });
  it.each([
    '<ItemQueryRs statusCode="0"/>',
    '<CustomerQueryRs statusCode="3120" statusMessage="Bad"/>',
    '<CustomerQueryRs statusCode="0">' + ret('8000-A', 'SYNTHETIC A') + '</CustomerQueryRs>',
    '<CustomerQueryRs statusCode="0" iteratorRemainingCount="5">' + ret('8000-A', 'SYNTHETIC A') + '</CustomerQueryRs>',
    page('<CustomerRet><Name>No identity</Name></CustomerRet>'),
  ])('rejects errors and malformed pages rather than recording a partial pull', xml => {
    expect(() => parseCustomerListPage(xml)).toThrow();
  });
});

describe('reconciling a page against companies', () => {
  it('mirrors every customer and links the single exact-name unlinked company', async () => {
    db.company.findMany.mockResolvedValue([{ id: 'co-1' }]);
    const result = await applyCustomerListPage([record()]);
    expect(db.qbCustomer.upsert.mock.calls[0][0].where).toEqual({ qbListId: '8000-A' });
    expect(db.company.updateMany).toHaveBeenCalledWith({
      where: { id: 'co-1', qbCustomerListId: null },
      data: { qbCustomerListId: '8000-A', qbCustomerFullName: 'SYNTHETIC OIL' },
    });
    expect(db.company.create).not.toHaveBeenCalled();
    expect(result).toEqual({ read: 1, linked: 1, renamed: 0, created: 0 });
  });
  it('creates a Sundog customer for an active top-level QuickBooks customer nothing here is named after', async () => {
    const result = await applyCustomerListPage([record({ city: 'Minot', state: 'ND', phone: '555-0100' })]);
    expect(db.company.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      name: 'SYNTHETIC OIL', companyType: 'customer', isActive: true, city: 'Minot', state: 'ND', phone: '555-0100',
      qbCustomerListId: '8000-A', qbCustomerFullName: 'SYNTHETIC OIL', customData: { createdVia: 'quickbooks_customer_pull' },
    }) });
    expect(result).toEqual({ read: 1, linked: 0, renamed: 0, created: 1 });
  });
  it.each([
    ['two unlinked companies share the name', [{ id: 'co-1' }, { id: 'co-2' }], {}, false, null],
    ['the QuickBooks customer is inactive', [], { isActive: false }, false, null],
    ['the customer was ignored in review', [], {}, true, null],
    ['it is a job under another customer', [], { sublevel: 1, fullName: 'SYNTHETIC OIL:Rig 5', name: 'Rig 5' }, false, null],
    ['an active company linked elsewhere already has the name', [], {}, false, { id: 'co-9' }],
  ])('neither links nor creates when %s', async (_why, candidates, over, ignored, sameName) => {
    db.company.findMany.mockResolvedValue(candidates);
    db.qbCustomer.upsert.mockResolvedValue({ ignored });
    // First findFirst = "who holds this ListID" (nobody); second = same-name check.
    db.company.findFirst.mockReset();
    db.company.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(sameName);
    const result = await applyCustomerListPage([record(over)]);
    expect(db.company.updateMany).not.toHaveBeenCalled();
    expect(db.company.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ linked: 0, created: 0 });
  });
  it('follows a QuickBooks rename on an already-linked company without relinking', async () => {
    db.company.findFirst.mockResolvedValue({ id: 'co-1', qbCustomerFullName: 'OLD NAME' });
    const result = await applyCustomerListPage([record()]);
    expect(db.company.update).toHaveBeenCalledWith({ where: { id: 'co-1' }, data: { qbCustomerFullName: 'SYNTHETIC OIL' } });
    expect(db.company.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({ read: 1, linked: 0, renamed: 1, created: 0 });
  });
  it('fails the pull on a save error instead of reporting a partial read as success', async () => {
    db.qbCustomer.upsert.mockRejectedValue(new Error('db down'));
    await expect(applyCustomerListPage([record()])).rejects.toThrow('db down');
  });
});

describe('near-name suggestions for the review list', () => {
  const co = (name: string) => ({ id: name, name });
  const names = (qb: string, list: string[]) => suggestCompanyMatches(qb, list.map(co)).map(c => c.name);
  it('suggests a company whose name differs only by legal suffix or one extra word', () => {
    expect(names('Beaver Creek, LLC', ['Beaver Creek Services', 'Bear Creek Services', 'Beaver Lodge Inc'])).toEqual(['Beaver Creek Services']);
    expect(names('SYNTHETIC A & B Inc.', ['Synthetic A and B'])).toEqual(['Synthetic A and B']);
  });
  it('puts the closest name first and caps the list', () => {
    expect(names('Synthetic Oil', ['Synthetic Oil Field Services', 'Synthetic Oil Co', 'Synthetic Oil Tools', 'Synthetic Oil West'])).toEqual(
      ['Synthetic Oil Co', 'Synthetic Oil Tools', 'Synthetic Oil West']);
  });
  it('keeps distinguishing words: OIL is not ENERGY, and a lone short word matches nothing', () => {
    expect(names('Synthetic Oil LLC', ['Synthetic Energy LLC'])).toEqual([]);
    expect(names('ND LLC', ['ND Pipeline Partners'])).toEqual([]);
    expect(names('LLC', ['Anything LLC'])).toEqual([]);
  });
});
