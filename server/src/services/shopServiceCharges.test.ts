import { describe, it, expect, vi } from 'vitest';
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma: { product: { findMany: vi.fn() } } }))() }));
import { prisma } from '../db.js';
import { linkedQaActions, normalizeServiceCharges, serviceQaMapping, saveQaServices, validateVendorServiceLink } from './shopServiceCharges.js';

describe('shop services and QA linkage', () => {
  it('requires a selected service for catalog vendor billing, while preserving legacy pass-through', () => {
    expect(() => validateVendorServiceLink({ vendor: { cost: 50 } })).not.toThrow();
    expect(() => validateVendorServiceLink({ vendor: { mode: 'catalog_service', serviceProductId: 'ue' }, services: [{ productId: 'ue' }] })).not.toThrow();
    expect(() => validateVendorServiceLink({ vendor: { mode: 'catalog_service', serviceProductId: 'ue' }, services: [] })).toThrow('Select that service');
  });
  it('prevents QA from removing the service that covers the vendor cost', async () => {
    const tx = { shopWorkOrderItem: { findUnique: vi.fn().mockResolvedValue({ status: 'in_work', billing: {
      vendor: { mode: 'catalog_service', serviceProductId: 'ue', cost: 50 }, services: [{ productId: 'ue', quantity: 1, rate: 100 }],
    } }), update: vi.fn() } };
    await expect(saveQaServices(tx as never, 'unit', [], { userId: 'user', role: 'admin' })).rejects.toThrow('Select that service');
    expect(tx.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });
  it('maps real QB services, including a bundled recharge/annual, without guessing seed items', () => {
    expect(serviceQaMapping('0612011')).toEqual({ category: 'fire_extinguisher', actions: ['recharge_annual'] });
    expect(serviceQaMapping('0614002')?.actions).toEqual(['condemn']);
    expect(serviceQaMapping('0631001')?.actions).toEqual(['calibration']);
    expect(serviceQaMapping('0623006')).toEqual({ category: 'ue_cylinder', actions: ['ue_test'] });
    expect(serviceQaMapping('FEX-RECHARGE-ABC')).toBeNull();
    expect(serviceQaMapping('0613001')).toBeNull(); // CO2 five-year hydro is not twelve-year hydro.
  });
  it('normalizes catalog identity and actions instead of trusting client descriptions', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([{ id: 'cal', partNumber: '0631001', name: '4 Gas Calibration', unitOfMeasure: 'EA' }] as never);
    const services = await normalizeServiceCharges([{ productId: 'cal', name: 'fake', serviceActions: ['condemn'], quantity: 1, rate: 35 }]);
    expect(services[0].name).toBe('4 Gas Calibration');
    expect(linkedQaActions(['bump_test'], services, 'gas_detection')).toEqual(['bump_test', 'calibration']);
    expect(linkedQaActions([], services, 'fire_extinguisher')).toEqual([]);
    expect(linkedQaActions(['calibration'], services, 'gas_detection')).toEqual(['calibration']);
  });
  it('rejects duplicate services and incomplete/invalid money rather than saving accidental charges', async () => {
    await expect(normalizeServiceCharges([{ productId: 'cal', quantity: 1, rate: '' }])).rejects.toThrow('rate');
    await expect(normalizeServiceCharges([{ productId: 'cal', quantity: -1, rate: 35 }])).rejects.toThrow('quantity');
    await expect(normalizeServiceCharges([{ productId: 'cal', quantity: 1, rate: 35 }, { productId: 'cal', quantity: 1, rate: 35 }])).rejects.toThrow('duplicate');
  });
  it('refuses to change a hard-closed unit through QA', async () => {
    const tx = { shopWorkOrderItem: { findUnique: vi.fn().mockResolvedValue({ status: 'returned', hardClosesAt: new Date('2020-01-01'), softClosedAt: new Date('2020-01-01'), billing: null }), update: vi.fn() } };
    await expect(saveQaServices(tx as never, 'unit', [{ productId: 'new-service', quantity: 1, rate: 35 } as never], { userId: 'user', role: 'admin' })).rejects.toThrow();
    expect(tx.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });
  it('allows QA corrections with unchanged charges without rewriting closed billing', async () => {
    const tx = { shopWorkOrderItem: { findUnique: vi.fn().mockResolvedValue({ status: 'returned', hardClosesAt: new Date('2020-01-01'), billing: null }), update: vi.fn() } };
    await saveQaServices(tx as never, 'unit', [], { userId: 'user', role: 'admin' });
    expect(tx.shopWorkOrderItem.update).not.toHaveBeenCalled();
  });
});
