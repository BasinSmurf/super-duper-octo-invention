import { describe, expect, it } from 'vitest';
import { loadSandboxQbScope, sandboxQueueFilter } from './qbSandboxScope.js';
const env = { QBWC_SANDBOX_MANIFEST: 'manifest.json', DATABASE_URL: 'postgresql://test@127.0.0.1:5435/sandbox', QBWC_COMPANY_FILE: 'C:\\Basin Test Company QB 2026\\TEST BASIN TEST 2026.qbw', QBWC_RUN_EVERY_N_MINUTES: '0' };
const scope = { invoiceIds: ['7092578c-cc0f-43a1-b0b4-17bfcd27c6e4'], companyIds: ['d0b9efe7-7282-494d-99a5-6aea2950a633'] };
const read = (() => JSON.stringify(scope)) as any;
describe('isolated QB sandbox campaign', () => {
  it('leaves ordinary connectors unchanged', () => {
    expect(loadSandboxQbScope({})).toBeNull();
    expect(sandboxQueueFilter(null)).toEqual({});
  });
  it('limits reads and claims to the explicit companies and invoices', () => {
    expect(loadSandboxQbScope(env, read)).toEqual(scope);
    expect(sandboxQueueFilter(scope)).toEqual({ OR: [
      { entityType: 'customer', action: { in: ['add', 'query'] }, entityId: { in: scope.companyIds } },
      { entityType: { in: ['invoice', 'sales_order'] }, action: { in: ['add', 'query'] }, entityId: { in: scope.invoiceIds } },
    ] });
  });
  it.each([
    { DATABASE_URL: 'postgresql://test@remote:5435/sandbox' },
    { DATABASE_URL: 'postgresql://test@127.0.0.1:5432/production' },
    { QBWC_COMPANY_FILE: '' }, { QBWC_COMPANY_FILE: 'C:\\Live.qbw' },
    { QBWC_RUN_EVERY_N_MINUTES: '5' },
  ])('rejects unsafe runtime configuration %j', override => {
    expect(() => loadSandboxQbScope({ ...env, ...override }, read)).toThrow(/requires/);
  });
  it.each([{ invoiceIds: [], companyIds: scope.companyIds }, { ...scope, companyIds: ['all'] }])('rejects a malformed scope', invalid => {
    expect(() => loadSandboxQbScope(env, (() => JSON.stringify(invalid)) as any)).toThrow(/Invalid/);
  });
});
