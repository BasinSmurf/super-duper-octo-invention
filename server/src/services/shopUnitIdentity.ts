import { AppError } from '../middleware/errorHandler.js';

interface UnitIdentity {
  serialNumber?: unknown;
  equipmentCategory?: unknown;
  serializedEquipmentId?: unknown;
}

/** One physical unit must not become two independently billable rows. Category
 * scopes serials because different manufacturers/categories can share numbers. */
export function assertNewShopUnits(incoming: UnitIdentity[], existing: UnitIdentity[] = []): void {
  const serialKey = (unit: UnitIdentity) => `${unit.equipmentCategory || 'other'}:${String(unit.serialNumber || '').trim().toUpperCase()}`;
  const serials = new Set(existing.map(serialKey));
  const assets = new Set(existing.map(u => u.serializedEquipmentId).filter(Boolean));
  for (const unit of incoming) {
    if (typeof unit.serialNumber !== 'string' || !unit.serialNumber.trim()) {
      throw new AppError(400, 'A serial number is required for every unit');
    }
    const key = serialKey(unit);
    if (serials.has(key) || (unit.serializedEquipmentId && assets.has(unit.serializedEquipmentId))) {
      throw new AppError(409, `Unit ${unit.serialNumber.trim()} is already included on this work order. Edit the existing unit instead.`);
    }
    serials.add(key);
    if (unit.serializedEquipmentId) assets.add(unit.serializedEquipmentId);
  }
}
