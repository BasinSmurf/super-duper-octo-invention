import { describe, expect, it } from 'vitest';
import { assertNewShopUnits } from './shopUnitIdentity.js';

describe('shop unit identities within one intake/addition', () => {
  it('rejects duplicate serials inside the same submitted batch', () => {
    expect(() => assertNewShopUnits([
      { serialNumber: 'SYNTHETIC-1', equipmentCategory: 'fire_extinguisher' },
      { serialNumber: ' synthetic-1 ', equipmentCategory: 'fire_extinguisher' },
    ])).toThrow(/already included/);
  });
  it('rejects the same serialized asset even if its serial/category is changed', () => {
    expect(() => assertNewShopUnits([
      { serialNumber: 'SYNTHETIC-1', serializedEquipmentId: 'asset' },
      { serialNumber: 'SYNTHETIC-2', serializedEquipmentId: 'asset', equipmentCategory: 'scba' },
    ])).toThrow(/already included/);
  });
  it('allows separate equipment categories to use the same serial text', () => {
    expect(() => assertNewShopUnits([
      { serialNumber: '123', equipmentCategory: 'fire_extinguisher' },
      { serialNumber: '123', equipmentCategory: 'personal_monitor' },
    ])).not.toThrow();
  });
  it('does not claim success for a blank serial that would otherwise be silently skipped', () => {
    expect(() => assertNewShopUnits([{ serialNumber: '  ' }])).toThrow(/serial number is required/);
  });
});
