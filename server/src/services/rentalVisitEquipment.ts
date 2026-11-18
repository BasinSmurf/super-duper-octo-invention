import type { ManualRentalEquipment } from './manualRentalEquipment.js';

/** One visit view over recorded serials and inventory-backed contract rows; no duplicate assets or charges. */
export function rentalVisitEquipment(rental: { composition?: any; items?: any[] }): ManualRentalEquipment[] {
  const manual: ManualRentalEquipment[] = rental.composition?.manualEquipment || [];
  const ids = new Set(manual.map(row => row.id));
  return [...manual, ...(rental.items || []).filter(item => !ids.has(item.id)).map(item => ({
    id: item.id, serial: item.serializedEquipment?.serialNumber || item.serialNumber || '',
    type: item.product?.name || item.productName || 'Equipment', testDate: item.deployInspection?.testDate || '',
    deployedAt: new Date(item.deployedDate).toISOString().slice(0, 10), status: item.status,
    ...(item.deployInspection?.returnInspectionId ? { returnInspectionId: item.deployInspection.returnInspectionId } : {}),
    ...(item.returnedDate ? { returnedAt: new Date(item.returnedDate).toISOString().slice(0, 10) } : {}),
    ...(item.deployInspection?.lastSwapDate ? { lastSwapDate: item.deployInspection.lastSwapDate } : {}),
  }))];
}
