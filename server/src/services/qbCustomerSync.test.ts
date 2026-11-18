import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ company: { findUnique: vi.fn(), update: vi.fn() }, qbSyncQueue: { update: vi.fn() }, $transaction: vi.fn() }));
vi.mock('../db.js', () => ({ prisma: db }));
import { buildCustomerRequest, processCustomerResponse } from './qbCustomerSync.js';
const company = { name: 'SYNTHETIC A & B', qbCustomerFullName: null, qbCustomerListId: null };
const entry = { id: 'queue', entityId: 'synthetic', action: 'add' };
const response = (name = 'SYNTHETIC A &amp; B', id = '8000-TEST') => `<CustomerAddRs statusCode="0"><CustomerRet><ListID>${id}</ListID><FullName>${name}</FullName></CustomerRet></CustomerAddRs>`;
beforeEach(() => { vi.resetAllMocks(); db.company.findUnique.mockResolvedValue(company); db.$transaction.mockImplementation(fn => fn(db)); });
describe('explicit QuickBooks customer provisioning', () => {
  it('escapes the exact name and never sends contact details or opening balances', () => {
    const xml = buildCustomerRequest(company, 'add');
    expect(xml).toContain('<Name>SYNTHETIC A &amp; B</Name>');
    expect(xml).not.toMatch(/OpenBalance|Email|Phone/);
    expect(() => buildCustomerRequest({ ...company, name: 'x'.repeat(42) }, 'add')).toThrow(/41/);
  });
  it('queries the existing ListID when an already-mapped customer is replayed', () => {
    expect(buildCustomerRequest({ ...company, qbCustomerListId: '8000-TEST' }, 'add')).toContain('<CustomerQueryRq><ListID>8000-TEST</ListID>');
  });
  it('records the returned mapping and acknowledges the job atomically', async () => {
    await processCustomerResponse(entry, response());
    expect(db.company.update).toHaveBeenCalledWith({ where: { id: 'synthetic' }, data: { qbCustomerListId: '8000-TEST', qbCustomerFullName: company.name } });
    expect(db.qbSyncQueue.update.mock.calls[0][0].data.status).toBe('success');
    expect(db.$transaction).toHaveBeenCalledOnce();
  });
  it('recovers a lost Add response by exact-name Query instead of another Add', async () => {
    await processCustomerResponse(entry, '<CustomerAddRs statusCode="3100" statusMessage="Name already exists"/>');
    expect(db.qbSyncQueue.update.mock.calls[0][0].data).toMatchObject({ action: 'query', status: 'pending', sentAt: null });
    expect(db.company.update).not.toHaveBeenCalled();
    expect(buildCustomerRequest(company, 'query')).toContain('<FullName>SYNTHETIC A &amp; B</FullName>');
  });
  it.each(['<CustomerQueryRs statusCode="0"/>', response() + response(), response('Wrong customer'), response('', ''), '<CustomerAddRs statusCode="3140" statusMessage="Invalid reference"/>'])('rejects missing, ambiguous, mismatched, or failed results', async xml => {
    await expect(processCustomerResponse(entry, xml)).rejects.toThrow();
    expect(db.company.update).not.toHaveBeenCalled();
  });
});
