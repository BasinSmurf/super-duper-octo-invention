import { describe, expect, it, vi } from 'vitest';
import { parseScbaAssembly, saveScbaAssembly } from './scbaAssembly.js';

const input = { durationMinutes: 5, caseId: ' CASE-5 ', regulatorSerial: 'REG-1', tankSerial: 'TANK-1',
  posiCheckDate: '2026-10-02', hydroDate: '2024-02-29' };

function mockTx(existing: any = null) {
  return {
    product: { upsert: vi.fn().mockImplementation(async ({ where }) => ({ id: where.partNumber })) },
    serializedEquipment: {
      findUnique: vi.fn().mockImplementation(async ({ where }) => where.id ? existing : null),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'new-pack', ...data })),
      update: vi.fn().mockImplementation(async ({ data }) => ({ ...existing, ...data })),
    },
  };
}

describe('SCBA assemblies', () => {
  it.each([5, 30])('creates a %s-minute assembly with Case ID badge identity and linked subparts', async durationMinutes => {
    const tx = mockTx();
    const result = await saveScbaAssembly(tx as any, { ...input, durationMinutes });
    expect(result.serialNumber).toBe('CASE-5');
    expect(tx.product.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ isAssembly: true, isSerialized: true, name: `SCBA ${durationMinutes} min Pack` }) }));
    expect(tx.serializedEquipment.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      serialNumber: 'REG-1', parentEquipmentId: 'new-pack', customData: { scbaComponent: 'regulator' },
    }) });
    expect(tx.serializedEquipment.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      serialNumber: 'TANK-1', parentEquipmentId: 'new-pack', lastCalibrationDate: new Date('2024-02-29'),
    }) });
    expect(result.customData.scba.posiCheckDate).toBe('2026-10-02');
  });
  it.each([
    { durationMinutes: 15 }, { caseId: ' ' }, { tankSerial: 'REG-1' },
    { hydroDate: '2025-02-29' }, { posiCheckDate: 'not-a-date' }, { tankSerial: '' },
  ])('rejects invalid identity or date input: %j', patch => {
    expect(() => parseScbaAssembly({ ...input, ...patch })).toThrow();
  });
  it('allows adding component serials after creating the case', async () => {
    const tx = mockTx();
    await saveScbaAssembly(tx as any, { durationMinutes: 30, caseId: 'CASE-30' });
    expect(tx.serializedEquipment.create).toHaveBeenCalledTimes(1);
  });
  it('keeps other custom data and component history when replacing a tank', async () => {
    const tx = mockTx({ id: 'pack', ownership: 'basin_safety', status: 'available',
      customData: { scba: { durationMinutes: 5 }, source: 'import' },
      childEquipment: [{ id: 'old-tank', serialNumber: 'OLD', customData: { scbaComponent: 'tank' } }] });
    await saveScbaAssembly(tx as any, { ...input, regulatorSerial: '' }, 'pack');
    expect(tx.serializedEquipment.update).toHaveBeenCalledWith({ where: { id: 'old-tank' }, data: { parentEquipmentId: null } });
    expect(tx.serializedEquipment.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pack' }, data: expect.objectContaining({ customData: expect.objectContaining({ source: 'import' }) }) }));
    expect(tx.serializedEquipment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ serialNumber: 'TANK-1', parentEquipmentId: 'pack' }) });
  });
  it('rejects a serial belonging to another unit', async () => {
    const tx = mockTx();
    tx.serializedEquipment.findUnique.mockResolvedValue({ id: 'other-unit' });
    await expect(saveScbaAssembly(tx as any, input)).rejects.toThrow('already exists');
  });
  it('links an available existing tank and preserves its identity and metadata', async () => {
    const tx = mockTx();
    tx.serializedEquipment.findUnique.mockResolvedValue({ id: 'existing-tank', serialNumber: 'TANK-1',
      status: 'available', ownership: 'basin_safety', parentEquipmentId: null, currentRentalId: null,
      product: { category: 'supplied_air_component', name: 'SCBA Cylinder', isAssembly: false }, customData: { source: 'import' } });
    await saveScbaAssembly(tx as any, { ...input, regulatorSerial: '' });
    expect(tx.serializedEquipment.create).toHaveBeenCalledTimes(1);
    expect(tx.serializedEquipment.update).toHaveBeenCalledWith({ where: { id: 'existing-tank' },
      data: expect.objectContaining({ parentEquipmentId: 'new-pack', customData: { source: 'import', scbaComponent: 'tank' } }) });
  });
});
