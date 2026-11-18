import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../db.js';
import { deliverOperationsDigest, digestSlot, renderOperationsDigest } from './operationsDigest.js';

describe('operations digest', () => {
  it('respects opt-out, 7 AM Chicago, Monday-only weekly delivery and DST', () => {
    expect(digestSlot('off', new Date('2026-09-28T15:00Z'))).toBeNull();
    expect(digestSlot(undefined, new Date('2026-09-28T15:00Z'))).toBeNull();
    expect(digestSlot('daily', new Date('2026-09-28T11:59Z'))).toBeNull();
    expect(digestSlot('daily', new Date('2026-09-28T12:00Z'))).toBe('2026-09-28');
    expect(digestSlot('weekly', new Date('2026-09-29T15:00Z'))).toBeNull();
    expect(digestSlot('weekly', new Date('2026-09-28T15:00Z'))).toBe('2026-09-28');
    expect(digestSlot('daily', new Date('2026-12-01T12:59Z'))).toBeNull();
  });
  it('claims once across workers, suppresses completed or ambiguous sends, retries recorded errors', async () => {
    const rows = new Map<string, string>();
    const db = { jobRun: {
      create: vi.fn(async ({ data }) => { if (rows.has(data.id)) throw { code: 'P2002' }; rows.set(data.id, data.status) }),
      updateMany: vi.fn(async ({ where, data }) => { if (rows.get(where.id) !== where.status) return { count: 0 }; rows.set(where.id, data.status); return { count: 1 } }),
      update: vi.fn(async ({ where, data }) => { rows.set(where.id, data.status) }),
    } };
    const send = vi.fn(async () => {});
    const deliver = () => deliverOperationsDigest(db as unknown as PrismaClient, 'synthetic:operations', '2026-09-28', send);
    await Promise.all([deliver(), deliver()]);
    await deliver();
    expect(send).toHaveBeenCalledTimes(1);
    rows.set('operations-digest:synthetic:operations:2026-09-28', 'error');
    send.mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(deliver()).rejects.toThrow('synthetic failure');
    await deliver();
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('escapes record text and generates direct links without executing HTML', () => {
    const report = { generatedAt: '2026-09-28', dateBasis: 'UTC', coverageBasis: 'Assignments', amounts: {}, jobs: [{ number: '<script>', customer: 'A&B', owner: null, href: '/tickets/synthetic', ageDays: 3, ageBasis: 'created', detail: 'Review' }], coverage: [], exceptions: [], lastSuccessfulQbResponseAt: null };
    const html = renderOperationsDigest(report as any, 'https://example.test');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('https://example.test/tickets/synthetic');
    expect(html).not.toContain('<script>');
    expect(() => renderOperationsDigest(report as any, 'javascript:alert(1)')).toThrow();
  });
});
