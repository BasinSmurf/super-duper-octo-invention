import { AppError } from '../middleware/errorHandler.js';

export interface ManualRentalEquipment {
  id: string;
  serial: string;
  type: string;
  testDate: string;
  deployedAt: string;
  status?: 'deployed' | 'returned';
  returnedAt?: string;
  lastSwapDate?: string;
  returnInspectionId?: string;
}

/** Changes rental text rows only; snapshots on the visit preserve their history. */
export function applyManualEquipmentVisit(composition: any, input: {
  workType: 'rental_swap' | 'rental_return'; selections: any[]; serviceDate: string;
  requestId: string; inspection?: any; userId: string;
}) {
  const saved: ManualRentalEquipment[] = composition?.manualEquipment || [];
  if (!Array.isArray(input.selections) || !input.selections.length || input.selections.length > 500
    || new Set(input.selections.map(row => row?.itemId)).size !== input.selections.length) {
    throw new AppError(400, 'Select unique equipment rows');
  }
  if (input.workType === 'rental_return') for (const selection of input.selections) {
    const inspection = selection.inspection || input.inspection;
    if (!inspection || !['good', 'minor_damage', 'major_damage', 'needs_repair'].includes(inspection.overallCondition)
      || ['physicalDamage', 'cleanlinessOk', 'calibrationCurrent', 'accessoriesReturned'].some(key => typeof inspection[key] !== 'boolean'))
      throw new AppError(400, 'Complete an inspection for each selected equipment row');
  }
  const equipment = saved.map(row => ({ ...row }));
  const records = input.selections.map(selection => {
    const index = equipment.findIndex(row => row.id === selection?.itemId);
    const row = equipment[index];
    if (!row || row.status === 'returned') throw new AppError(409, 'Selected equipment is no longer deployed; reload the rental');
    if (input.serviceDate < row.deployedAt.slice(0, 10) || input.serviceDate < (row.lastSwapDate || '')) {
      throw new AppError(400, 'Visit date cannot precede deployment or the latest swap');
    }
    if (selection.expected && ['serial', 'type', 'testDate'].some(key => selection.expected[key] !== (row as any)[key])) {
      throw new AppError(409, 'Equipment changed; reload the rental before continuing');
    }
    if (input.workType === 'rental_swap') {
      const replacement = selection.replacement;
      if (!replacement || ['serial', 'type', 'testDate'].some(key => typeof replacement[key] !== 'string' || !replacement[key].trim() || replacement[key].length > 1000)) {
        throw new AppError(400, 'Enter Serial, Type, and Test date for every replacement');
      }
      equipment[index] = { ...row, serial: replacement.serial.trim(), type: replacement.type.trim(), testDate: replacement.testDate.trim(), lastSwapDate: input.serviceDate };
    } else {
      equipment[index] = { ...row, status: 'returned', returnedAt: input.serviceDate, returnInspectionId: input.requestId };
    }
    return { itemId: row.id, before: row, after: equipment[index], ...(input.workType === 'rental_return' ? { inspection: selection.inspection || input.inspection } : {}) };
  });
  return {
    composition: { ...composition, manualEquipment: equipment },
    records, allReturned: equipment.every(row => row.status === 'returned'),
  };
}

/** Free-text equipment stays on the agreement without creating inventory assets. */
export function mergeManualRentalEquipment(composition: any, entries: unknown): Record<string, any> {
  if (!Array.isArray(entries) || !entries.length || entries.length > 500
    || entries.some(row => !row || ['id', 'serial', 'type', 'testDate', 'deployedAt'].some(key => typeof row[key] !== 'string' || !row[key].trim() || row[key].length > 1000))) {
    throw new AppError(400, 'Enter Serial, Type, and Test date for every equipment row');
  }
  const ids = new Set(entries.map(row => row.id));
  if (ids.size !== entries.length) throw new AppError(400, 'Duplicate equipment row IDs');
  const saved: ManualRentalEquipment[] = composition?.manualEquipment || [];
  return { ...composition, manualEquipment: [...saved, ...entries.filter(row => !saved.some(existing => existing.id === row.id)).map(row => ({
    id: row.id, serial: row.serial, type: row.type, testDate: row.testDate, deployedAt: row.deployedAt,
  }))] };
}
