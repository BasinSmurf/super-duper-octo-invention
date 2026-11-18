import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSyncTicket, resolveSyncTicketId } from './syncTicketIdentity.js';
import { inspectionBillingError } from './inspectionBillingGuard.js';

describe('inspection line sync', () => {
  it('acknowledges a concurrently-created offline parent without rerunning create side effects', async () => {
    const ticket = { id: 'winner', offlineId: 'offline' };
    const db = { serviceTicket: { create: vi.fn().mockRejectedValue({ code: 'P2002' }), findFirst: vi.fn().mockResolvedValue(ticket) } };
    expect(await createSyncTicket(db as any, { offlineId: 'offline' } as any)).toEqual({ ticket, created: false });
    db.serviceTicket.findFirst.mockResolvedValue(null);
    await expect(createSyncTicket(db as any, { offlineId: 'offline' } as any)).rejects.toMatchObject({ code: 'P2002' });
    db.serviceTicket.create.mockRejectedValue({ code: 'P2003' });
    await expect(createSyncTicket(db as any, { offlineId: 'offline' } as any)).rejects.toMatchObject({ code: 'P2003' });
  });
  it('accepts every line type offered by the editor, including inspection', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const values = schema.match(/enum LineItemType \{([^}]+)\}/)![1].trim().split(/\s+/);
    const editor = readFileSync('../client/src/components/LineItemEditor.tsx', 'utf8');
    const offered = [...editor.matchAll(/\{ type: '([^']+)', label:/g)].map(match => match[1]);
    expect(offered).toContain('inspection');
    for (const value of offered) expect(values).toContain(value);
  });
  it('resolves an old offline parent ID after its create has left the batch', async () => {
    const db = { serviceTicket: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => ({ id: 'server-id' })) } };
    expect(await resolveSyncTicketId(db as any, 'offline-id')).toBe('server-id');
    expect(db.serviceTicket.findFirst).toHaveBeenCalledWith({ where: { offlineId: 'offline-id' }, select: { id: true } });
  });
  it('keeps server IDs and refuses an unknown parent rather than guessing', async () => {
    const db = { serviceTicket: { findUnique: vi.fn().mockResolvedValueOnce({ id: 'server-id' }).mockResolvedValue(null), findFirst: vi.fn(async () => null) } };
    expect(await resolveSyncTicketId(db as any, 'server-id')).toBe('server-id');
    expect(db.serviceTicket.findFirst).not.toHaveBeenCalled();
    await expect(resolveSyncTicketId(db as any, 'missing')).rejects.toThrow('Parent ticket has not synced');
  });
  it('blocks missing inspection charges while retaining legitimate log-only work', () => {
    const ticket = { serviceSubtype: 'cascade_air', customData: { cascadeAirSubtypes: ['inspection'] } };
    expect(inspectionBillingError(ticket, 0)).toContain('has not synced');
    expect(inspectionBillingError(ticket, 1)).toBeNull();
    expect(inspectionBillingError({ serviceSubtype: 'on_site_services' }, 0)).toBeNull();
    expect(inspectionBillingError({ ...ticket, customData: { cascadeAirSubtype: 'inspection' } }, 0)).not.toBeNull();
  });
});
