import { jobAttachmentUnits, createJobAttachments, deleteStoredAttachment } from '../services/jobAttachments.js';
import { mergeManualRentalEquipment } from '../services/manualRentalEquipment.js';
import { saveManualRentalVisit } from '../services/manualRentalVisit.js';
import { assertShopSerialsCollected } from '../services/shopSerials.js';
import { appendRentalEventLog } from '../services/rentalEventLog.js';
import { assertShopBinsAvailable } from '../services/shopBins.js';
import { withRental, deployRentalItem, returnRentalItem, closeRental } from '../services/rentalLifecycle.js';
import { ticketFields, validateTicketInput, editableTicket, assertTicketWriteAccess, assertDraftDeletion, assertOfflineStatus, mutateTicketLine } from '../services/ticketWritePolicy.js';
import { prepareTicketCustomerChange } from '../services/ticketCustomerChange.js';
import { isTrainingRosterReplay } from '../utils/trainingRosterReplay.js';
import { allowedFields, objectBody, validateRentalInput, numberValue, validDate } from '../services/writeValidation.js';
import { safeErrorMessage } from '../middleware/errorHandler.js';
import { randomUUID } from 'crypto';
import { createSyncTicket, resolveSyncTicketId } from '../services/syncTicketIdentity.js';
import { assertSyncApprovalRole } from '../services/syncApproval.js';
import { roleHasCapability } from '../services/permissions.js';
import { applyWorkPointVerification, verificationUpdate as parseVerificationUpdate } from '../services/workPointVerification.js';
import { basename } from 'node:path';
import { v5 as uuidv5 } from 'uuid';
import { Router, Request, Response } from 'express';
import { Prisma } from '../db.js';
import type { AttachmentKind, ShopItemStatus } from '../db.js';
import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { enrichCustomData } from '../utils/notesExtraction.js';
import { preserveTicketOrigin } from '../utils/ticketOrigin.js';
import { computeBillingGroupKey } from '../utils/billingGroupKey.js';
import { flatOverridesFromPayload } from '../services/billingRefs.js';
import { selectBillingProfile } from '../services/billingProfileSelector.js';
import { deriveRentalFlags } from '../services/rentalComposition.js';
import { shouldRecordOnly, recordTicketAsRentalLog } from '../services/rentalTicketRecord.js';
import { defaultDivisionForWork } from '../utils/qbClass.js';
import { buildLocationDisplay } from '../utils/locationDisplay.js';
import { runAndCacheReviewSignal } from '../services/ticketReviewRules.js';
import { getFileStore } from '../services/fileStore.js';
import {
  attachmentKey,
  ingestAttachmentBytes,
  ChecksumMismatchError,
} from '../services/attachmentStore.js';
import { createShopWorkOrderWithItems, validateShopIntakeItems } from '../services/shopWoCreate.js';
import { CREDIT_HOLD_MESSAGE, assertShopReturnAllowed } from '../utils/companyGuards.js';
import { applyInspectionOutcome } from '../services/equipmentLifecycle.js';
import { routeShopItemFromInspection } from '../services/inspectionRouting.js';
import { checkCondemnEvidence } from '../services/condemnEvidence.js';
import { evaluateItemQa, resolveQaDivert } from '../services/shopQaGate.js';
import { recomputeWOStatus } from './shopOrders.js';
import { enqueueInspectionRecord, enqueueAttachment } from '../services/blueLionEnqueue.js';
import { SENT_OUT_STATUSES, parseReceivePayload, receiveUpdateData, vendorReturnDocumentError } from '../services/shopVendorReceive.js';
import { autoLockPassedInspections } from '../services/inspectionLock.js';

export const syncRouter = Router();

/**
 * GET /api/sync/pull?tables=companies,products&since=2024-01-01T00:00:00Z
 *
 * Bulk delta-sync endpoint.  Returns records updated after `since` for each
 * requested table.  If `since` is omitted the full table is returned (initial
 * hydrate).  Each table payload includes a `serverNow` timestamp the client
 * should store as the new watermark.
 *
 * Response shape:
 * {
 *   serverNow: "2024-06-01T12:00:00.000Z",
 *   tables: {
 *     companies: { data: [...], count: 42 },
 *     products:  { data: [...], count: 1279 },
 *     ...
 *   }
 * }
 */

const ALLOWED_TABLES = [
  'companies',
  'fields',
  'pads',
  'wells',
  'products',
  'equipment',
  'courses',
  'priceLevels',
  'tickets',
  'rentalAgreements',
  'rentalAgreementItems',
  'rentalDailyLogs',
  'shopWorkOrders',
  'shopWorkOrderItems',
  'equipmentInspections',
  'shopTransferEvents',
] as const;

// Writable tables where records can be deleted server-side.
// For delta syncs we send allIds so the client can prune orphaned records.
const WRITABLE_TABLES: ReadonlySet<string> = new Set([
  'tickets',
  'rentalAgreements',
  'rentalAgreementItems',
  'rentalDailyLogs',
  'shopWorkOrders',
  'shopWorkOrderItems',
  'equipmentInspections',
  'shopTransferEvents',
]);

// Tables eligible for allIds-based pruning — writable tables plus reference
// tables that can also be hard-deleted server-side (e.g. a pad removed during
// DMR cleanup/consolidation). Distinct from WRITABLE_TABLES because pads are
// still read-only reference data from the client's perspective; this only
// controls whether we compute+send allIds so the client can prune orphans.
const PRUNABLE_TABLES: ReadonlySet<string> = new Set([...WRITABLE_TABLES, 'pads', 'priceLevels', 'products']);

type SyncTable = (typeof ALLOWED_TABLES)[number];

// Map sync table names → Prisma model access + select fields
// We strip relations and only return columns the offline DB cares about.
function buildQuery(table: SyncTable, since: Date | null, userId: string, role: string) {
  const where: any = since ? { updatedAt: { gt: since } } : {};

  switch (table) {
    case 'companies':
      // #3/#4: carry the customer's field labels + a lightweight seed of active
      // billing profiles so the wizard can pre-fill PO/AFE/Cost-Code rows and
      // pick the right profile by job type — all offline.
      return prisma.company.findMany({
        where,
        select: {
          id: true, name: true, legalName: true, parentCompanyId: true,
          companyType: true, isActive: true, cashCcOnly: true, creditHold: true, address: true, city: true,
          state: true, zip: true, phone: true, email: true, updatedAt: true,
          poLabel: true, afeLabel: true, woLabel: true, costCenterLabel: true,
          // The customer's contract pricebook. Carried offline so the ticket
          // wizard and the shop screens can price a line the way the invoice
          // will — see the `priceLevels` table below.
          qbPriceLevelId: true,
          billingProfiles: {
            where: { isActive: true },
            select: {
              id: true, requiresPo: true, requiresAfe: true, afeNumberSource: true,
              defaultPoNumber: true, defaultAfeNumber: true, defaultCostCenter: true,
              appliesToTicketTypes: true, appliesToDivisions: true,
              effectiveFrom: true, effectiveTo: true,
            },
            orderBy: { effectiveFrom: 'desc' },
          },
        },
        orderBy: { updatedAt: 'asc' },
      }).then(rows => rows.map(({ billingProfiles, ...r }) => ({
        ...r,
        billingProfilesSeed: billingProfiles,
      })));

    case 'courses':
      // ClassPRO course catalog — reference data for the training wizard's
      // course picker. Inactive rows sync too so old drafts still render.
      return prisma.cpCourse.findMany({
        where,
        select: {
          id: true, code: true, name: true, durationHours: true,
          validityMonths: true, passingScore: true, cardsOnSite: true,
          bookVersion: true, testVersion: true, standard: true,
          description: true, sortOrder: true, isActive: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      });

    case 'priceLevels':
      // Per-customer contract pricebooks pulled from QB (PriceLevelQueryRq).
      // Tiny — ~10 levels / ~140 item rules in prod — so the whole set rides
      // down to every device rather than being scoped per customer: a tech
      // can pick any customer in the wizard, including offline.
      //
      // Items ride nested. PriceLevelItem has no updatedAt of its own, but the
      // QBWC pull always writes the parent level row in the same transaction
      // it replaces the items (routes/qbwc.ts), so the parent's updatedAt is a
      // sound delta watermark for the whole level.
      return prisma.priceLevel.findMany({
        where,
        select: {
          id: true, name: true, isActive: true,
          qbCustomerListId: true, qbCustomerName: true, updatedAt: true,
          items: {
            select: {
              qbItemListId: true, qbItemFullName: true,
              customPrice: true, adjustPercent: true,
            },
          },
        },
        orderBy: { updatedAt: 'asc' },
      }).then(rows => rows.map(pl => ({
        ...pl,
        // Decimal → number here rather than on the device: the client resolver
        // mirrors the server's arithmetic, and it can't do that on strings.
        items: pl.items.map(it => ({
          qbItemListId: it.qbItemListId,
          qbItemFullName: it.qbItemFullName,
          customPrice: it.customPrice == null ? null : Number(it.customPrice),
          adjustPercent: it.adjustPercent == null ? null : Number(it.adjustPercent),
        })),
      })));

    case 'fields':
      return prisma.field.findMany({
        where,
        select: {
          id: true, name: true, county: true, state: true,
          notes: true, isActive: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      });

    case 'pads':
      return prisma.pad.findMany({
        where,
        select: {
          id: true, name: true, fieldId: true, currentOperatorId: true,
          currentOperator: { select: { name: true } },
          section: true, township: true, range: true,
          latitude: true, longitude: true, county: true,
          directions: true, accessNotes: true, facilityCode: true,
          pendingReview: true, tier1: true, assetCategory: true, isActive: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      }).then(rows => rows.map(({ currentOperator, ...r }) => ({
        ...r,
        currentOperatorName: currentOperator?.name ?? null,
      })));

    case 'wells':
      return prisma.well.findMany({
        where,
        select: {
          id: true, padId: true, fieldId: true, currentOperatorId: true,
          currentOperator: { select: { name: true } },
          apiNumber: true, wellName: true, wellNameBase: true,
          wellType: true, wellStatus: true, county: true, facilityCode: true,
          latitude: true, longitude: true,
          hasSuppliedAir: true, hasAreaMonitors: true, isHighRisk: true, tier1: true,
          isActiveForService: true, pendingReview: true, assetCategory: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      }).then(rows => rows.map(({ currentOperator, ...r }) => ({
        ...r,
        currentOperatorName: currentOperator?.name ?? null,
      })));

    case 'products':
      return prisma.product.findMany({
        where,
        select: {
          id: true, partNumber: true, name: true, description: true,
          category: true, productType: true, unitOfMeasure: true,
          division: true, partFamily: true, partSubgroup: true,
          defaultSellPrice: true, defaultRentalRateDaily: true,
          // The join key a PriceLevelItem matches on. Without it offline
          // pricing can only ever quote list.
          qbItemListId: true,
          defaultRentalRateWeekly: true, defaultRentalRateMonthly: true,
          isSerialized: true, isAssembly: true, isActive: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      });

    case 'equipment':
      return prisma.serializedEquipment.findMany({
        where,
        select: {
          id: true, productId: true, serialNumber: true, ownership: true,
          status: true, currentPadId: true, currentWellId: true,
          currentFacilityId: true, currentCustomerId: true, currentRentalId: true,
          parentEquipmentId: true,
          calibrationDueDate: true, lastCalibrationDate: true,
          bumpTestDueDate: true, safeCoreSerial: true, conditionNotes: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      });

    case 'tickets': {
      // Field techs: own tickets from last 7 days + any active ones
      // All roles: only recent/active tickets (don't dump 44K legacy records to clients)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);

      if (role === 'field_tech') {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        sevenDaysAgo.setHours(0, 0, 0, 0);
        where.assignedTechId = userId;
        where.OR = [
          { serviceDate: { gte: sevenDaysAgo } },
          { status: { in: ['draft', 'dispatched', 'in_progress'] } },
        ];
      } else {
        // Admins/supervisors: last 30 days + any active tickets
        where.OR = [
          { serviceDate: { gte: thirtyDaysAgo } },
          { status: { in: ['draft', 'dispatched', 'in_progress', 'completed', 'supervisor_review', 'billing_queue'] } },
        ];
      }
      return prisma.serviceTicket.findMany({
        where,
        select: {
          id: true, ticketNumber: true, ticketType: true, serviceSubtype: true,
          offlineId: true, offlineCreated: true,
          status: true, companyId: true, fieldId: true, padId: true,
          wellId: true, facilityId: true, workPointId: true, locationDisplay: true,
          rejectionReason: true, createdById: true, createdBy: { select: { id: true, name: true } }, assignedTech: { select: { id: true, name: true } },
          assignedTechId: true, serviceDate: true, arrivalTime: true,
          departureTime: true, afeNumber: true, poNumber: true,
          costCenter: true, billingRefs: true,
          // division + isDickinson resolve to the QB class. Omitting them here
          // meant the client synced a ticket without its D3/D4 choice, so the
          // wizard reopened blank AND a re-save pushed division:null, wiping it.
          division: true, isDickinson: true,
          customerRepName: true, customerRepSignature: true, techSignature: true,
          dispatchNotes: true, workDescription: true, internalNotes: true,
          linkedRentalAgreementId: true, customData: true,
          createdAt: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      });
    }

    case 'rentalAgreements':
      return prisma.rentalAgreement.findMany({
        where,
        select: {
          id: true, agreementNumber: true, companyId: true,
          fieldId: true, padId: true, wellId: true, wellIds: true,
          status: true, startDate: true, endDate: true,
          billingRateType: true, poNumber: true, afeNumber: true,
          notes: true,
          liabilityAcknowledged: true, liabilitySignedByName: true,
          liabilitySignature: true, liabilitySignedAt: true,
          siteContactName: true, siteContactPhone: true, siteContactEmail: true,
          pics: true, composition: true, billingPolicy: true,
          createdAt: true, updatedAt: true,
          company: { select: { name: true } },
        },
        orderBy: { updatedAt: 'asc' },
      }).then(rows => rows.map(r => ({
        ...r,
        companyName: r.company?.name ?? null,
        company: undefined,
      })));

    case 'rentalAgreementItems':
      return prisma.rentalAgreementItem.findMany({
        where: since ? { rentalAgreement: { updatedAt: { gt: since } } } : {},
        select: {
          id: true, rentalAgreementId: true, productId: true,
          serializedEquipmentId: true, rate: true, rateType: true,
          deployedDate: true, returnedDate: true, status: true,
          deployInspection: true,
          product: { select: { name: true } },
          serializedEquipment: { select: { serialNumber: true } },
        },
        orderBy: { deployedDate: 'asc' },
      }).then(rows => rows.map(r => ({
        ...r,
        productName: r.product?.name ?? null,
        serialNumber: r.serializedEquipment?.serialNumber ?? null,
        product: undefined,
        serializedEquipment: undefined,
        rate: r.rate ? Number(r.rate) : null,
      })));

    case 'rentalDailyLogs':
      return prisma.rentalDailyLog.findMany({
        where,
        select: {
          id: true, rentalAgreementId: true, logDate: true, loggedById: true,
          equipmentPresent: true, equipmentStatus: true,
          cascadeStatus: true, bottlesFullCount: true, bottlesTotalCount: true,
          monitorsBumpTested: true, monitorsOperationalCount: true, monitorsTotalCount: true,
          notes: true, entries: true,
          offlineId: true, offlineCreated: true,
          createdAt: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'asc' },
      }).then(rows => rows.map(r => ({
        ...r,
        entries: (r.entries as any[]) ?? [],
      })));

    case 'shopWorkOrders':
      return prisma.shopWorkOrder.findMany({
        where,
        select: {
          id: true, workOrderNumber: true, status: true,
          companyId: true, isInternal: true,
          poNumber: true, afeNumber: true,
          intakeDate: true, intakeNotes: true, intakeById: true,
          // Basin Site this WO was received at + optional Pad pointers
          intakeSiteId: true,
          sourceLocationId: true, returnLocationId: true,
          promisedDate: true, priority: true,
          completedDate: true, returnedDate: true,
          dropOffContactName: true, dropOffContactPhone: true,
          dropOffContactEmail: true, dropOffContactPreferred: true,
          pickupContactName: true, pickupContactPhone: true,
          pickupContactEmail: true, pickupContactPreferred: true,
          pickupSignedByName: true, pickupSignature: true,
          pickupSignedAt: true, pickupNotes: true,
          totalItems: true, completedItems: true,
          primaryCategory: true, notes: true,
          createdAt: true, updatedAt: true,
          company: { select: { name: true } },
          intakeBy: { select: { name: true } },
        },
        orderBy: { updatedAt: 'asc' },
      }).then(rows => rows.map(r => ({
        ...r,
        companyName: r.company?.name ?? null,
        intakeByName: r.intakeBy?.name ?? null,
        company: undefined,
        intakeBy: undefined,
      })));

    case 'equipmentInspections':
      // Wave 1 — unified Equipment Inspection record (polymorphic on
      // shopItemId | ticketId). Append-only event log.
      return prisma.equipmentInspection.findMany({
        where,
        select: {
          id: true, shopItemId: true, ticketId: true,
          serializedEquipmentId: true, serialNumber: true, category: true,
          outcome: true, serviceActions: true, data: true,
          partsReplaced: true, notes: true,
          inspectedById: true, inspectedAt: true,
          customerApprovedName: true, customerApprovedSignature: true,
          customerApprovedAt: true,
          lockedAt: true, correctsId: true,
          createdAt: true, updatedAt: true,
          inspectedBy: { select: { name: true } },
        },
        orderBy: { updatedAt: 'asc' },
      }).then(rows => rows.map(r => ({
        ...r,
        inspectedByName: r.inspectedBy?.name ?? null,
        inspectedBy: undefined,
      })));

    case 'shopTransferEvents':
      // Wave 2 — append-only log of shop-to-shop transfers within Basin.
      return prisma.shopTransferEvent.findMany({
        where: since ? { workOrder: { updatedAt: { gt: since } } } : {},
        select: {
          id: true, workOrderId: true, fromSiteId: true, toSiteId: true,
          transferredById: true, transferredAt: true, notes: true,
          createdAt: true,
          transferredBy: { select: { name: true } },
        },
        orderBy: { transferredAt: 'asc' },
      }).then(rows => rows.map(r => ({
        ...r,
        transferredByName: r.transferredBy?.name ?? null,
        transferredBy: undefined,
      })));

    case 'shopWorkOrderItems':
      return prisma.shopWorkOrderItem.findMany({
        where: since ? { workOrder: { updatedAt: { gt: since } } } : {},
        select: {
          id: true, workOrderId: true, itemNumber: true,
          serializedEquipmentId: true, serialNumber: true,
          equipmentCategory: true, productId: true, equipmentDescription: true,
          fexBrand: true, fexSize: true, fexType: true,
          serviceType: true, reportedIssue: true, status: true,
          diagnosisNotes: true, diagnosedById: true, diagnosedAt: true,
          estimatedCost: true, quoteSentAt: true, quoteApprovedAt: true, quoteDeclinedAt: true,
          assignedToId: true, workNotes: true, workCompletedAt: true,
          isWarranty: true, warrantyVendor: true,
          sentOutDate: true, sentOutMethod: true, sentOutTracking: true, sentOutTo: true,
          receivedBackDate: true, receivedBackNotes: true,
          qcTestedById: true, qcResult: true, qcNotes: true, qcCompletedAt: true,
          returnedAt: true, returnMethod: true,
          partsUsed: true, parentItemId: true,
          createdAt: true, updatedAt: true,
        },
        orderBy: { itemNumber: 'asc' },
      }).then(rows => rows.map(r => ({
        ...r,
        estimatedCost: r.estimatedCost ? Number(r.estimatedCost) : null,
      })));

    default:
      throw new AppError(400, `Unknown sync table: ${table}`);
  }
}

/** Fetch just the IDs for a writable table (for orphan pruning on delta syncs). */
function buildAllIds(table: SyncTable, userId: string, role: string): Promise<{ id: string }[]> {
  switch (table) {
    case 'tickets': {
      const where: any = {};
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      if (role === 'field_tech') {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        sevenDaysAgo.setHours(0, 0, 0, 0);
        where.assignedTechId = userId;
        where.OR = [
          { serviceDate: { gte: sevenDaysAgo } },
          { status: { in: ['draft', 'dispatched', 'in_progress'] } },
        ];
      } else {
        where.OR = [
          { serviceDate: { gte: thirtyDaysAgo } },
          { status: { in: ['draft', 'dispatched', 'in_progress', 'completed', 'supervisor_review', 'billing_queue'] } },
        ];
      }
      return prisma.serviceTicket.findMany({ where, select: { id: true } });
    }
    case 'rentalAgreements':
      return prisma.rentalAgreement.findMany({ select: { id: true } });
    case 'rentalAgreementItems':
      return prisma.rentalAgreementItem.findMany({ select: { id: true } });
    case 'rentalDailyLogs':
      return prisma.rentalDailyLog.findMany({ select: { id: true } });
    case 'shopWorkOrders':
      return prisma.shopWorkOrder.findMany({ select: { id: true } });
    case 'shopWorkOrderItems':
      return prisma.shopWorkOrderItem.findMany({ select: { id: true } });
    case 'equipmentInspections':
      return prisma.equipmentInspection.findMany({ select: { id: true } });
    case 'shopTransferEvents':
      return prisma.shopTransferEvent.findMany({ select: { id: true } });
    case 'pads':
      return prisma.pad.findMany({ select: { id: true } });
    case 'products':
      return prisma.product.findMany({ select: { id: true } });
    case 'priceLevels':
      // A level deleted in QB has to disappear from the device too — a stale
      // contract price cached forever is worse than no contract price.
      return prisma.priceLevel.findMany({ select: { id: true } });
    default:
      return Promise.resolve([]);
  }
}

syncRouter.get('/pull', async (req: Request, res: Response, next) => {
  try {
    const tablesParam = (req.query.tables as string) || '';
    const sinceParam = req.query.since as string | undefined;

    const requestedTables = tablesParam
      .split(',')
      .map(t => t.trim())
      .filter(Boolean) as SyncTable[];

    if (requestedTables.length === 0) {
      throw new AppError(400, 'tables query param required (e.g. tables=companies,products)');
    }

    // Validate table names
    for (const t of requestedTables) {
      if (!ALLOWED_TABLES.includes(t)) {
        throw new AppError(400, `Invalid sync table: ${t}. Allowed: ${ALLOWED_TABLES.join(', ')}`);
      }
    }

    const since = sinceParam ? new Date(sinceParam) : null;
    const serverNow = new Date().toISOString();
    const userId = req.user!.userId;
    const role = req.user!.role as string;

    // Run all table queries in parallel
    const entries = await Promise.all(
      requestedTables.map(async (table) => {
        const data = await buildQuery(table, since, userId, role);
        // For prunable tables during delta sync, also fetch all current IDs
        // so the client can prune records deleted on the server.
        let allIds: string[] | undefined;
        if (since && PRUNABLE_TABLES.has(table)) {
          allIds = (await buildAllIds(table, userId, role)).map(r => r.id);
        }
        return [table, { data, count: data.length, allIds }] as const;
      }),
    );

    const tables: Record<string, { data: unknown[]; count: number; allIds?: string[] }> = {};
    for (const [table, result] of entries) {
      tables[table] = result;
    }

    res.json({ serverNow, tables });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/push
 *
 * Receives a batch of mutations from the client's outbox queue.
 * Each mutation is { table, action, entityId, offlineId, payload }.
 * Returns results for each mutation so the client can mark them done.
 *
 * Request body:
 * {
 *   mutations: [
 *     { queueId: 1, table: "tickets", action: "create", entityId: "...", offlineId: "...", payload: {...} },
 *     ...
 *   ]
 * }
 *
 * Response:
 * {
 *   results: [
 *     { queueId: 1, status: "ok", serverId: "..." },
 *     { queueId: 2, status: "error", error: "..." },
 *   ]
 * }
 */
interface MutationRequest {
  queueId: number;
  table: string;
  action: 'create' | 'update' | 'delete';
  entityId: string;
  offlineId?: string | null;
  expectedStatus?: any;
  expectedUpdatedAt?: Date;
  payload: Record<string, unknown>;
}

syncRouter.post('/push', async (req: Request, res: Response, next) => {
  try {
    const { mutations } = req.body as { mutations: MutationRequest[] };
    if (!Array.isArray(mutations) || mutations.length === 0) {
      throw new AppError(400, 'mutations array required');
    }

    const userId = req.user!.userId;
    const results: Array<{
      queueId: number;
      status: 'ok' | 'error';
      serverId?: string;
      ticketId?: string;
      error?: string;
      warnings?: string[];
    }> = [];

    // Track offline ID → server ID remaps so child records (line items,
    // fit test records) can resolve foreign keys within a single push batch
    const idRemaps = new Map<string, string>();
    const submittedHere = new Set<string>();

    // Track tickets that landed in supervisor_review during this batch.
    // The rules engine runs once per ticket AFTER the whole batch commits
    // so line items pushed as separate mutations are already in place.
    const ticketsNeedingReview = new Set<string>();
    const ticketsNeedingRentalDisposition = new Set<string>();

    console.log(`[sync/push] Processing ${mutations.length} mutations from user ${userId}`);
    for (const mut of mutations) {

      // Remap ticketId in child record payloads if the ticket was created
      // earlier in this batch with a different server ID
      if (mut.table !== 'tickets' && mut.payload.ticketId) {
        const remapped = idRemaps.get(mut.payload.ticketId as string);
        if (remapped) {
          mut.payload = { ...mut.payload, ticketId: remapped };
        }
      }

      // Remap rentalAgreementId in rental item payloads
      if (mut.table === 'rentalAgreementItems' && mut.payload.rentalAgreementId) {
        const remapped = idRemaps.get(mut.payload.rentalAgreementId as string);
        if (remapped) {
          mut.payload = { ...mut.payload, rentalAgreementId: remapped };
        }
      }

      // Remap workOrderId in shop work order item payloads
      if (mut.table === 'shopWorkOrderItems' && mut.payload.workOrderId) {
        const remapped = idRemaps.get(mut.payload.workOrderId as string);
        if (remapped) {
          mut.payload = { ...mut.payload, workOrderId: remapped };
        }
      }

      // Remap inspectionId in inspection-attachment payloads (parent inspection
      // may have been created earlier in this batch)
      if (
        (mut.table === 'equipmentInspectionAttachments' || mut.table === 'attachments')
        && mut.payload.inspectionId
      ) {
        const remapped = idRemaps.get(mut.payload.inspectionId as string);
        if (remapped) {
          mut.payload = { ...mut.payload, inspectionId: remapped };
        }
      }

      // Same for a photo taken against a shop unit that was itself created
      // offline in this batch -- without this the attachment would reference an
      // id the server has already replaced, and the insert would fail its
      // foreign key after the device had been told it was safe to delete.
      if (mut.table === 'attachments' && mut.payload.shopItemId) {
        const remapped = idRemaps.get(mut.payload.shopItemId as string);
        if (remapped) {
          mut.payload = { ...mut.payload, shopItemId: remapped };
        }
      }

      try {
        if (mut.table === 'tickets' && mut.action !== 'delete') {
          assertSyncApprovalRole(req.user!.role, mut.payload);
        }
        // Persisted identity covers retries after the parent left this batch.
        if (mut.table !== 'tickets' && typeof mut.payload.ticketId === 'string' && mut.payload.ticketId) {
          mut.payload = { ...mut.payload, ticketId: await resolveSyncTicketId(prisma, mut.payload.ticketId) };
        }
        if (mut.table === 'tickets' && mut.action !== 'create') {
          mut.entityId = await resolveSyncTicketId(prisma, mut.entityId);
        }
        objectBody(mut.payload);
        if (!['create', 'update', 'delete'].includes(mut.action)) throw new AppError(400, 'Invalid mutation action');
        const childModels: Record<string, string> = { ticketLineItems: 'ticketLineItem', ticketAttachments: 'ticketAttachment', fitTestRecords: 'fitTestRecord', airSystemRecords: 'airSystemInspection', ihTestRecords: 'ihTestRecord', gasDetectionRecords: 'gasDetectionRecord', trainingRosterRecords: 'trainingRosterRecord' };
        if (mut.table === 'tickets') {
          const { _offlineStatus, offlineCreated, offlineId, status, ...data } = mut.payload as any;
          allowedFields(data, ticketFields);
          if (mut.action !== 'delete') await validateTicketInput(mut.payload, mut.action === 'create');
          if (mut.action === 'create') {
            if (!['field_tech', 'dispatch', 'field_super', 'platform_admin', 'trainer', 'train_admin'].includes(req.user!.role)) throw new AppError(403, 'Ticket creation is not permitted');
            if (data.assignedTechId && data.assignedTechId !== userId && !['dispatch', 'field_super', 'platform_admin'].includes(req.user!.role)) throw new AppError(403, 'Cannot assign work to another user');
            assertOfflineStatus(null, status || 'draft', req.user!.role);
          }
          else {
            const current = await editableTicket(mut.entityId, req.user!, status === 'supervisor_review');
            if (mut.action !== 'delete') await validateTicketInput({ ...data, ticketType: data.ticketType ?? current.ticketType, serviceSubtype: data.serviceSubtype ?? current.serviceSubtype });
            mut.expectedStatus = current.status;
            mut.expectedUpdatedAt = current.updatedAt;
            if (mut.action === 'delete') assertDraftDeletion(current);
            assertOfflineStatus(current.status, status, req.user!.role);
            if (mut.action === 'update') await prepareTicketCustomerChange(current, mut.payload);
            if (data.assignedTechId && data.assignedTechId !== current.assignedTechId && !['dispatch', 'field_super', 'platform_admin'].includes(req.user!.role)) throw new AppError(403, 'Cannot reassign this ticket');
          }
        }
        if (mut.table === 'rentalAgreements' && mut.action === 'create') validateRentalInput(mut.payload, true);
        if (mut.table === 'rentalAgreements' && mut.payload.equipmentVisit) {
          if (mut.action !== 'update' || !roleHasCapability(req.user!.role, 'tickets:create')) throw new AppError(403, 'Ticket creation is not permitted');
        }
        if (mut.table === 'fitTestRecords' && mut.action !== 'delete') {
          if (mut.action === 'create' || mut.payload.employeeName !== undefined) {
            if (typeof mut.payload.employeeName !== 'string' || !mut.payload.employeeName.trim()) throw new AppError(400, 'Employee name is required');
          }
          if (mut.payload.fitFactor != null) numberValue(mut.payload.fitFactor, 'fitFactor', 0, 1000000);
          if (mut.payload.testDate != null) validDate(mut.payload.testDate, 'testDate');
        }
        const model = childModels[mut.table];
        let parentId = mut.payload.ticketId as string | undefined;
        if (model) {
          // Older PhotoCapture clients restarted their counter on reload. Give
          // colliding creates a stable ticket-scoped identity so a lost ack can
          // be retried without moving or overwriting the other ticket's photo.
          if (mut.table === 'ticketAttachments' && mut.action === 'create' && parentId && /^photo_\d+$/.test(mut.entityId)) {
            const legacy = await prisma.ticketAttachment.findUnique({ where: { id: mut.entityId } });
            if (legacy && legacy.ticketId !== parentId) {
              mut.entityId = uuidv5(`ticketAttachment:${parentId}:${mut.entityId}`, uuidv5.URL);
              mut.payload = { ...mut.payload, id: mut.entityId };
            }
          }
          const existing = await (prisma as any)[model].findUnique({ where: { id: mut.entityId } });
          // A successful roster removal may be replayed after the response was
          // lost, including old outbox entries without a parent ID. There is
          // nothing left to mutate; acknowledge the retry. Live rows still go
          // through the ownership and ticket-lock checks below.
          if (mut.table === 'trainingRosterRecords' && mut.action === 'delete' && !existing) {
            results.push({ queueId: mut.queueId, status: 'ok', serverId: mut.entityId });
            continue;
          }
          if (existing && parentId && parentId !== existing.ticketId) throw new AppError(409, 'Child record belongs to another ticket');
          parentId = existing?.ticketId || parentId;
          if (!parentId) throw new AppError(400, 'ticketId is required');
          if (mut.table === 'trainingRosterRecords' && mut.action === 'update' && existing && isTrainingRosterReplay(existing, mut.payload)) {
            assertTicketWriteAccess(await prisma.serviceTicket.findUnique({ where: { id: parentId } }), req.user!);
            results.push({ queueId: mut.queueId, status: 'ok', serverId: mut.entityId, ticketId: parentId });
            continue;
          }
          await editableTicket(parentId, req.user!, submittedHere.has(parentId) || mut.action === 'create');
          if (mut.table === 'ticketLineItems' && mut.action !== 'delete') {
            const { ticketId, _offlineStatus, ...line } = mut.payload as any;
            mut.payload = { ...line, ticketId: parentId };
          }
        }
        const { ticketId: _lineParent, _offlineStatus: _lineOffline, ...lineData } = mut.payload as any;
        const result: MutationResult = mut.table === 'ticketLineItems'
          ? await mutateTicketLine(parentId!, mut.action, mut.entityId, lineData, req.user!, submittedHere.has(parentId!) || mut.action === 'create')
          : await processMutation(mut, userId, req.user!.role);
        if (mut.table === 'tickets' && mut.payload.status === 'supervisor_review') submittedHere.add(result.id);
        results.push({
          queueId: mut.queueId,
          status: 'ok',
          serverId: result.id,
          ...(mut.table !== 'tickets' && typeof mut.payload.ticketId === 'string' ? { ticketId: mut.payload.ticketId } : {}),
          ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        });
        // Warnings ride the 'ok' result so the device still clears the queue,
        // but they get a server-side log line too — the device may be a tablet
        // in a truck whose console nobody will ever read.
        for (const w of result.warnings ?? []) {
          console.warn(
            `[sync/push]   → WARNING ${mut.table}.${mut.action} id=${mut.entityId}: ${w}`,
          );
        }

        // If create returned a different ID, track the remap
        if (mut.action === 'create' && result.id !== mut.entityId) {
          idRemaps.set(mut.entityId, result.id);
        }

        // Track ticket IDs that landed in supervisor_review so we can run
        // the rules engine AFTER all line items in this batch are committed.
        // Running per-mutation would see an empty line-items table for
        // freshly-created tickets.
        if (
          mut.table === 'tickets' &&
          (mut.action === 'create' || mut.action === 'update') &&
          (mut.payload.status === 'supervisor_review')
        ) {
          ticketsNeedingReview.add(result.id);
        }

        // Rental-linked tickets handed off in this batch, for the post-batch
        // log-only disposition. Collected separately from the review set: a
        // ticket pushed straight to billing_queue never enters review but still
        // needs the disposition.
        if (
          mut.table === 'tickets' &&
          (mut.action === 'create' || mut.action === 'update') &&
          (mut.payload.status === 'supervisor_review' || mut.payload.status === 'billing_queue')
        ) {
          ticketsNeedingRentalDisposition.add(result.id);
        }
      } catch (err) {
        const e = err as any;
        // Some errors carry an empty `message` (Prisma validation wrappers,
        // rethrown AppErrors constructed without one), which logged as a bare
        // "→ ERROR:" with nothing after it — a failing mutation retrying every
        // cycle, forever, with no way to tell what or why. Name the mutation
        // and fall back through the other fields the error actually carries.
        const message = safeErrorMessage(err);
        const detail = [
          e?.name,
          e?.code ? `code=${e.code}` : null,
          message || null,
          !message && e?.meta ? `meta=${JSON.stringify(e.meta)}` : null,
        ].filter(Boolean).join(' ') || String(err) || 'unknown error (no message on the thrown value)';
        results.push({ queueId: mut.queueId, status: 'error', error: detail });
        console.error(
          `[sync/push]   → ERROR ${mut.table}.${mut.action} id=${mut.entityId}: ${detail}`,
        );
      }
    }

    // Post-batch, and BEFORE the rules engine: a rental-linked ticket with no
    // ticket-level billable lines closes as a log-only record, so there's no
    // point computing a review signal for it. The rental itself may still be
    // billable on its normal daily/weekly/monthly cadence; this disposition is
    // expected for daily log tickets and should not nag the tech.
    for (const ticketId of ticketsNeedingRentalDisposition) {
      try {
        const closedRecordOnly = await maybeRecordOnlyRentalTicket(ticketId);
        if (closedRecordOnly) {
          ticketsNeedingReview.delete(ticketId);
          console.info(`[sync/push] post-batch ticket ${ticketId}: closed as rental daily-log record`);
        }
      } catch (err) {
        console.error(
          `[sync/push] rental log-only disposition failed for ticket ${ticketId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Post-batch: compute and cache review signals for any tickets that
    // landed in supervisor_review during this batch. Line items pushed in
    // later mutations are now committed so the rules engine sees them.
    for (const ticketId of ticketsNeedingReview) {
      try {
        await runAndCacheReviewSignal(ticketId);
      } catch (err) {
        console.error(
          `[sync/push] Review rules failed for ticket ${ticketId}:`,
          err instanceof Error ? err.message : err,
        );
        // Non-fatal — the ticket is already in supervisor_review; the
        // dashboard will show a "pending check" grey badge until the next
        // rules run (triggered by any subsequent update or auto-processor).
      }
    }

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

/**
 * What a replayed mutation reports back. `warnings` is the soft channel: the
 * mutation COMMITTED and must be dropped from the device queue, but something
 * about it needs a human eye. Distinct from the error path, which keeps the
 * mutation queued for retry — a warning is never retryable, because retrying
 * it would duplicate the record that already landed.
 */
type MutationResult = { id: string; warnings?: string[] };

async function processMutation(mut: MutationRequest, userId: string, role: string): Promise<MutationResult> {
  switch (mut.table) {
    case 'tickets':
      return processTicketMutation(mut, userId);
    case 'ticketAttachments':
      return processAttachmentMutation(mut);
    // 'equipmentInspectionAttachments' is the pre-unification table name. A
    // device that queued a photo before this deploy still has it spelled that
    // way, so the alias stays -- dropping it would strand exactly the offline
    // captures this pipeline exists to protect.
    case 'equipmentInspectionAttachments':
    case 'attachments':
      return processUnifiedAttachmentMutation(mut, userId);
    case 'fitTestRecords':
      return processFitTestMutation(mut, userId);
    case 'airSystemRecords':
      return processAirSystemMutation(mut, userId, role);
    case 'ihTestRecords':
      return processIhTestMutation(mut, userId);
    case 'gasDetectionRecords':
      return processGasDetectionMutation(mut, userId);
    case 'trainingRosterRecords':
      return processTrainingRosterMutation(mut, userId);
    case 'rentalAgreements':
      return processRentalAgreementMutation(mut, userId);
    case 'rentalAgreementItems':
      return processRentalAgreementItemMutation(mut, userId);
    case 'rentalDailyLogs':
      return processRentalDailyLogMutation(mut, userId);
    case 'shopWorkOrders':
      return processShopWorkOrderMutation(mut, userId);
    case 'shopWorkOrderItems':
      return processShopWorkOrderItemMutation(mut, userId);
    case 'equipmentInspections':
      return processEquipmentInspectionMutation(mut, userId);
    case 'shopTransferEvents':
      return processShopTransferEventMutation(mut, userId);
    default:
      throw new Error(`Unsupported push table: ${mut.table}`);
  }
}

/**
 * Phase B On-Site Services > Manned Trailer side-effect: when the ticket
 * carries a `customData.onSiteSubtype === 'manned_trailer'` payload AND a
 * linkedRentalAgreementId, mirror the shift's site-log entry into the
 * rental's RentalDailyLog so daily-log analytics include the manned-trailer
 * shifts. Idempotent: skips when the user/date pair already has a log row.
 */
async function maybeWriteRentalDailyLogFromTicket(ticket: {
  id: string;
  ticketNumber: string | null;
  customData: any;
  linkedRentalAgreementId: string | null;
  serviceDate: Date;
  assignedTechId: string | null;
  createdById: string | null;
}): Promise<void> {
  const cd = ticket.customData as any;
  if (['rental_deploy', 'rental_return', 'rental_swap'].includes(cd?.workType)) {
    if (ticket.linkedRentalAgreementId) await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM rental_agreements WHERE id = ${ticket.linkedRentalAgreementId} FOR UPDATE`;
      await appendRentalEventLog(tx, ticket);
    });
    return;
  }
  if (cd?.onSiteSubtype !== 'manned_trailer') return;
  if (!ticket.linkedRentalAgreementId) return;

  const log = cd.onSiteLog;
  if (!log) return;

  const loggedById = ticket.assignedTechId || ticket.createdById;
  if (!loggedById) {
    console.warn(`[sync/push] manned-trailer ticket ${ticket.ticketNumber}: no tech to attribute the log to — skipping rental daily log mirror`);
    return;
  }

  // Idempotency: skip if a log already exists for this rental + date + tech.
  // RentalDailyLog has no unique on (rental, date, tech) so we check manually.
  const logDate = new Date(ticket.serviceDate);
  const existing = await prisma.rentalDailyLog.findFirst({
    where: {
      rentalAgreementId: ticket.linkedRentalAgreementId,
      logDate,
      loggedById,
    },
    select: { id: true },
  });
  if (existing) return;

  // Entries on the ticket already match the SiteLogEntry shape used by
  // RentalDailyLog (id, time, type, text, ppm?, location?, createdAt) — pass
  // straight through. Fall back to a synthesized pair of shift_start/shift_end
  // entries for legacy tickets that pre-date the entries pattern.
  let entries: Prisma.InputJsonValue;
  if (Array.isArray(log.entries) && log.entries.length > 0) {
    entries = log.entries as Prisma.InputJsonValue;
  } else {
    entries = [
      ...(log.workPerformed
        ? [{ id: 'legacy-note', time: '00:00', type: 'note', text: String(log.workPerformed), createdAt: new Date().toISOString() }]
        : []),
      ...(log.personnel
        ? [{ id: 'legacy-personnel', time: '00:00', type: 'note', text: `Personnel: ${log.personnel}`, createdAt: new Date().toISOString() }]
        : []),
    ];
  }

  // Concise notes summary from the entries (or fall back to legacy field).
  const notesSummary = Array.isArray(log.entries) && log.entries.length > 0
    ? (log.entries as any[])
        .filter(e => e.text)
        .map(e => `${e.date || logDate.toISOString().slice(0, 10)} ${e.time || ''} ${e.type === 'h2s' ? `[H₂S ${e.ppm ?? '?'}ppm${e.location ? ` @ ${e.location}` : ''}]` : ''} ${e.text}`.trim())
        .join('\n')
    : (log.workPerformed ? String(log.workPerformed) : null);

  await prisma.rentalDailyLog.create({
    data: {
      rentalAgreementId: ticket.linkedRentalAgreementId,
      logDate,
      loggedById,
      equipmentPresent: true,
      equipmentStatus: 'operational',
      notes: notesSummary,
      entries,
    },
  });
}

/**
 * Rental-linked log-only disposition, sync side. A rental-linked ticket with
 * nothing to charge is a record of a shift, not a bill — close it against the
 * rental's daily log instead of letting it sit in review or the billing queue.
 *
 * The sync path had NO disposition and no deployment gate at all: it spreads
 * the device's payload straight into Prisma, `status` included.
 *
 * MUST run post-batch, for the same reason the rules engine does: the wizard
 * queues the ticket mutation ahead of its line-item mutations, so mid-batch the
 * line-items table is still empty and every ticket would look unbillable.
 * Returns true when it diverts. This used to return a sync warning, but daily
 * log tickets are an expected rental workflow: the rental is billable on its
 * cadence even when the ticket itself has no lines. Keep the tech's device
 * quiet and leave only the durable ticket/rental state.
 */
async function maybeRecordOnlyRentalTicket(ticketId: string): Promise<boolean> {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true, ticketNumber: true, status: true, workDescription: true,
      customData: true, serviceDate: true, linkedRentalAgreementId: true,
      assignedTechId: true, createdById: true,
    },
  });
  if (!ticket) return false;
  // Only at the point the ticket is being handed off; a draft stays a draft.
  if (ticket.status !== 'supervisor_review' && ticket.status !== 'billing_queue') return false;
  if (!(await shouldRecordOnly(ticket))) return false;

  await recordTicketAsRentalLog(ticket, ticket.linkedRentalAgreementId!, null);
  return true;
}

/**
 * #1 PIC roster write-through: when a ticket linked to a rental agreement
 * carries `customData.pics`, mirror that roster onto the agreement so it stays
 * the canonical contact log a relieving tech inherits. Merge by `id` (union of
 * the agreement's existing roster + the ticket's) rather than clobbering, so
 * two techs editing across separate shifts don't drop each other's entries.
 */
async function maybeWritePicsToRentalFromTicket(ticket: {
  ticketNumber: string | null;
  customData: any;
  linkedRentalAgreementId: string | null;
}): Promise<void> {
  if (!ticket.linkedRentalAgreementId) return;
  const incoming = (ticket.customData as any)?.pics;
  if (!Array.isArray(incoming)) return; // absent = no edit this submit; leave roster alone

  const agreement = await prisma.rentalAgreement.findUnique({
    where: { id: ticket.linkedRentalAgreementId },
    select: { pics: true },
  });
  if (!agreement) return;

  const existing = Array.isArray(agreement.pics) ? (agreement.pics as any[]) : [];
  const byId = new Map<string, any>();
  for (const p of existing) if (p && p.id) byId.set(String(p.id), p);
  for (const p of incoming) if (p && p.id) byId.set(String(p.id), p); // ticket wins on collision

  await prisma.rentalAgreement.update({
    where: { id: ticket.linkedRentalAgreementId },
    data: { pics: Array.from(byId.values()) as Prisma.InputJsonValue },
  });
}

/**
 * Phase B Cascade Air > New Install side-effect: when the ticket carries
 * `customData.newInstalls`, mint one WorkPoint per system at the ticket's
 * location. Keep `customData.newInstall` and ticket.workPointId pointed at the
 * first system for legacy readers.
 */
async function maybeCreateWorkPointFromTicket(ticket: {
  id: string;
  ticketNumber: string | null;
  padId: string | null;
  wellId: string | null;
  facilityId: string | null;
  workPointId: string | null;
  customData: any;
}): Promise<void> {
  const customData = (ticket.customData as any) || {};
  const installs = Array.isArray(customData.newInstalls) && customData.newInstalls.length > 0
    ? customData.newInstalls
    : customData.newInstall
      ? [customData.newInstall]
      : [];
  const validInstalls = installs.filter((ni: any) => ni?.workPointName);
  if (validInstalls.length === 0) return;
  const existingCreatedIds = Array.isArray(customData.newInstallWorkPointIds)
    ? customData.newInstallWorkPointIds.filter((id: any) => typeof id === 'string' && id)
    : ticket.workPointId
      ? [ticket.workPointId]
      : [];
  if (existingCreatedIds.length >= validInstalls.length) return;

  // WorkPoint must hang off exactly one parent (well / pad / facility).
  // Ticket's location is the source of truth — prefer pad → well → facility.
  const parent: { padId?: string; wellId?: string; facilityId?: string } = {};
  if (ticket.padId) parent.padId = ticket.padId;
  else if (ticket.wellId) parent.wellId = ticket.wellId;
  else if (ticket.facilityId) parent.facilityId = ticket.facilityId;
  else {
    console.warn(`[sync/push] new-install ticket ${ticket.ticketNumber} has no location parent — skipping workpoint create`);
    return;
  }

  type IncomingCylinder = { serialNumber?: string; hydroDate?: string; expiryDate?: string };
  const createdIds = [...existingCreatedIds];
  for (const ni of validInstalls.slice(existingCreatedIds.length)) {
    // Cylinders: prefer the new structured array; fall back to the pre-fix
    // string-array payload for any in-flight tickets that pre-date it.
    let cylinders: Array<{ serialNumber: string; hydroDate?: string; expiryDate?: string }> = [];
    if (Array.isArray(ni.cylinders)) {
      cylinders = (ni.cylinders as IncomingCylinder[])
        .filter(c => c?.serialNumber && String(c.serialNumber).trim())
        .map(c => ({
          serialNumber: String(c.serialNumber).trim(),
          ...(c.hydroDate ? { hydroDate: c.hydroDate } : {}),
          ...(c.expiryDate ? { expiryDate: c.expiryDate } : {}),
        }));
    } else if (Array.isArray(ni.cylinderSerials)) {
      cylinders = ni.cylinderSerials
        .filter((s: any) => typeof s === 'string' && s.trim())
        .map((s: string) => ({ serialNumber: s.trim() }));
    }

    const wpCustomData: Record<string, unknown> = {};
    if (cylinders.length > 0) wpCustomData.cylinders = cylinders;
    if (ni.regulatorSerial) wpCustomData.regulatorSerial = String(ni.regulatorSerial).trim();
    if (ni.installDescription) wpCustomData.installDescription = String(ni.installDescription).trim();

    const wp = await prisma.workPoint.create({
      data: {
        name: String(ni.workPointName),
        workPointType: 'air_system_location',
        ...parent,
        hasSuppliedAir: true,
        airSystemType: ni.airSystemType || null,
        reelSerialNumber: ni.reelSerialNumber || null,
        standSerialNumber: ni.standSerialNumber || null,
        customData: Object.keys(wpCustomData).length > 0
          ? (wpCustomData as Prisma.InputJsonValue)
          : undefined,
      },
    });
    createdIds.push(wp.id);
  }

  await prisma.serviceTicket.update({
    where: { id: ticket.id },
    data: {
      workPointId: ticket.workPointId || createdIds[0] || null,
      customData: {
        ...customData,
        newInstalls: validInstalls,
        newInstall: validInstalls[0],
        newInstallWorkPointIds: createdIds,
      } as Prisma.InputJsonValue,
    },
  });
}

async function processTicketMutation(mut: MutationRequest, userId: string): Promise<{ id: string }> {
  // Strip client-only fields
  const { _offlineStatus, offlineCreated, offlineId: payloadOfflineId, ...payload } = mut.payload as any;
  const offlineId = payloadOfflineId || mut.offlineId || mut.entityId;

  switch (mut.action) {
    case 'create': {
      // Idempotency: if a ticket with this offlineId already exists, return it
      // (handles duplicate pushes when the client didn't clean up the first time)
      if (offlineId) {
        const existing = await prisma.serviceTicket.findFirst({
          where: { offlineId },
          select: { id: true },
        });
        if (existing) {
          console.log(`[sync] Ticket with offlineId=${offlineId} already exists as ${existing.id}, skipping create`);
          return { id: existing.id };
        }
      }

      // companyId is mandatory — refuse to create a customer-less ticket
      // rather than silently stripping the FK (which produced orphaned tickets
      // when an offline edit-reopen dropped the customer). Throwing here keeps
      // the mutation queued so it can succeed on a later push.
      if (!payload.companyId) {
        throw new Error('Ticket create: companyId is required — refusing to create a customer-less ticket');
      }
      const company = await prisma.company.findUnique({ where: { id: payload.companyId }, select: { id: true, isActive: true, creditHold: true, name: true } });
      if (!company) {
        throw new Error(`Ticket create: company ${payload.companyId} not found — client may need to re-sync reference data`);
      }
      // Block new work for a customer deactivated after this ticket was drafted
      // offline. Only this mutation fails; the rest of the batch still syncs.
      if (!company.isActive) {
        throw new Error(`${company.name} is inactive — reactivate the customer to create new work.`);
      }
      // Same for a credit hold AR placed after the ticket was drafted. This is
      // the path the wizard actually creates through (it writes Dexie, then
      // pushes), so POST /api/tickets alone wouldn't hold the line. Staying
      // queued rather than dropping is deliberate: when AR clears the hold, the
      // ticket syncs through on the next push instead of being lost.
      if (company.creditHold) {
        throw new Error(CREDIT_HOLD_MESSAGE);
      }

      // Generate a ticket number on the server
      const { generateTicketNumber } = await import('../utils/ticketNumber.js');
      const ticketNumber = await generateTicketNumber(payload.ticketType || 'field_service', payload.serviceSubtype);

      // Strip optional FK fields that might be null/empty to avoid constraint
      // errors. companyId is intentionally NOT in this list — it's required and
      // validated above.
      const cleanPayload = { ...payload };
      for (const fk of ['fieldId', 'padId', 'wellId', 'facilityId', 'workPointId', 'assignedTechId', 'billingProfileId']) {
        if (!cleanPayload[fk]) delete cleanPayload[fk];
      }

      // Assign to the pusher when the payload didn't name a tech — same rule as
      // POST /api/tickets. Without it a wizard-created ticket lands with a NULL
      // assignment, which drops it out of the field tech's "My Jobs" filter and
      // then off their device entirely (the delta-sync prune list is scoped by
      // assignedTechId for field_tech, so an unassigned ticket reads as deleted).
      if (!cleanPayload.assignedTechId) cleanPayload.assignedTechId = userId;

      // Extract structured gas/cylinder data from notes
      const enrichedCustomData = enrichCustomData(
        cleanPayload.workDescription,
        cleanPayload.customData,
      );
      if (enrichedCustomData) cleanPayload.customData = enrichedCustomData;

      // #3 Derive flat po/afe/cost from billingRefs when present (server wins).
      const flatRefs = flatOverridesFromPayload(cleanPayload);
      if (flatRefs.poNumber !== undefined) cleanPayload.poNumber = flatRefs.poNumber;
      if (flatRefs.afeNumber !== undefined) cleanPayload.afeNumber = flatRefs.afeNumber;
      if (flatRefs.costCenter !== undefined) cleanPayload.costCenter = flatRefs.costCenter;

      // QB Class. The wizard only asks for a division on the field-service
      // step, so IH / occ health / training / air-fill tickets arrive without
      // one — derive it from the work type (shop = D6, rental = D4, IH = D3)
      // rather than letting the QB invoice push with a blank CLASS.
      if (!cleanPayload.division) {
        cleanPayload.division = defaultDivisionForWork({
          ticketType: cleanPayload.ticketType || 'field_service',
          serviceSubtype: cleanPayload.serviceSubtype,
        }) ?? undefined;
      }

      // The wizard's sync payload used to carry no locationDisplay at all (only
      // its local Dexie copy had one), so every wizard-created ticket landed
      // with a null breadcrumb — which is what the invoice PDF, the RingCentral
      // post and the QB LOCATION field all read from. Rebuild it server-side
      // from the location FKs, in the same "Company > Field > Pad > Well" shape
      // POST /api/tickets produces, so the format doesn't depend on which path
      // the ticket came in through. Tickets with no location FKs at all (in-shop
      // air fills, whose label is the truck + driver) keep the client's string.
      if (cleanPayload.fieldId || cleanPayload.padId || cleanPayload.wellId) {
        cleanPayload.locationDisplay = await buildLocationDisplay({
          companyId: cleanPayload.companyId,
          fieldId: cleanPayload.fieldId,
          padId: cleanPayload.padId,
          wellId: cleanPayload.wellId,
        }) ?? cleanPayload.locationDisplay;
      }

      // Compute billing group key for stacked field-service billing
      const resolvedServiceDate = payload.serviceDate ? new Date(payload.serviceDate) : new Date();

      // #4 Auto-select the billing profile by job type when none was attached
      // (the FK-strip above removes a falsy billingProfileId).
      if (!cleanPayload.billingProfileId && cleanPayload.companyId) {
        const profiles = await prisma.customerBillingProfile.findMany({
          where: { companyId: cleanPayload.companyId, isActive: true },
          select: { id: true, isActive: true, effectiveFrom: true, effectiveTo: true, appliesToTicketTypes: true, appliesToDivisions: true },
        });
        const picked = selectBillingProfile(profiles, {
          ticketType: cleanPayload.ticketType || 'field_service',
          division: cleanPayload.division ?? null,
          serviceDate: resolvedServiceDate,
        });
        if (picked) cleanPayload.billingProfileId = picked.id;
      }
      const billingGroupKey = computeBillingGroupKey({
        ticketType: cleanPayload.ticketType,
        companyId: cleanPayload.companyId,
        fieldId: cleanPayload.fieldId,
        serviceDate: resolvedServiceDate,
      });

      const { ticket, created } = await createSyncTicket(prisma, {
          ...cleanPayload,
          offlineId: offlineId || undefined,
          ticketNumber,
          billingGroupKey: billingGroupKey || undefined,
          serviceDate: resolvedServiceDate,
          arrivalTime: payload.arrivalTime ? new Date(payload.arrivalTime) : undefined,
          departureTime: payload.departureTime ? new Date(payload.departureTime) : undefined,
          createdById: userId,
          status: payload.status || 'draft',
      });

      if (!created) {
        if (['rental_deploy', 'rental_return', 'rental_swap'].includes((ticket.customData as any)?.workType)) await maybeWriteRentalDailyLogFromTicket(ticket);
        return { id: ticket.id };
      }

      // Phase B Cascade Air > New Install: mint a WorkPoint at this location
      // so future inspections / cal visits can find this system in the picker.
      // Idempotent: only fires when customData.newInstall is present and the
      // ticket isn't already linked to a work point.
      try {
        await maybeCreateWorkPointFromTicket(ticket);
      } catch (err) {
        console.error(
          `[sync/push] new-install workpoint create failed for ticket ${ticket.ticketNumber}:`,
          err instanceof Error ? err.message : err,
        );
        // Non-fatal — ticket still landed; ops can mint the workpoint manually.
      }

      // Equipment visits must leave their job log even when a sync retry is needed.
      if (['rental_deploy', 'rental_return', 'rental_swap'].includes((ticket.customData as any)?.workType)) await maybeWriteRentalDailyLogFromTicket(ticket);

      // Phase B On-Site Services > Manned Trailer: mirror the shift into the
      // linked rental's daily log when one is set. Non-fatal.
      try {
        await maybeWriteRentalDailyLogFromTicket(ticket);
      } catch (err) {
        console.error(
          `[sync/push] manned-trailer rental log mirror failed for ticket ${ticket.ticketNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }

      // #1 PIC roster: write the ticket's foreperson roster through to the
      // linked rental agreement. Non-fatal.
      try {
        await maybeWritePicsToRentalFromTicket(ticket);
      } catch (err) {
        console.error(
          `[sync/push] PIC roster write-through failed for ticket ${ticket.ticketNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }

      return { id: ticket.id };
    }
    case 'update': {
      if (payload.customData !== undefined || payload.workDescription !== undefined) {
        const existing = await prisma.serviceTicket.findUnique({
          where: { id: mut.entityId },
          select: { customData: true },
        });
        if (payload.customData !== undefined) {
          payload.customData = preserveTicketOrigin(payload.customData, existing?.customData);
        }
        // Re-extract gas/cylinder data when notes change.
        if (payload.workDescription !== undefined) {
          const enriched = enrichCustomData(
            payload.workDescription,
            payload.customData ?? (existing?.customData as Record<string, any> | null),
          );
          if (enriched) payload.customData = enriched;
        }
      }

      // #3 Keep flat po/afe/cost in sync when billingRefs is updated (server wins).
      const flatRefsU = flatOverridesFromPayload(payload);
      if (flatRefsU.poNumber !== undefined) payload.poNumber = flatRefsU.poNumber;
      if (flatRefsU.afeNumber !== undefined) payload.afeNumber = flatRefsU.afeNumber;
      if (flatRefsU.costCenter !== undefined) payload.costCenter = flatRefsU.costCenter;

      // Rebuild the location breadcrumb when the location itself moved, so it
      // can't go stale against the new pad/well (same rule as PATCH /tickets).
      if (payload.padId !== undefined || payload.wellId !== undefined || payload.fieldId !== undefined) {
        const current = await prisma.serviceTicket.findUnique({
          where: { id: mut.entityId },
          select: { companyId: true, fieldId: true, padId: true, wellId: true },
        });
        const nextFieldId = payload.fieldId !== undefined ? payload.fieldId : current?.fieldId;
        const nextPadId = payload.padId !== undefined ? payload.padId : current?.padId;
        const nextWellId = payload.wellId !== undefined ? payload.wellId : current?.wellId;
        // Only when there's still a location to describe — otherwise leave the
        // existing label alone rather than replacing it with the company name.
        if (current && (nextFieldId || nextPadId || nextWellId)) {
          payload.locationDisplay = await buildLocationDisplay({
            companyId: current.companyId,
            fieldId: nextFieldId,
            padId: nextPadId,
            wellId: nextWellId,
          }) ?? null;
        }
      }

      const ticket = await prisma.serviceTicket.update({
        where: { id: mut.entityId, status: mut.expectedStatus, updatedAt: mut.expectedUpdatedAt },
        data: {
          ...payload,
          serviceDate: payload.serviceDate ? new Date(payload.serviceDate) : undefined,
          arrivalTime: payload.arrivalTime ? new Date(payload.arrivalTime) : undefined,
          departureTime: payload.departureTime ? new Date(payload.departureTime) : undefined,
        },
      });

      // Same new-install hook as the create path — covers the case where a
      // ticket was first saved as a draft and then submitted with the install
      // payload populated.
      try {
        await maybeCreateWorkPointFromTicket(ticket);
      } catch (err) {
        console.error(
          `[sync/push] new-install workpoint create failed for ticket ${ticket.ticketNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }

      // Same manned-trailer rental-log mirror as the create path.
      try {
        await maybeWriteRentalDailyLogFromTicket(ticket);
      } catch (err) {
        console.error(
          `[sync/push] manned-trailer rental log mirror failed for ticket ${ticket.ticketNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }

      // Same PIC roster write-through as the create path (covers draft → submit).
      try {
        await maybeWritePicsToRentalFromTicket(ticket);
      } catch (err) {
        console.error(
          `[sync/push] PIC roster write-through failed for ticket ${ticket.ticketNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }

      return { id: ticket.id };
    }
    case 'delete': {
      // Clean children first so the delete can't FK-fail (a discarded draft may
      // carry line items / records). Mirrors POST /tickets/:id/discard-draft.
      const ticketId = mut.entityId;
      await prisma.$transaction(async (tx) => {
        const lineItemIds = (await tx.ticketLineItem.findMany({
          where: { ticketId },
          select: { id: true },
        })).map(li => li.id);
        if (lineItemIds.length > 0) {
          await tx.ticketAssemblyPartsUsed.deleteMany({
            where: { ticketLineItemId: { in: lineItemIds } },
          });
        }
        await tx.fitTestRecord.deleteMany({ where: { ticketId } });
        await tx.ihTestRecord.deleteMany({ where: { ticketId } });
        await tx.trainingRosterRecord.deleteMany({ where: { ticketId } });
        await tx.airSystemInspection.deleteMany({ where: { ticketId } });
        await tx.ticketAttachment.deleteMany({ where: { ticketId } });
        await tx.ticketLineItem.deleteMany({ where: { ticketId } });
        await tx.invoiceLineItem.updateMany({
          where: { sourceTicketId: ticketId },
          data: { sourceTicketId: null, sourceTicketNumber: null },
        });
        await tx.serviceTicket.delete({ where: { id: ticketId, status: 'draft' } });
      });
      return { id: mut.entityId };
    }
  }
}

async function processAttachmentMutation(mut: MutationRequest): Promise<{ id: string }> {
  const { _offlineStatus, dataUrl, offlineBlobId, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency: if entity with this ID already exists, return it
      const existing = await prisma.ticketAttachment.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      // If the offline client captured the binary as a data URL, decode it
      // and save to file storage so the binary actually lives somewhere.
      // The data URL strip happens in the destructure above; everything else
      // on the payload (ticketId, fileName, fileType, mimeType, etc.) goes
      // straight into the DB record.
      let filePath: string | undefined = payload.filePath;
      let fileSizeBytes: number | undefined = payload.fileSizeBytes;
      let mimeType: string | undefined = payload.mimeType;

      if (dataUrl && !filePath) {
        const match = typeof dataUrl === 'string'
          ? dataUrl.match(/^data:([^;]+);base64,(.+)$/)
          : null;
        if (match) {
          const [, dataMime, b64] = match;
          mimeType = mimeType || dataMime;
          const buffer = Buffer.from(b64, 'base64');
          fileSizeBytes = buffer.length;

          const ext = (mimeType?.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase();
          const fileName = (payload.fileName as string) || `${mut.entityId}.${ext}`;
          const ticketId = payload.ticketId as string;
          if (ticketId) {
            // User-selected reports often share a name (for example results.pdf).
            // Keep their display names, but give each capture its own stored bytes.
            const key = attachmentKey({ ticketId }, mut.entityId, fileName);
            const store = getFileStore();
            await store.write(key, buffer, mimeType);
            filePath = key;
          }
        }
      }

      const attachment = await prisma.ticketAttachment.create({
        data: {
          ...payload,
          id: mut.entityId,
          ...(filePath !== undefined ? { filePath } : {}),
          ...(fileSizeBytes !== undefined ? { fileSizeBytes } : {}),
          ...(mimeType !== undefined ? { mimeType } : {}),
        },
      });
      return { id: attachment.id };
    }
    case 'delete': {
      await prisma.ticketAttachment.delete({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported attachment action: ${mut.action}`);
  }
}

// Offline attachment sync -> the unified `attachments` table.
//
// This replaces two near-identical handlers (one per old attachment table) with
// one, which is the whole point of the unified model. It is also hop 1 of the
// custody pipeline: when this returns ok, the SP server holds a durable copy
// and the device is free to delete its own. If it throws, the device keeps the
// file and the mutation retries -- so nothing here may swallow an error.
async function processUnifiedAttachmentMutation(
  mut: MutationRequest,
  userId: string,
): Promise<{ id: string }> {
  const { _offlineStatus, dataUrl, sha256: clientSha, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotent: a retried queue entry (device never saw our ack) must not
      // produce a second copy of the same photo.
      const existing = await prisma.attachment.findUnique({
        where: { id: mut.entityId },
        select: { id: true },
      });
      if (existing) return { id: existing.id };

      const match = typeof dataUrl === 'string'
        ? dataUrl.match(/^data:([^;]+);base64,(.+)$/)
        : null;
      if (!match) {
        throw new Error('Attachment mutation carried no decodable dataUrl');
      }
      const [, dataMime, b64] = match;
      const mimeType = (payload.mimeType as string) || dataMime;
      const buffer = Buffer.from(b64, 'base64');

      const parent = {
        shopItemId: (payload.shopItemId as string) || null,
        inspectionId: (payload.inspectionId as string) || null,
        ticketId: (payload.ticketId as string) || null,
      };
      if ([parent.shopItemId, parent.inspectionId, parent.ticketId].filter(Boolean).length !== 1) {
        throw new Error('Attachment mutation needs exactly one parent id');
      }

      const jobUnits = payload.workOrderId
        ? await jobAttachmentUnits(payload.workOrderId, (payload.kind as AttachmentKind) || 'photo', payload.linkedShopItemIds)
        : null;
      if (jobUnits) {
        parent.shopItemId = jobUnits[0].id;
        parent.inspectionId = null;
        parent.ticketId = null;
      }

      const fileName = basename((payload.fileName as string) || `${mut.entityId}.bin`);
      const key = attachmentKey(parent, mut.entityId, fileName);

      // Verifies the device's checksum, if it sent one, while the device still
      // holds the original. A mismatch is re-thrown with the queue entry's id
      // attached: the sync engine records it on the mutation, and the tech sees
      // which capture is stuck instead of a bare "sync error".
      let stored;
      try {
        stored = await ingestAttachmentBytes(buffer, key, mimeType, clientSha ?? null);
      } catch (err) {
        if (err instanceof ChecksumMismatchError) {
          throw new Error(`${err.message} (attachment ${fileName})`);
        }
        throw err;
      }

      const attachmentData = {
        id: mut.entityId,
        ...parent,
        serialNumber: payload.kind === 'vendor_invoice' || payload.kind === 'packing_slip'
          ? null : (payload.serialNumber as string) || null,
        serializedEquipmentId: payload.kind === 'vendor_invoice' || payload.kind === 'packing_slip'
          ? null : (payload.serializedEquipmentId as string) || null,
        kind: (payload.kind as AttachmentKind) || 'photo',
        fileName,
        mimeType,
        offlineBlobId: (payload.offlineBlobId as string) || null,
        capturedAt: payload.capturedAt ? new Date(payload.capturedAt as string) : new Date(),
        uploadedById: userId,
        sha256: stored.sha256,
        fileSizeBytes: stored.fileSizeBytes,
        storageState: stored.storageState,
        bufferKey: stored.bufferKey,
        remoteKey: stored.remoteKey,
        uploadedAt: stored.uploadedAt,
      };
      const attachment = jobUnits
        ? await createJobAttachments(attachmentData, jobUnits)
        : await prisma.attachment.create({ data: attachmentData });
      // Same background VaultPRO push as the online route.
      if (!jobUnits) void enqueueAttachment(attachment.id).catch((e) =>
        console.warn('[attachments] VaultPRO enqueue failed (non-fatal):', e),
      );

      return { id: attachment.id };
    }
    case 'delete': {
      await deleteStoredAttachment(mut.entityId, payload.wholeJob === true);
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported attachment action: ${mut.action}`);
  }
}

async function processFitTestMutation(mut: MutationRequest, userId: string): Promise<{ id: string }> {
  const {
    _offlineStatus,
    // Map client field names to Prisma columns
    disclosureConditions,
    adverseReactions,
    isCleanShaven,
    wearsGlassesContacts,
    criteriaAcknowledged,
    participantSignature,
    meqAccepted,
    meqDate,
    jobTitle,
    ...payload
  } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency: if entity with this ID already exists, return it
      const existing = await prisma.fitTestRecord.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      const record = await prisma.fitTestRecord.create({
        data: {
          ...payload,
          id: mut.entityId,
          testDate: payload.testDate ? new Date(payload.testDate) : new Date(),
          expiryDate: payload.expiryDate ? new Date(payload.expiryDate) : undefined,
          testedById: userId,
          meqAccepted: meqAccepted ?? false,
          meqDate: meqDate ? new Date(meqDate) : undefined,
          jobTitle: jobTitle || undefined,
          // Disclosure fields
          disclosureConditions: disclosureConditions ?? [],
          isCleanShaven: isCleanShaven ?? undefined,
          wearsGlassesContacts: wearsGlassesContacts ?? undefined,
          adverseReactions: adverseReactions ?? [],
          criteriaAcknowledged: criteriaAcknowledged ?? false,
          participantSignature: participantSignature || undefined,
        },
      });
      return { id: record.id };
    }
    case 'update': {
      const record = await prisma.fitTestRecord.update({
        where: { id: mut.entityId },
        data: {
          ...payload,
          testDate: payload.testDate ? new Date(payload.testDate as string) : undefined,
          meqAccepted: meqAccepted ?? undefined,
          meqDate: meqDate ? new Date(meqDate) : undefined,
          jobTitle: jobTitle || undefined,
          disclosureConditions: disclosureConditions ?? undefined,
          isCleanShaven: isCleanShaven ?? undefined,
          wearsGlassesContacts: wearsGlassesContacts ?? undefined,
          adverseReactions: adverseReactions ?? undefined,
          criteriaAcknowledged: criteriaAcknowledged ?? undefined,
          participantSignature: participantSignature || undefined,
        },
      });
      return { id: record.id };
    }
    case 'delete': {
      await prisma.fitTestRecord.delete({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported fitTestRecord action: ${mut.action}`);
  }
}

async function processAirSystemMutation(mut: MutationRequest, userId: string, role: string): Promise<{ id: string }> {
  const { _offlineStatus, serviceActions, cylinders, verificationUpdate, dateVerified, ...payload } = mut.payload as any;
  const action = verificationUpdate === undefined ? null : parseVerificationUpdate(verificationUpdate);
  if (action && !payload.workPointId) throw new AppError(400, 'Verification requires a linked work point');
  if (payload.verified !== undefined && typeof payload.verified !== 'boolean') throw new AppError(400, 'Verified must be a checkbox value');
  const snapshotDate = dateVerified ? new Date(dateVerified) : null;
  if (snapshotDate && !Number.isFinite(snapshotDate.getTime())) throw new AppError(400, 'Invalid verification date');

  return prisma.$transaction(async tx => {
    if (mut.action === 'delete') {
      await tx.airSystemInspection.delete({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    if (!['create', 'update'].includes(mut.action)) throw new Error('Unsupported air system action');
    if (mut.action === 'create') {
      const existing = await tx.airSystemInspection.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };
    }
    if (action) {
      const existing = mut.action === 'update' ? await tx.airSystemInspection.findUnique({ where: { id: mut.entityId } }) : null;
      const ticket = await tx.serviceTicket.findUnique({ where: { id: existing?.ticketId || payload.ticketId } });
      if (!ticket || ticket.status === 'void') throw new AppError(400, 'Verification requires an active ticket');
      if (action.verified && !roleHasCapability(role, 'tickets:complete')) throw new AppError(403, 'Insufficient verification permissions');
      if (ticket.assignedTechId !== userId && ticket.createdById !== userId && !roleHasCapability(role, 'tickets:edit_all')) throw new AppError(403, 'You can only verify work points on your tickets');
    }
    const data = {
      ...payload,
      dateVerified: action ? action.dateVerified : snapshotDate,
      verified: action ? action.verified : payload.verified,
      serviceActions: serviceActions ?? (mut.action === 'create' ? [] : undefined),
      cylinders: cylinders ?? (mut.action === 'create' ? [] : undefined),
      cascadeArrivalPsi: payload.cascadeArrivalPsi != null ? Number(payload.cascadeArrivalPsi) : undefined,
      cascadeDeparturePsi: payload.cascadeDeparturePsi != null ? Number(payload.cascadeDeparturePsi) : undefined,
      inspectedAt: payload.inspectedAt ? new Date(payload.inspectedAt) : (mut.action === 'create' ? new Date() : undefined),
    };
    const record = mut.action === 'create'
      ? await tx.airSystemInspection.create({ data: { ...data, id: mut.entityId, inspectedById: userId } })
      : await tx.airSystemInspection.update({ where: { id: mut.entityId }, data });
    if (action) await applyWorkPointVerification(tx, record.workPointId!, verificationUpdate, userId, data);
    return { id: record.id };
  });
}

async function processIhTestMutation(mut: MutationRequest, userId: string): Promise<{ id: string }> {
  const { _offlineStatus, testData, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency: if entity with this ID already exists, return it
      const existing = await prisma.ihTestRecord.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      const record = await prisma.ihTestRecord.create({
        data: {
          ...payload,
          id: mut.entityId,
          testData: testData ?? {},
          testedAt: payload.testedAt ? new Date(payload.testedAt) : new Date(),
          testedById: userId,
        },
      });
      return { id: record.id };
    }
    case 'update': {
      const record = await prisma.ihTestRecord.update({
        where: { id: mut.entityId },
        data: {
          ...payload,
          testData: testData ?? undefined,
          testedAt: payload.testedAt ? new Date(payload.testedAt as string) : undefined,
        },
      });
      return { id: record.id };
    }
    case 'delete': {
      await prisma.ihTestRecord.delete({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported ihTestRecord action: ${mut.action}`);
  }
}

async function processGasDetectionMutation(mut: MutationRequest, _userId: string): Promise<{ id: string }> {
  const { _offlineStatus, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      const existing = await prisma.gasDetectionRecord.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      const record = await prisma.gasDetectionRecord.create({
        data: {
          ...payload,
          id: mut.entityId,
        },
      });
      return { id: record.id };
    }
    case 'update': {
      const record = await prisma.gasDetectionRecord.update({
        where: { id: mut.entityId },
        data: payload,
      });
      return { id: record.id };
    }
    case 'delete': {
      await prisma.gasDetectionRecord.delete({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported gasDetectionRecord action: ${mut.action}`);
  }
}

async function processTrainingRosterMutation(mut: MutationRequest, userId: string): Promise<{ id: string }> {
  const { _offlineStatus, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency: if entity with this ID already exists, return it
      const existing = await prisma.trainingRosterRecord.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      const record = await prisma.trainingRosterRecord.create({
        data: {
          ...payload,
          id: mut.entityId,
          trainedAt: payload.trainedAt ? new Date(payload.trainedAt) : new Date(),
          cardExpiryDate: payload.cardExpiryDate ? new Date(payload.cardExpiryDate) : undefined,
        },
      });
      return { id: record.id };
    }
    case 'update': {
      const record = await prisma.trainingRosterRecord.update({
        where: { id: mut.entityId },
        data: {
          ...payload,
          trainedAt: payload.trainedAt ? new Date(payload.trainedAt as string) : undefined,
          cardExpiryDate: payload.cardExpiryDate ? new Date(payload.cardExpiryDate as string) : undefined,
        },
      });
      return { id: record.id };
    }
    case 'delete': {
      await prisma.trainingRosterRecord.deleteMany({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported trainingRosterRecord action: ${mut.action}`);
  }
}

async function processRentalAgreementMutation(mut: MutationRequest, userId: string): Promise<{ id: string }> {
  if (mut.action === 'update' && mut.payload.equipmentVisit) {
    await saveManualRentalVisit(mut.entityId, mut.payload.equipmentVisit, userId);
    return { id: mut.entityId };
  }
  const { _offlineStatus, offlineId, companyName, createdAt, updatedAt, ...raw } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency: check if already exists
      const existing = await prisma.rentalAgreement.findFirst({
        where: { id: mut.entityId },
        select: { id: true },
      });
      if (existing) return { id: existing.id };

      // Validate company exists
      if (!raw.companyId) {
        throw new Error(`Rental agreement create: companyId is missing`);
      }
      const company = await prisma.company.findUnique({ where: { id: raw.companyId }, select: { id: true, isActive: true, creditHold: true, name: true } });
      if (!company) {
        throw new Error(`Rental agreement create: company ${raw.companyId} not found — client may need to re-sync`);
      }
      // Block new work for a customer deactivated after this rental was drafted
      // offline. Only this mutation fails; the rest of the batch still syncs.
      if (!company.isActive) {
        throw new Error(`${company.name} is inactive — reactivate the customer to create new work.`);
      }
      // Same for a credit hold placed after the rental was drafted offline.
      if (company.creditHold) {
        throw new Error(CREDIT_HOLD_MESSAGE);
      }

      const { generateRentalAgreementNumber } = await import('../utils/ticketNumber.js');
      const agreementNumber = await generateRentalAgreementNumber();

      // Explicitly pick known fields (don't blindly spread client payload)
      const agreement = await prisma.rentalAgreement.create({
        data: {
          id: mut.entityId,
          agreementNumber,
          companyId: raw.companyId,
          fieldId: raw.fieldId || undefined,
          padId: raw.padId || undefined,
          // Multi-well selection; wellId stays the primary (first) well.
          wellIds: Array.isArray(raw.wellIds) ? raw.wellIds.filter((v: unknown) => typeof v === 'string' && v) : [],
          wellId: raw.wellId || (Array.isArray(raw.wellIds) && raw.wellIds.length ? raw.wellIds[0] : undefined),
          facilityId: raw.facilityId || undefined,
          status: raw.status || 'active',
          startDate: raw.startDate ? new Date(raw.startDate) : new Date(),
          endDate: raw.endDate ? new Date(raw.endDate) : undefined,
          billingRateType: raw.billingRateType || 'daily',
          pickupType: raw.pickupType === 'walk_in' ? 'walk_in' : 'dispatch',
          poNumber: raw.poNumber || undefined,
          afeNumber: raw.afeNumber || undefined,
          notes: raw.notes || undefined,
          liabilityAcknowledged: raw.liabilityAcknowledged ?? false,
          liabilitySignedByName: raw.liabilitySignedByName || undefined,
          liabilitySignature: raw.liabilitySignature || undefined,
          liabilitySignedAt: raw.liabilitySignedAt ? new Date(raw.liabilitySignedAt) : undefined,
          // #C composition + derived booleans (fall back to client booleans).
          composition: raw.composition ?? undefined,
          ...(deriveRentalFlags(raw.composition) ?? {
            isManned: raw.isManned ?? true,
            isRigJob: raw.isRigJob ?? false,
            monitorsIncluded: raw.monitorsIncluded ?? false,
          }),
          pics: raw.pics ?? undefined,
          siteContactName: raw.siteContactName || undefined,
          siteContactPhone: raw.siteContactPhone || undefined,
          siteContactEmail: raw.siteContactEmail || undefined,
          personCallingName: raw.personCallingName || undefined,
          personCallingPhone: raw.personCallingPhone || undefined,
          personCallingEmail: raw.personCallingEmail || undefined,
        },
      });
      return { id: agreement.id };
    }
    case 'update': {
      return withRental(mut.entityId, async (tx, existing) => {
      // Offline close payloads send the pickup/end date, not the unchanged start.
      // Validate against the saved rental while holding its lifecycle lock.
      validateRentalInput({ startDate: existing.startDate, ...raw });
      if (raw.composition && raw.manualEquipment === undefined && (existing.composition as any)?.manualEquipment) {
        raw.composition = { ...raw.composition, manualEquipment: (existing.composition as any).manualEquipment };
      }
      if (raw.manualEquipment !== undefined) {
        if (!['scheduled', 'active'].includes(existing.status)) throw new Error('Agreement is not active or scheduled');
        raw.composition = mergeManualRentalEquipment({ ...(raw.composition || existing.composition as any || {}), manualEquipment: (existing.composition as any)?.manualEquipment || [] }, raw.manualEquipment);
        if (raw.status === 'active' && existing.status === 'scheduled') await tx.rentalAgreement.update({ where: { id: existing.id }, data: { status: 'active' } });
      }
      if (raw.status && raw.status !== existing.status && !(raw.manualEquipment && raw.status === 'active' && existing.status === 'scheduled')) {
        if (raw.status === 'completed' || raw.status === 'cancelled') await closeRental(tx, existing, raw.status, raw.notes, raw.endDate);
        else throw new Error('Use online reopen or deploy to change rental status');
      }
      const agreement = await tx.rentalAgreement.update({
        where: { id: mut.entityId },
        data: {
          companyId: raw.companyId || undefined,
          fieldId: raw.fieldId,
          padId: raw.padId,
          wellId: raw.wellId,
          wellIds: raw.wellIds !== undefined
            ? (Array.isArray(raw.wellIds) ? raw.wellIds.filter((v: unknown) => typeof v === 'string' && v) : [])
            : undefined,
          facilityId: raw.facilityId,

          startDate: raw.startDate ? new Date(raw.startDate) : undefined,
          endDate: raw.status === 'completed' || raw.status === 'cancelled' ? undefined : raw.endDate ? new Date(raw.endDate) : undefined,
          billingRateType: raw.billingRateType || undefined,
          pickupType: raw.pickupType,
          poNumber: raw.poNumber,
          afeNumber: raw.afeNumber,
          notes: raw.notes,
          // #C composition + derived booleans when composition is present.
          composition: raw.composition,
          ...(deriveRentalFlags(raw.composition) ?? {
            isManned: raw.isManned,
            isRigJob: raw.isRigJob,
            monitorsIncluded: raw.monitorsIncluded,
          }),
          liabilityAcknowledged: raw.liabilityAcknowledged,
          liabilitySignedByName: raw.liabilitySignedByName,
          liabilitySignature: raw.liabilitySignature,
          liabilitySignedAt: raw.liabilitySignedAt ? new Date(raw.liabilitySignedAt) : undefined,
          pics: raw.pics,
          siteContactName: raw.siteContactName,
          siteContactPhone: raw.siteContactPhone,
          siteContactEmail: raw.siteContactEmail,
          personCallingName: raw.personCallingName,
          personCallingPhone: raw.personCallingPhone,
          personCallingEmail: raw.personCallingEmail,
        },
      });
      return { id: agreement.id };
      });
    }
    case 'delete': {
      await prisma.rentalAgreement.delete({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported rentalAgreement action: ${mut.action}`);
  }
}

async function processRentalAgreementItemMutation(mut: MutationRequest, _userId: string): Promise<{ id: string }> {
  const raw = mut.payload as any;
  const existing = mut.action === 'create' ? null : await prisma.rentalAgreementItem.findUnique({ where: { id: mut.entityId } });
  const rentalId = existing?.rentalAgreementId || raw.rentalAgreementId;
  if (!rentalId) throw new Error('Rental item parent is missing');
  if (existing && raw.rentalAgreementId && raw.rentalAgreementId !== existing.rentalAgreementId) throw new Error('Rental item belongs to a different agreement');
  return withRental(rentalId, async (tx, rental) => {
    if (mut.action === 'create') return deployRentalItem(tx, rental, { ...raw, id: mut.entityId });
    if (mut.action === 'update') {
      if (raw.status === 'returned') return returnRentalItem(tx, rental.id, mut.entityId, raw);
      const current = await tx.rentalAgreementItem.findUniqueOrThrow({ where: { id: mut.entityId } });
      if (raw.status && raw.status !== current.status || raw.returnedDate || raw.deployedDate && +new Date(raw.deployedDate) !== +current.deployedDate
        || raw.rate != null && Number(raw.rate) !== Number(current.rate) || raw.rateType && raw.rateType !== current.rateType) {
        throw new Error('Rental history correction requires an online correction; offline snapshots cannot change deployment history or rates');
      }
      return current;
    }
    throw new Error('Rental deployment history cannot be deleted; return the equipment instead');
  });
}

async function processRentalDailyLogMutation(mut: MutationRequest, userId: string): Promise<{ id: string }> {
  const { _offlineStatus, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency — check by id or offlineId
      const existing = await prisma.rentalDailyLog.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      if (mut.offlineId) {
        const byOffline = await prisma.rentalDailyLog.findFirst({
          where: { offlineId: mut.offlineId },
          select: { id: true },
        });
        if (byOffline) return { id: byOffline.id };
      }

      const log = await prisma.rentalDailyLog.create({
        data: {
          id: mut.entityId,
          rentalAgreementId: payload.rentalAgreementId,
          logDate: new Date(payload.logDate),
          loggedById: payload.loggedById || userId,
          equipmentPresent: payload.equipmentPresent ?? true,
          equipmentStatus: payload.equipmentStatus ?? 'operational',
          cascadeStatus: payload.cascadeStatus ?? null,
          bottlesFullCount: payload.bottlesFullCount ?? null,
          bottlesTotalCount: payload.bottlesTotalCount ?? null,
          monitorsBumpTested: payload.monitorsBumpTested ?? null,
          monitorsOperationalCount: payload.monitorsOperationalCount ?? null,
          monitorsTotalCount: payload.monitorsTotalCount ?? null,
          notes: payload.notes ?? null,
          entries: payload.entries ?? [],
          offlineId: mut.offlineId ?? payload.offlineId ?? null,
          offlineCreated: true,
        },
      });
      return { id: log.id };
    }
    case 'update': {
      const data: any = {};
      // Only update fields that are present in the payload
      if (payload.equipmentPresent !== undefined) data.equipmentPresent = payload.equipmentPresent;
      if (payload.equipmentStatus !== undefined) data.equipmentStatus = payload.equipmentStatus;
      if (payload.cascadeStatus !== undefined) data.cascadeStatus = payload.cascadeStatus;
      if (payload.bottlesFullCount !== undefined) data.bottlesFullCount = payload.bottlesFullCount;
      if (payload.bottlesTotalCount !== undefined) data.bottlesTotalCount = payload.bottlesTotalCount;
      if (payload.monitorsBumpTested !== undefined) data.monitorsBumpTested = payload.monitorsBumpTested;
      if (payload.monitorsOperationalCount !== undefined) data.monitorsOperationalCount = payload.monitorsOperationalCount;
      if (payload.monitorsTotalCount !== undefined) data.monitorsTotalCount = payload.monitorsTotalCount;
      if (payload.notes !== undefined) data.notes = payload.notes;
      if (payload.entries !== undefined) data.entries = payload.entries;

      const log = await prisma.rentalDailyLog.update({
        where: { id: mut.entityId },
        data,
      });
      return { id: log.id };
    }
    case 'delete': {
      await prisma.rentalDailyLog.delete({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported rentalDailyLog action: ${mut.action}`);
  }
}

/**
 * Fallback Site for offline-synced shop records. Devices that queued shop
 * work before the client started sending site context won't carry a site;
 * default them to the oldest active Site so the sync still lands.
 */
async function fallbackSiteId(): Promise<string> {
  const site = await prisma.site.findFirst({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!site) throw new Error('No active site configured for shop intake');
  return site.id;
}

async function processShopWorkOrderMutation(mut: MutationRequest, userId: string): Promise<MutationResult> {
  const { _offlineStatus, companyName, intakeByName, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency
      const existing = await prisma.shopWorkOrder.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      const { generateShopWorkOrderNumber } = await import('../utils/ticketNumber.js');
      const workOrderNumber = await generateShopWorkOrderNumber();

      // Use the shared helper so dropOffContact/pickupContact get flattened
      // and items get created — same code path as POST /api/shop-orders.
      // Pre-fix this path was spreading the nested payload directly into
      // prisma.shopWorkOrder.create, which Prisma rejected ("Unknown argument
      // dropOffContact").
      const result = await prisma.$transaction((tx) =>
        createShopWorkOrderWithItems(tx, {
          id: mut.entityId,
          workOrderNumber,
          userId,
          payload: mut.payload,
        }),
      );
      // A destination the device named but the server could not resolve is a
      // WARNING, not an error: the WO and its items are committed and must not
      // be replayed. Failing here would dead-letter the whole mutation over a
      // transit problem, and this create path is the ONLY one the field
      // wizard uses — online or off — so that would lose real work orders.
      if (result.transitWarning) {
        return { id: result.id, warnings: [result.transitWarning.message] };
      }
      return { id: result.id };
    }
    case 'update': {
      for (const key of ['status', 'paidAtDropVia', 'lightspeedTxnNumber', 'isInternal', 'companyId']) if (payload[key] !== undefined) throw new AppError(400, 'Use the work-order workflow endpoint to change ' + key);
      // WO customData contains server-owned void/waiver decisions. Offline
      // edits must never clear or forge them (item customData is separate).
      delete payload.customData;
      delete payload.billingWaiver;
      const wo = await prisma.shopWorkOrder.update({
        where: { id: mut.entityId },
        data: {
          ...payload,
          intakeDate: payload.intakeDate ? new Date(payload.intakeDate) : undefined,
          promisedDate: payload.promisedDate ? new Date(payload.promisedDate) : undefined,
          completedDate: payload.completedDate ? new Date(payload.completedDate) : undefined,
          returnedDate: payload.returnedDate ? new Date(payload.returnedDate) : undefined,
        },
      });
      return { id: wo.id };
    }
    case 'delete': {
      throw new AppError(409, 'Use the work-order void workflow instead of deleting through sync');
    }
    default:
      throw new Error(`Unsupported shopWorkOrder action: ${mut.action}`);
  }
}

async function processShopWorkOrderItemMutation(mut: MutationRequest, userId: string): Promise<{ id: string }> {
  const { _offlineStatus, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency
      const existing = await prisma.shopWorkOrderItem.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      const resolvedSiteId: string =
        payload.siteId
        ?? (payload.workOrderId
          ? (await prisma.shopWorkOrder.findUnique({
              where: { id: payload.workOrderId },
              select: { intakeSiteId: true },
            }))?.intakeSiteId
          : undefined)
        ?? (await fallbackSiteId());

      const item = await prisma.$transaction(async tx => {
        await validateShopIntakeItems(tx, [payload]);
        await assertShopBinsAvailable(tx, [payload], payload.workOrderId);
        const order = await tx.shopWorkOrder.findUnique({ where: { id: payload.workOrderId }, select: { status: true } });
        if (!order || order.status === 'closed') throw new AppError(409, 'Work order is missing or closed');
        return tx.shopWorkOrderItem.create({
        data: {
          ...payload,
          id: mut.entityId,
          siteId: resolvedSiteId,
          diagnosedAt: payload.diagnosedAt ? new Date(payload.diagnosedAt) : undefined,
          quoteSentAt: payload.quoteSentAt ? new Date(payload.quoteSentAt) : undefined,
          quoteApprovedAt: payload.quoteApprovedAt ? new Date(payload.quoteApprovedAt) : undefined,
          quoteDeclinedAt: payload.quoteDeclinedAt ? new Date(payload.quoteDeclinedAt) : undefined,
          workCompletedAt: payload.workCompletedAt ? new Date(payload.workCompletedAt) : undefined,
          sentOutDate: payload.sentOutDate ? new Date(payload.sentOutDate) : undefined,
          receivedBackDate: payload.receivedBackDate ? new Date(payload.receivedBackDate) : undefined,
          qcCompletedAt: payload.qcCompletedAt ? new Date(payload.qcCompletedAt) : undefined,
          returnedAt: payload.returnedAt ? new Date(payload.returnedAt) : undefined,
          estimatedCost: payload.estimatedCost != null ? payload.estimatedCost : undefined,
        },
      });

      // Create initial status log
      await prisma.shopItemStatusLog.create({
        data: {
          itemId: item.id,
          fromStatus: null,
          toStatus: item.status,
          changedById: userId,
          notes: 'Synced from device',
        },
      });

      });
      return { id: item.id };
    }
    case 'update': {
      // Offline status changes must capture the same vendor-return paperwork.
      if (payload.status) {
        const current = await prisma.shopWorkOrderItem.findUnique({
          where: { id: mut.entityId }, select: { status: true },
        });
        if (current && SENT_OUT_STATUSES.includes(current.status) && payload.status !== current.status) {
          if (payload.status !== 'received') throw new AppError(409, 'Receive the unit back from the vendor first.');
          const parsed = parseReceivePayload(payload);
          if (!parsed.ok) throw new AppError(400, parsed.error!);
          const documentError = await vendorReturnDocumentError(prisma, mut.entityId, parsed.payload!.disposition);
          if (documentError) throw new AppError(409, documentError);
          Object.assign(payload, receiveUpdateData(parsed.payload!));
        }
      }
      // Credit holds also apply to offline returns to the customer.
      if (payload.status === 'returned') {
        const owning = await prisma.shopWorkOrderItem.findUnique({
          where: { id: mut.entityId },
          select: { workOrderId: true },
        });
        if (owning) await assertShopReturnAllowed(owning.workOrderId);
      }
      // WI-04 evidence gate, same shape and for the same reason as the credit
      // hold above: an offline device can flip an item straight to 'condemned'
      // through this path without ever touching the item-status route or the
      // inspection lock. Throwing leaves the mutation queued, so the condemn
      // lands by itself once the photo syncs -- which, on a device that
      // captured both offline, is usually the very next mutation in the batch.
      if (payload.status === 'condemned') {
        const evidence = await checkCondemnEvidence(prisma, mut.entityId);
        if (!evidence.satisfied) throw new AppError(409, evidence.message!);
      }

      // QA GATE, offline presentation. The online routes throw 409 here; this
      // one must not. A rejected mutation is retried five times and then sits in
      // the queue forever -- the tech's work neither landed nor visibly lost --
      // and unlike the two gates above, an empty QA checklist does not resolve
      // itself while the device waits.
      //
      // So the mutation is ACCEPTED and every other field the tech recorded is
      // written; only the release is withheld. The unit is diverted into the
      // re-test lane instead of shop_complete, which keeps it out of
      // CLOSING_STATES -- so the soft-close trigger never stamps it, it never
      // becomes billable, and it never pushes to Vault. Same meaning as the
      // online 409, reached without ever failing a sync.
      let qaDivertNote: string | null = null;
      let qaDivertFrom: ShopItemStatus | null = null;
      if (['shop_complete', 'returned', 'condemned'].includes(payload.status)) {
        const current = await prisma.shopWorkOrderItem.findUnique({ where: { id: mut.entityId } });
        if (current) {
          try {
            await assertShopSerialsCollected(prisma, current.workOrderId, [current.id]);
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            qaDivertFrom = current.status;
            payload.status = current.status;
            delete payload.returnedAt;
            delete payload.returnMethod;
            qaDivertNote = `Offline closing withheld — ${error.message}`;
          }
        }
      }
      if (payload.status === 'shop_complete') {
        const current = await prisma.shopWorkOrderItem.findUnique({
          where: { id: mut.entityId },
          select: { id: true, status: true, equipmentCategory: true, parentItemId: true },
        });
        if (current) {
          const verdict = await evaluateItemQa(prisma, {
            id: current.id,
            equipmentCategory: current.equipmentCategory,
            parentItemId: current.parentItemId,
            // Deliberately NOT current.status: the terminal-disposition waiver in
            // the gate keys off where the unit IS, and it is not there yet.
            status: undefined,
          });
          if (!verdict.satisfied) {
            const divert = resolveQaDivert(current.status);
            qaDivertFrom = current.status as ShopItemStatus;
            payload.status = divert ?? current.status;
            qaDivertNote =
              `Offline "Ready for Pickup" withheld — ${verdict.reason} ` +
              (divert
                ? 'Unit moved to QC / re-test instead; finish the QA checklist to release it.'
                : 'Unit left where it was; finish the QA checklist to release it.');
            console.warn(
              `[sync/push] QA gate diverted shop item ${current.id}: ${current.status} → ${payload.status} (asked for shop_complete)`,
            );
          }
        }
      }

      const item = await prisma.$transaction(async tx => {
        if (payload.customData !== undefined || payload.equipmentCategory !== undefined) {
          const current = await tx.shopWorkOrderItem.findUnique({ where: { id: mut.entityId } });
          if (!current) throw new AppError(404, 'Shop item not found');
          await assertShopBinsAvailable(tx, [{
            equipmentCategory: payload.equipmentCategory ?? current.equipmentCategory,
            customData: payload.customData ?? current.customData,
          }], current.workOrderId);
        }
        return tx.shopWorkOrderItem.update({
        where: { id: mut.entityId },
        data: {
          ...payload,
          diagnosedAt: payload.diagnosedAt ? new Date(payload.diagnosedAt) : undefined,
          quoteSentAt: payload.quoteSentAt ? new Date(payload.quoteSentAt) : undefined,
          quoteApprovedAt: payload.quoteApprovedAt ? new Date(payload.quoteApprovedAt) : undefined,
          quoteDeclinedAt: payload.quoteDeclinedAt ? new Date(payload.quoteDeclinedAt) : undefined,
          workCompletedAt: payload.workCompletedAt ? new Date(payload.workCompletedAt) : undefined,
          sentOutDate: payload.sentOutDate ? new Date(payload.sentOutDate) : undefined,
          receivedBackDate: payload.receivedBackDate ? new Date(payload.receivedBackDate) : undefined,
          qcCompletedAt: payload.qcCompletedAt ? new Date(payload.qcCompletedAt) : undefined,
          returnedAt: payload.returnedAt ? new Date(payload.returnedAt) : undefined,
          estimatedCost: payload.estimatedCost != null ? payload.estimatedCost : undefined,
        },
      });
      });
      // The divert is recorded on the unit's own status log rather than logged
      // and forgotten. The board's unit history already renders this, so the
      // supervisor who finds the unit sitting in QC gets told why it is there
      // instead of assuming the tech mis-clicked.
      if (qaDivertNote) {
        await prisma.shopItemStatusLog.create({
          data: {
            itemId: item.id,
            fromStatus: qaDivertFrom,
            toStatus: item.status,
            changedById: userId,
            notes: qaDivertNote,
          },
        });
      }

      // Same BlueLion gap as the online item-status route: an offline tech can
      // fill the QA checklist and flip the item to shop_complete without ever
      // locking the inspection. Best-effort, never blocks the sync reply.
      if (payload.status === 'shop_complete') {
        await autoLockPassedInspections(prisma, item.id, userId).catch((e) =>
          console.warn(`[BlueLion] auto-lock failed for shop item ${item.id} (non-fatal):`, e),
        );
      }
      return { id: item.id };
    }
    case 'delete': {
      await prisma.shopWorkOrderItem.delete({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported shopWorkOrderItem action: ${mut.action}`);
  }
}

// Wave 1 — Equipment Inspection mutation processor.
// Append-only: update is rejected once lockedAt is set; corrections file as a
// new record with correctsId. Delete is allowed only on UNLOCKED records (so a
// tech can undo an offline-created mistake before it ships).
async function processEquipmentInspectionMutation(mut: MutationRequest, userId: string): Promise<{ id: string }> {
  const { _offlineStatus, inspectedByName, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency
      const existing = await prisma.equipmentInspection.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      const record = await prisma.equipmentInspection.create({
        data: {
          ...payload,
          id: mut.entityId,
          inspectedById: payload.inspectedById || userId,
          inspectedAt: payload.inspectedAt ? new Date(payload.inspectedAt) : new Date(),
          customerApprovedAt: payload.customerApprovedAt ? new Date(payload.customerApprovedAt) : undefined,
          lockedAt: payload.lockedAt ? new Date(payload.lockedAt) : undefined,
        },
      });
      // Created already-locked offline → run the same lifecycle flow-back AND the
      // inspection-as-spine routing the online /lock route performs (condemn →
      // condemned, pass → ready, FACTORY_RETURN → vendor, etc.).
      if (record.lockedAt) {
        await applyInspectionOutcome(prisma, record, userId);
        const routing = await routeShopItemFromInspection(prisma, record, userId);
        if (routing.routed && routing.workOrderId) await recomputeWOStatus(routing.workOrderId);
        await enqueueInspectionRecord(record.id).catch(() => {});
      }
      return { id: record.id };
    }
    case 'update': {
      const current = await prisma.equipmentInspection.findUnique({
        where: { id: mut.entityId },
        select: { lockedAt: true },
      });
      if (!current) throw new Error('Inspection not found');
      if (current.lockedAt) {
        throw new Error('Inspection is locked — corrections must be a new record (correctsId)');
      }
      const record = await prisma.equipmentInspection.update({
        where: { id: mut.entityId },
        data: {
          ...payload,
          inspectedAt: payload.inspectedAt ? new Date(payload.inspectedAt) : undefined,
          customerApprovedAt: payload.customerApprovedAt ? new Date(payload.customerApprovedAt) : undefined,
          lockedAt: payload.lockedAt ? new Date(payload.lockedAt) : undefined,
        },
      });
      // Offline lock replays as an update that sets lockedAt. On that null→set
      // transition, run the lifecycle flow-back AND inspection-as-spine routing
      // the online /lock route performs.
      if (!current.lockedAt && record.lockedAt) {
        await applyInspectionOutcome(prisma, record, userId);
        const routing = await routeShopItemFromInspection(prisma, record, userId);
        if (routing.routed && routing.workOrderId) await recomputeWOStatus(routing.workOrderId);
        await enqueueInspectionRecord(record.id).catch(() => {});
      }
      return { id: record.id };
    }
    case 'delete': {
      const current = await prisma.equipmentInspection.findUnique({
        where: { id: mut.entityId },
        select: { lockedAt: true },
      });
      if (current?.lockedAt) {
        throw new Error('Cannot delete a locked inspection — file a correcting record instead');
      }
      await prisma.equipmentInspection.delete({ where: { id: mut.entityId } });
      return { id: mut.entityId };
    }
    default:
      throw new Error(`Unsupported equipmentInspection action: ${mut.action}`);
  }
}

// Wave 2 — Shop transfer event mutation processor.
// Append-only by convention: only 'create' is supported. Corrections file as a
// new corrective transfer (e.g. transfer back the wrong way) rather than
// mutating history.
async function processShopTransferEventMutation(mut: MutationRequest, userId: string): Promise<{ id: string }> {
  const { _offlineStatus, transferredByName, ...payload } = mut.payload as any;

  switch (mut.action) {
    case 'create': {
      // Idempotency
      const existing = await prisma.shopTransferEvent.findUnique({ where: { id: mut.entityId }, select: { id: true } });
      if (existing) return { id: existing.id };

      const record = await prisma.shopTransferEvent.create({
        data: {
          ...payload,
          id: mut.entityId,
          transferredById: payload.transferredById || userId,
          transferredAt: payload.transferredAt ? new Date(payload.transferredAt) : new Date(),
        },
      });
      return { id: record.id };
    }
    case 'update':
    case 'delete':
      throw new Error('shopTransferEvent is append-only — file a corrective transfer instead');
    default:
      throw new Error(`Unsupported shopTransferEvent action: ${mut.action}`);
  }
}
