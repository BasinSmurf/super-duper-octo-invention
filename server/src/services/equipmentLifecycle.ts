/**
 * equipmentLifecycle.ts — flow-back from a locked EquipmentInspection to the
 * SerializedEquipment lifecycle status.
 *
 * Wired from services/inspectionLock.ts's lockInspectionRecord (called by the
 * explicit lock route, the shop_complete auto-lock, and the offline sync
 * replay). Runs once per inspection, right after the inspection is locked.
 *
 * Outcome → status mapping (decided 2026-06-02):
 *   condemn        → status `condemned` + decommission record (condemnedAt + reason).
 *                    STILL BILLABLE — billing suppression is the warranty path only
 *                    (ShopWorkOrderItem.isWarranty in shopBillingLines.ts), NOT this.
 *                    A condemn item still mints its labor/parts lines.
 *   cannot_service → status `out_of_service` (temporary "couldn't fix today"; no
 *                    decommission record).
 *   pass/fail/requires_parts → no status change.
 *
 * Safety: `condemned` is terminal — a later non-condemn inspection never
 * un-condemns a unit automatically.
 */
import type { PrismaClient, InspectionOutcome } from '../db.js';
import { createAuditLog } from '../utils/auditLog.js';

export interface InspectionOutcomeInput {
  id: string;
  outcome: InspectionOutcome;
  serializedEquipmentId: string | null;
  serialNumber: string;
  notes: string | null;
}

export interface OutcomeFlowResult {
  equipmentId: string;
  newStatus: 'condemned' | 'out_of_service';
}

/**
 * Apply a locked inspection's outcome to its serialized unit.
 * Returns the change made, or null if nothing flowed back (no-op outcome,
 * no resolvable unit, or already condemned).
 */
export async function applyInspectionOutcome(
  prisma: PrismaClient,
  inspection: InspectionOutcomeInput,
  userId: string | null,
): Promise<OutcomeFlowResult | null> {
  let newStatus: 'condemned' | 'out_of_service' | null = null;
  if (inspection.outcome === 'condemn') newStatus = 'condemned';
  else if (inspection.outcome === 'cannot_service') newStatus = 'out_of_service';
  if (!newStatus) return null;

  // Resolve the physical unit: prefer the FK, fall back to the snapshotted
  // serial (field inspections may carry only the serial string).
  let equipment = inspection.serializedEquipmentId
    ? await prisma.serializedEquipment.findUnique({ where: { id: inspection.serializedEquipmentId } })
    : null;
  if (!equipment && inspection.serialNumber) {
    equipment = await prisma.serializedEquipment.findUnique({
      where: { serialNumber: inspection.serialNumber },
    });
  }
  if (!equipment) return null; // ad-hoc / unserialized item — nothing to flow back to.

  // `condemned` is terminal — never auto-revert.
  if (equipment.status === 'condemned') return null;

  const data: { status: typeof newStatus; condemnedAt?: Date; condemnReason?: string } = {
    status: newStatus,
  };
  if (newStatus === 'condemned') {
    data.condemnedAt = new Date();
    data.condemnReason = inspection.notes?.trim() || `Condemned via inspection ${inspection.id}`;
  }

  await prisma.serializedEquipment.update({ where: { id: equipment.id }, data });

  await createAuditLog({
    userId: userId ?? undefined,
    action: 'status_change',
    entityType: 'serialized_equipment',
    entityId: equipment.id,
    changes: {
      status: { from: equipment.status, to: newStatus },
      via: 'equipment_inspection',
      inspectionId: inspection.id,
    },
  });

  return { equipmentId: equipment.id, newStatus };
}
