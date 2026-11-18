import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  qbSyncQueue: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(), count: vi.fn(), create: vi.fn() },
  invoice: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() }, jobRun: { upsert: vi.fn() },
  product: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  qbCustomer: { upsert: vi.fn() },
  company: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
}));
vi.mock('../db.js', () => ({ prisma: db }));
vi.mock('../middleware/auth.js', () => ({ authenticate: vi.fn() }));
vi.mock('../middleware/rbac.js', () => ({ requirePermission: () => vi.fn() }));
vi.mock('../services/billingObservations.js', () => ({ recordDocRefObservationByDocNumber: vi.fn() }));
vi.mock('../services/billingLineage.js', () => ({ upsertDocRefAndLines: vi.fn() }));
let router: any;
let job: any;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function soap(method: string, body: string) {
  const route = router.stack.find((l: any) => l.route?.path === '/soap' && l.route.methods.post).route;
  const res = { set: vi.fn(), send: vi.fn(), status: vi.fn().mockReturnThis() };
  await route.stack[0].handle({ headers: { soapaction: `http://developer.intuit.com/${method}` }, body }, res, vi.fn());
  return res.send.mock.calls[0][0] as string;
}
async function login() {
  const response = await soap('authenticate', '<strUserName>synthetic</strUserName><strPassword>synthetic-test</strPassword>');
  return response.match(/<tns:string>([^<]+)<\/tns:string>/)![1];
}
const page = (remaining: number) => ['ItemService', 'ItemNonInventory', 'ItemInventory', 'ItemOtherCharge'].map(type =>
  `<${type}QueryRs statusCode="0" iteratorRemainingCount="${type === 'ItemService' ? remaining : 0}" iteratorID="{synthetic}">${type === 'ItemService' ? '<ItemServiceRet><ListID>qb1</ListID><FullName>legacy</FullName><IsActive>true</IsActive></ItemServiceRet>' : ''}</${type}QueryRs>`,
).join('');
beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubEnv('QBWC_USERNAME', 'synthetic');
  vi.stubEnv('QBWC_PASSWORD', 'synthetic-test');
  vi.stubEnv('QBWC_ENABLED', 'true');
  vi.stubEnv('QBWC_SANDBOX_MANIFEST', '');
  router = (await import('./qbwc.js')).qbwcRouter;
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.clearAllMocks();
  job = { id: 'synthetic-job', entityType: 'item', action: 'query', entityId: 'all-items', status: 'pending', retryCount: 0 };
  db.jobRun.upsert.mockResolvedValue({});
  db.invoice.findMany.mockResolvedValue([]);
  db.qbSyncQueue.count.mockResolvedValue(1);
  db.qbSyncQueue.findFirst.mockImplementation(async () => job.status === 'pending' ? job : null);
  db.qbSyncQueue.findUnique.mockImplementation(async () => job);
  db.qbSyncQueue.updateMany.mockImplementation(async ({ data }) => { if (data.status === 'sent') Object.assign(job, data); return { count: data.status === 'sent' ? 1 : 0 }; });
  db.qbSyncQueue.update.mockImplementation(async ({ data }) => Object.assign(job, data));
  db.product.findFirst.mockResolvedValue({ id: 'product1', partNumber: 'legacy', qbItemListId: 'qb1' });
  db.product.update.mockResolvedValue({});
  db.product.deleteMany.mockResolvedValue({ count: 0 });
});
describe('QWC catalog page lifecycle', () => {
  async function syncInactive() {
    const ticket = await login();
    await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(page(0).replace('<IsActive>true</IsActive>', '<IsActive>false</IsActive>'))}</response>`);
  }
  it('deletes an unused inactive part instead of updating or recreating it', async () => {
    db.product.deleteMany.mockResolvedValue({ count: 1 });
    await syncInactive();
    expect(db.product.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({
      id: 'product1', invoiceLineItems: { none: {} }, ticketLineItems: { none: {} },
      novaraTypeMaps: { none: {} }, serializedEquipment: { none: {} },
    }) });
    expect(db.product.update).not.toHaveBeenCalled();
    expect(db.product.create).not.toHaveBeenCalled();
    expect(job.status).toBe('success');
  });
  it('retains referenced inactive parts and hides them from active pickers', async () => {
    await syncInactive();
    expect(db.product.update).toHaveBeenCalledWith({ where: { id: 'product1' }, data: expect.objectContaining({ isActive: false }) });
    expect(db.product.create).not.toHaveBeenCalled();
  });
  it('still deactivates a part when a concurrent reference prevents deletion', async () => {
    db.product.deleteMany.mockRejectedValue({ code: 'P2003' });
    await syncInactive();
    expect(db.product.update).toHaveBeenCalledWith({ where: { id: 'product1' }, data: expect.objectContaining({ isActive: false }) });
    expect(job.status).toBe('success');
  });
  it('does not import an inactive part missing from ServicePRO', async () => {
    db.product.findFirst.mockResolvedValue(null);
    await syncInactive();
    expect(db.product.deleteMany).not.toHaveBeenCalled();
    expect(db.product.update).not.toHaveBeenCalled();
    expect(db.product.create).not.toHaveBeenCalled();
  });
  it('reactivates retained parts when QB reactivates them', async () => {
    db.product.findFirst.mockResolvedValue({ id: 'product1', partNumber: 'legacy', qbItemListId: 'qb1', isActive: false });
    const ticket = await login();
    await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(page(0))}</response>`);
    expect(db.product.deleteMany).not.toHaveBeenCalled();
    expect(db.product.update).toHaveBeenCalledWith({ where: { id: 'product1' }, data: expect.objectContaining({ isActive: true }) });
  });
  it.each([['Tax', true], ['Non', false], ['', undefined]] as const)('imports item taxable flag %s without clearing missing flags', async (code, isTaxable) => {
    const ticket = await login();
    const request = await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    expect(request).toContain('SalesTaxCodeQueryRq');
    const response = page(0).replace('</ItemServiceRet>', `${code ? `<SalesTaxCodeRef><FullName>${code}</FullName></SalesTaxCodeRef>` : ''}</ItemServiceRet>`);
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(response)}</response>`);
    const data = db.product.update.mock.calls[0][0].data;
    if (isTaxable === undefined) expect(data).not.toHaveProperty('isTaxable');
    else expect(data.isTaxable).toBe(isTaxable);
  });

  it.each([3150, 3200])('includes the invoice number and comparison for a completed invoice check (%s)', async total => {
    job.entityType = 'invoice'; job.entityId = 'inv1';
    db.invoice.findUnique.mockResolvedValue({ invoiceNumber:'INV-2026-00111', qbInvoiceTxnId:'qb-invoice', total, lineItems:[{id:'line1'}] });
    db.invoice.update.mockResolvedValue({});
    const ticket = await login();
    await soap('sendRequestXML', `<ticket>${ticket}</ticket><strCompanyFileName>C:\\QB\\Production.qbw</strCompanyFileName>`);
    const response = '<InvoiceQueryRs statusCode="0"><InvoiceRet><RefNumber>2026-00111</RefNumber><Subtotal>3000.00</Subtotal><SalesTaxTotal>150.00</SalesTaxTotal><InvoiceLineRet><Amount>3000.00</Amount></InvoiceLineRet></InvoiceRet></InvoiceQueryRs>';
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(response)}</response>`);
    const summary = await soap('closeConnection', `<ticket>${ticket}</ticket>`);
    expect(summary).toContain('0 invoices created, 1 other requests succeeded');
    expect(summary).toContain('Invoice checks: 1');
    expect(summary).toContain(`INV-2026-00111: ${total === 3150 ? 'matches' : 'DIFFERENCE'}`);
    expect(summary).toContain('QB $3150.00; lines 1 / 1');
    expect(summary).toContain('QB company file: C:\\QB\\Production.qbw');
  });
  it('reports successful catalog requests without claiming invoices were created', async () => {
    const ticket = await login();
    await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(page(0))}</response>`);
    const summary = await soap('closeConnection', `<ticket>${ticket}</ticket>`);
    expect(summary).toContain('0 invoices created, 1 other requests succeeded, 0 failed/retry');
    expect(summary).toContain('Item catalog syncs: 1 (1 page, 1 item read)');
  });
  it('surfaces a rejected catalog request in both the last error and completion summary', async () => {
    const ticket = await login();
    await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(page(0).replace('statusCode="0"', 'statusCode="500"'))}</response>`);
    expect(await soap('getLastError', `<ticket>${ticket}</ticket>`)).not.toContain('<tns:getLastErrorResult></tns:getLastErrorResult>');
    expect(await soap('closeConnection', `<ticket>${ticket}</ticket>`)).toContain('0 invoices created, 0 other requests succeeded, 1 failed/retry');
  });
  it('keeps the same job sent between pages and completes only after the last page', async () => {
    const ticket = await login();
    const request = await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    expect(request).toContain('iterator=&quot;Start&quot;');
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(page(25))}</response>`);
    expect(job.status).toBe('sent');
    const continuation = await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    expect(continuation).toContain('iterator=&quot;Continue&quot;');
    expect(continuation).not.toContain('ItemInventoryQueryRq');
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc('<ItemServiceQueryRs statusCode="0" iteratorRemainingCount="0"/>')}</response>`);
    expect(job.status).toBe('success');
    expect(db.product.update).toHaveBeenCalledTimes(1);
    const summary = await soap('closeConnection', `<ticket>${ticket}</ticket>`);
    expect(summary).toContain('Completed 1 requests:');
    expect(summary).toContain('Item catalog syncs: 1 (2 pages, 1 item read)');
  });
  it('marks a failed page as error instead of completing a partial catalog pull', async () => {
    const ticket = await login();
    await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(page(25).replace('statusCode="0"', 'statusCode="500"'))}</response>`);
    expect(job.status).toBe('error');
    expect(db.product.update).not.toHaveBeenCalled();
  });
  it('starts new iterators when an interrupted pull is recovered in a new session', async () => {
    const first = await login();
    await soap('sendRequestXML', `<ticket>${first}</ticket>`);
    await soap('receiveResponseXML', `<ticket>${first}</ticket><response>${esc(page(25))}</response>`);
    await soap('closeConnection', `<ticket>${first}</ticket>`);
    // The existing stale-job recovery returns interrupted pulls to pending.
    job.status = 'pending';
    const second = await login();
    const request = await soap('sendRequestXML', `<ticket>${second}</ticket>`);
    expect(request).toContain('iterator=&quot;Start&quot;');
    expect(request).not.toContain('iterator=&quot;Continue&quot;');
  });
  it('preserves the guard against adopting a product linked to a different QB item', async () => {
    db.product.findFirst.mockImplementation(async ({ where }) => where.qbItemListId ? null : { id: 'other', partNumber: 'legacy', qbItemListId: 'different' });
    const ticket = await login();
    await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(page(0))}</response>`);
    expect(job.status).toBe('success');
    expect(db.product.update).not.toHaveBeenCalled();
    expect(db.product.create).not.toHaveBeenCalled();
  });
});
describe('QWC customer list pull lifecycle', () => {
  const customers = (remaining: number, id: string) =>
    `<CustomerQueryRs statusCode="0" iteratorRemainingCount="${remaining}" iteratorID="{cust}"><CustomerRet><ListID>${id}</ListID><Name>SYNTHETIC ${id}</Name><FullName>SYNTHETIC ${id}</FullName><IsActive>true</IsActive></CustomerRet></CustomerQueryRs>`;
  beforeEach(() => {
    Object.assign(job, { entityType: 'customer_list', entityId: 'all-customers' });
    db.qbCustomer.upsert.mockResolvedValue({ ignored: false });
    db.company.findFirst.mockResolvedValue(null);
    db.company.findMany.mockImplementation(async ({ where }) => where.OR[0].qbCustomerFullName.equals === 'SYNTHETIC B' ? [{ id: 'co-b' }] : []);
    db.company.updateMany.mockResolvedValue({ count: 1 });
  });
  it('is never queued by the connector itself — only by the Ops page button', async () => {
    job.status = 'success';
    await login();
    expect(db.qbSyncQueue.create.mock.calls.map(c => c[0].data.entityType)).not.toContain('customer_list');
  });
  it('pages through the whole list in one job, links a match and creates the customer Sundog lacks', async () => {
    const ticket = await login();
    const request = await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    expect(request).toContain('CustomerQueryRq iterator=&quot;Start&quot;');
    expect(request).not.toContain('ModifiedDate');
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(customers(1, 'A'))}</response>`);
    expect(job.status).toBe('sent');
    const continuation = await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    expect(continuation).toContain('iterator=&quot;Continue&quot; iteratorID=&quot;{cust}&quot;');
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(customers(0, 'B'))}</response>`);
    expect(job.status).toBe('success');
    expect(db.qbCustomer.upsert).toHaveBeenCalledTimes(2);
    expect(db.company.updateMany).toHaveBeenCalledTimes(1);
    expect(db.company.updateMany.mock.calls[0][0].data).toEqual({ qbCustomerListId: 'B', qbCustomerFullName: 'SYNTHETIC B' });
    expect(db.company.create).toHaveBeenCalledTimes(1);
    expect(db.company.create.mock.calls[0][0].data).toMatchObject({ name: 'SYNTHETIC A', companyType: 'customer', qbCustomerListId: 'A' });
    const summary = await soap('closeConnection', `<ticket>${ticket}</ticket>`);
    expect(summary).toContain('Customer list syncs: 1 (2 pages, 2 customers read, 1 newly linked, 1 created)');
  });
  it('marks a failed page as error instead of completing a partial pull', async () => {
    const ticket = await login();
    await soap('sendRequestXML', `<ticket>${ticket}</ticket>`);
    await soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${esc(customers(1, 'A').replace('statusCode="0"', 'statusCode="3120"'))}</response>`);
    expect(job.status).toBe('error');
    expect(db.qbCustomer.upsert).not.toHaveBeenCalled();
  });
});
