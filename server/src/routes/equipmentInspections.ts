import { normalizeServiceCharges, saveQaServices, linkedQaActions } from '../services/shopServiceCharges.js';
import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { createAuditLog } from '../utils/auditLog.js';
import { Prisma } from '../db.js';
import type { EquipmentInspectionCategory, InspectionOutcome } from '../db.js';
import { recomputeWOStatus } from './shopOrders.js';
import { lockInspectionRecord } from '../services/inspectionLock.js';

export const equipmentInspectionsRouter = Router();

// Wave 1 — unified Equipment Inspection Form (shop + field).
// See project_inspection_forms_and_transfers.md for design context.
//
// Belongs-to: exactly one of shopItemId | ticketId (DB CHECK enforces).
// Append-only: lockedAt-set records reject mutations; corrections file a new
// record via correctsId.
// Flow-back: on lock, outcome → SerializedEquipment.status via
// services/equipmentLifecycle.ts (condemn → condemned + decommission record;
// cannot_service → out_of_service). Mirrored in the offline sync replay path.

// ============================================================
// SERVICE ACTION VOCABULARIES — per category, validated at the API layer
// ============================================================
//
// These will move to a shared constants module once the field-side editor
// needs them too. For now, source-of-truth lives here.

// Category-agnostic actions valid for every category. Keep in sync with
// COMMON_ACTIONS in client/src/components/EquipmentInspectionEditor.tsx.
const COMMON_ACTIONS = ['visual_only', 'other'] as const;

const SERVICE_ACTION_VOCAB: Record<EquipmentInspectionCategory, readonly string[]> = {
  fire_extinguisher: [
    'annual', 'recharge', 'recharge_annual', 'six_year', 'twelve_year_hydro',
    'condemn', 'cannot_service', 'parts_replaced', ...COMMON_ACTIONS,
  ],
  gas_detection: [
    'bump_test', 'calibration', 'electronic_service', 'sensor_replace',
    'remove_from_service', 'parts_replaced', ...COMMON_ACTIONS,
  ],
  scba: [
    'air_fill_inspection', 'air_fill', 'flow_test', 'posi_check',
    'component_service', 'mask_service', 'regulator_service', 'parts_replaced',
    ...COMMON_ACTIONS,
  ],
  ue_cylinder: ['ue_test', 'hydro', 'condemn', 'parts_replaced', ...COMMON_ACTIONS],
  fall_arrest: [...COMMON_ACTIONS], // DeWalt sub-shape pending; common actions usable now
  breathing_air_system: [...COMMON_ACTIONS], // sub-shape TBD; common actions usable now
  first_aid_kit: ['restock', 'replace_expired', 'general_inspection', ...COMMON_ACTIONS],
  other: [...COMMON_ACTIONS],
};

function validateServiceActions(
  category: EquipmentInspectionCategory,
  actions: unknown,
): string[] {
  if (!Array.isArray(actions)) {
    throw new AppError(400, 'serviceActions must be an array');
  }
  const vocab = SERVICE_ACTION_VOCAB[category];
  // Empty vocab means anything-goes for that category (TBD/other) — accept as-is.
  // Otherwise reject unknown values to keep the data structured.
  if (vocab.length > 0) {
    for (const a of actions) {
      if (typeof a !== 'string' || !vocab.includes(a)) {
        throw new AppError(400, `Unknown serviceAction "${a}" for category ${category}`);
      }
    }
  }
  return actions as string[];
}

// ============================================================
// LIST — by parent (?shopItemId=X) or (?ticketId=Y)
// ============================================================

equipmentInspectionsRouter.get('/', async (req: Request, res: Response) => {
  const { shopItemId, ticketId, serializedEquipmentId } = req.query;

  if (!shopItemId && !ticketId && !serializedEquipmentId) {
    throw new AppError(400, 'Specify shopItemId, ticketId, or serializedEquipmentId');
  }

  const inspections = await prisma.equipmentInspection.findMany({
    where: {
      shopItemId: typeof shopItemId === 'string' ? shopItemId : undefined,
      ticketId: typeof ticketId === 'string' ? ticketId : undefined,
      serializedEquipmentId:
        typeof serializedEquipmentId === 'string' ? serializedEquipmentId : undefined,
    },
    orderBy: { inspectedAt: 'desc' },
    include: {
      inspectedBy: { select: { id: true, name: true } },
    },
  });

  res.json({ inspections });
});

// ============================================================
// ATTACHMENTS — condemn / cannot-service evidence + UE report PDF.
// Independent of the inspection's append-only lock (evidence can arrive late).
// ============================================================

// GET /api/equipment-inspections/:id/attachments
//
// Now reads the unified `attachments` table. The response keeps its old shape
// -- `fileType` and `filePath` are projected from `kind` and the storage state
// -- so existing callers keep working; new work should use /api/attachments,
// which exposes checksum and sync state as well.
equipmentInspectionsRouter.get('/:id/attachments', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const rows = await prisma.attachment.findMany({
    where: { inspectionId: id },
    orderBy: { capturedAt: 'asc' },
    select: {
      id: true, inspectionId: true, fileName: true, kind: true, mimeType: true,
      fileSizeBytes: true, capturedAt: true, storageState: true,
      bufferKey: true, remoteKey: true,
    },
  });
  const attachments = rows.map((a) => ({
    id: a.id,
    inspectionId: a.inspectionId,
    fileName: a.fileName,
    fileType: a.kind,
    // Legacy consumers used filePath to build a /api/files URL. Buffered files
    // are not in the file store yet, so point everything at the attachment
    // content route, which serves from whichever tier currently holds the bytes.
    filePath: a.remoteKey ?? a.bufferKey,
    contentUrl: `/api/attachments/${a.id}/content`,
    fileSizeBytes: a.fileSizeBytes,
    mimeType: a.mimeType,
    uploadedAt: a.capturedAt,
    storageState: a.storageState,
  }));
  res.json({ attachments });
});

// ============================================================
// CREATE
// ============================================================

equipmentInspectionsRouter.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const body = req.body ?? {};

  // Parent exclusivity — DB CHECK is the final guard but reject early for a clean error.
  const hasShopItem = typeof body.shopItemId === 'string' && body.shopItemId.length > 0;
  const hasTicket = typeof body.ticketId === 'string' && body.ticketId.length > 0;
  if (hasShopItem === hasTicket) {
    throw new AppError(400, 'Exactly one of shopItemId or ticketId is required');
  }

  if (!body.serialNumber || typeof body.serialNumber !== 'string') {
    throw new AppError(400, 'serialNumber is required');
  }
  if (!body.category) throw new AppError(400, 'category is required');
  if (!body.outcome) throw new AppError(400, 'outcome is required');

  let serviceActions = validateServiceActions(
    body.category as EquipmentInspectionCategory,
    body.serviceActions ?? [],
  );

  const services = hasShopItem && body.billingServices !== undefined ? await normalizeServiceCharges(body.billingServices) : null;
  if (services) serviceActions = validateServiceActions(body.category, linkedQaActions(serviceActions, services, body.category));
  const inspection = await prisma.$transaction(async tx => {
    if (services) await saveQaServices(tx, body.shopItemId, services, { userId, role: req.user!.role });
    return tx.equipmentInspection.create({
    data: {
      shopItemId: hasShopItem ? body.shopItemId : null,
      ticketId: hasTicket ? body.ticketId : null,
      serializedEquipmentId: body.serializedEquipmentId ?? null,
      serialNumber: body.serialNumber,
      category: body.category as EquipmentInspectionCategory,
      outcome: body.outcome as InspectionOutcome,
      serviceActions,
      data: body.data ?? {},
      partsReplaced: body.partsReplaced ?? null,
      notes: body.notes ?? null,
      inspectedById: userId,
      inspectedAt: body.inspectedAt ? new Date(body.inspectedAt) : new Date(),
      customerApprovedName: body.customerApprovedName ?? null,
      customerApprovedSignature: body.customerApprovedSignature ?? null,
      customerApprovedAt: body.customerApprovedAt ? new Date(body.customerApprovedAt) : null,
      correctsId: body.correctsId ?? null,
    },
  });
  });

  await createAuditLog({
    userId,
    action: 'create',
    entityType: 'equipment_inspection',
    entityId: inspection.id,
    changes: { category: inspection.category, outcome: inspection.outcome },
  });

  res.status(201).json(inspection);
});

// ============================================================
// UPDATE — rejected once lockedAt is set
// ============================================================

equipmentInspectionsRouter.patch('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;
  const body = req.body ?? {};

  const existing = await prisma.equipmentInspection.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'Inspection not found');

  if (existing.lockedAt) {
    throw new AppError(
      409,
      'Inspection is locked. File a correction by creating a new inspection with correctsId set to this id.',
    );
  }

  // serviceActions, if provided, must validate against current category
  let serviceActions: Prisma.InputJsonValue = existing.serviceActions as Prisma.InputJsonValue;
  if (body.serviceActions !== undefined) {
    serviceActions = validateServiceActions(existing.category, body.serviceActions);
  }

  const services = existing.shopItemId && body.billingServices !== undefined ? await normalizeServiceCharges(body.billingServices) : null;
  if (body.serialNumber !== undefined && (typeof body.serialNumber !== 'string' || !body.serialNumber.trim())) {
    throw new AppError(400, 'serialNumber is required');
  }
  if (services) serviceActions = validateServiceActions(existing.category, linkedQaActions(serviceActions as string[], services, existing.category));
  const updated = await prisma.$transaction(async tx => {
    if (services && existing.shopItemId) await saveQaServices(tx, existing.shopItemId, services, { userId, role: req.user!.role });
    return tx.equipmentInspection.update({
    where: { id },
    data: {
      outcome: body.outcome ?? undefined,
      serialNumber: typeof body.serialNumber === 'string' ? body.serialNumber.trim() : undefined,
      serviceActions,
      data: body.data ?? undefined,
      partsReplaced: body.partsReplaced ?? undefined,
      notes: body.notes ?? undefined,
      customerApprovedName: body.customerApprovedName ?? undefined,
      customerApprovedSignature: body.customerApprovedSignature ?? undefined,
      customerApprovedAt:
        body.customerApprovedAt !== undefined
          ? body.customerApprovedAt
            ? new Date(body.customerApprovedAt)
            : null
          : undefined,
    },
  });
  });

  await createAuditLog({
    userId,
    action: 'update',
    entityType: 'equipment_inspection',
    entityId: updated.id,
  });

  res.json(updated);
});

// ============================================================
// LOCK — irreversible. UI must surface a confirm-modal first.
// ============================================================

equipmentInspectionsRouter.post('/:id/lock', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;

  const { locked, flow, routing } = await lockInspectionRecord(prisma, id, userId);
  if (routing.routed && routing.workOrderId) {
    await recomputeWOStatus(routing.workOrderId);
  }

  res.json({ ...locked, lifecycle: flow, routing });
});
