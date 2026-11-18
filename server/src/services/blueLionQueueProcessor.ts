/**
 * blueLionQueueProcessor.ts
 *
 * Background processor for the BlueLion cert push queue — training certs from
 * roster records AND Occ Health certs (FIT-TEST / AUDIO) from fit-test
 * records; all three entity types ride the same `trainings` endpoint. ONE
 * loop — unlike Enverus there's no async buyer-side lifecycle to poll;
 * BlueLion's trainings endpoint returns the per-record outcome synchronously
 * (202 + results array).
 *
 * Each tick batches up to BATCH_SIZE `pending`/`retrying` rows into a single
 * POST (BlueLion accepts `{ records: [...] }`). Per-record results are mapped
 * back by externalId:
 *
 *   added | skipped → synced   (store personId [+ trainingSeq] on the source row)
 *   ambiguous       → needs_attention (store candidates for human pick)
 *   invalid         → needs_attention (store the error)
 *
 * A whole-batch transport failure (5xx / network) marks the batched rows
 * retrying (up to MAX_RETRIES) then error. Idempotency on externalId makes the
 * retry safe.
 *
 * Skips entirely if BlueLion isn't configured (BLUELION_URL / BLUELION_TOKEN).
 */

import { prisma } from '../db.js';
import {
  pushTrainings,
  pushAssets,
  pushServices,
  uploadDocument,
  isConfigured,
  BlueLionApiError,
  type BlueLionTrainingRecord,
  type BlueLionTrainingResult,
  type BlueLionAssetRecord,
  type BlueLionAssetResult,
  type BlueLionServiceRecord,
  type BlueLionServiceResult,
  type BlueLionServicesResponse,
  type BlueLionDocumentResult,
} from './blueLionClient.js';
import { mapCategoryToAssetKind, humanizeSnake, splitName, toYmd } from './blueLionClassMap.js';
import { resolveClassCode } from './courseCatalog.js';
import { assetExternalId, ensureAssetRow } from './blueLionEnqueue.js';
import { generateEquipmentInspectionPdf } from './equipmentInspectionPdfGenerator.js';
import { pdfToBuffer } from '../utils/pdfToBuffer.js';
import { readAttachmentBytes } from './attachmentStore.js';
import { blueLionDocTypeForAttachmentKind } from './equipmentDocuments.js';
import { toBlueLionChecklist } from './blueLionChecklist.js';
import type { QaVaultSnapshot } from './shopBatchQa.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';
import { emitEvent } from './eventBus.js';

export const SUBMIT_INTERVAL_MS = parseInt(process.env.BLUELION_SUBMIT_INTERVAL_MS || '60000', 10);
const MAX_RETRIES = parseInt(process.env.BLUELION_MAX_RETRIES || '3', 10);
const BATCH_SIZE = parseInt(process.env.BLUELION_BATCH_SIZE || '25', 10);

let submitTimer: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

type QueueEntityType = 'training' | 'fit_test' | 'audiometric' | 'equipment_inspection' | 'asset';

type QueueRow = {
  id: string;
  entityType: QueueEntityType;
  entityId: string;
  externalId: string;
  retryCount: number;
};

/**
 * Reuse a BlueLion person id from any prior synced record for the same person —
 * either record type, since the same human shows up via training classes and
 * Occ Health visits (name is BlueLion's person key). Returns undefined for a
 * first-time person — BlueLion then creates one and returns the id to store.
 */
async function lookupPersonIdByName(employeeName: string): Promise<string | undefined> {
  const roster = await prisma.trainingRosterRecord.findFirst({
    where: { employeeName, blueLionPersonId: { not: null } },
    orderBy: { blueLionSyncedAt: 'desc' },
    select: { blueLionPersonId: true },
  });
  if (roster?.blueLionPersonId) return roster.blueLionPersonId;
  const fitTest = await prisma.fitTestRecord.findFirst({
    where: { employeeName, blueLionPersonId: { not: null } },
    orderBy: { blueLionSyncedAt: 'desc' },
    select: { blueLionPersonId: true },
  });
  return fitTest?.blueLionPersonId ?? undefined;
}

async function buildPerson(record: {
  employeeName: string;
  employerName: string | null;
  blueLionPersonId: string | null;
}): Promise<{ blueLionId: string } | { firstName: string; lastName: string; employer?: string }> {
  const blueLionId = record.blueLionPersonId ?? (await lookupPersonIdByName(record.employeeName));
  return blueLionId
    ? { blueLionId }
    : { ...splitName(record.employeeName), employer: record.employerName || undefined };
}

const RESPIRATOR_TYPE_LABELS: Record<string, string> = {
  half_face: 'half face',
  full_face: 'full face',
  scba: 'SCBA',
  sar: 'SAR',
};

/** Human-readable cert notes: which mask the person is fitted to + how tested. */
function fitTestNotes(r: {
  respiratorMake: string | null;
  respiratorModel: string | null;
  respiratorSize: string | null;
  respiratorType: string | null;
  respiratorClass: string | null;
  testType: string | null;
  testMethod: string | null;
  fitFactor: unknown;
  secondMask: unknown;
}): string | undefined {
  const mask = [r.respiratorMake, r.respiratorModel].filter(Boolean).join(' ');
  const parts: string[] = [];
  if (mask) parts.push(r.respiratorSize ? `${mask} (${r.respiratorSize})` : mask);
  const typeLabel = r.respiratorType ? RESPIRATOR_TYPE_LABELS[r.respiratorType] || r.respiratorType : null;
  if (typeLabel) parts.push(r.respiratorClass ? `${typeLabel} ${r.respiratorClass.toUpperCase()}` : typeLabel);
  if (r.testType) parts.push(r.testType === 'quantitative' ? 'QNFT' : 'QLFT');
  const ff = r.fitFactor == null ? NaN : Number(r.fitFactor);
  if (!isNaN(ff) && ff > 0) parts.push(`fit factor ${ff}`);
  const second = r.secondMask as { make?: string; model?: string; size?: string } | null;
  if (second && (second.make || second.model)) {
    const m2 = [second.make, second.model].filter(Boolean).join(' ');
    parts.push(`2nd mask: ${second.size ? `${m2} (${second.size})` : m2}`);
  }
  return parts.length ? parts.join(', ').slice(0, 500) : undefined;
}

async function buildTrainingRecord(entityId: string, externalId: string): Promise<BlueLionTrainingRecord | null> {
  const r = await prisma.trainingRosterRecord.findUnique({ where: { id: entityId } });
  if (!r) return null;
  const classCode = await resolveClassCode(r.courseName);
  if (!classCode) return null;

  return {
    externalId,
    person: await buildPerson(r),
    classCode,
    issuedOn: toYmd(r.trainedAt)!,
    expiresOn: toYmd(r.cardExpiryDate),
    certNumber: r.cardNumber || undefined,
    notes: r.notes || undefined,
  };
}

const TEST_METHOD_LABELS: Record<string, string> = {
  isoamyl_acetate: 'isoamyl acetate',
  bitrex: 'Bitrex',
  irritant_smoke: 'irritant smoke',
  portacount: 'TSI PortaCount',
  tsi_8030: 'TSI 8030',
  ambient_aerosol: 'ambient aerosol',
};

/**
 * The agreed fit-test card-attribute key set (docs/bluelion/SERVICEPRO-HANDOFF.md
 * §2): fit_factor, respirator_mfg, respirator_model, respirator_type, size,
 * method. Keys are only sent when we have a value — an omitted key renders the
 * card template's fallback (or the operator gap-fill form). student_no is
 * added by the caller (minted + persisted via ensureStudentNo).
 */
function fitTestAttributes(r: {
  fitFactor: unknown;
  respiratorMake: string | null;
  respiratorModel: string | null;
  respiratorSize: string | null;
  respiratorType: string | null;
  testType: string | null;
  testMethod: string | null;
}): Record<string, string | number> | undefined {
  const attrs: Record<string, string | number> = {};
  const ff = r.fitFactor == null ? NaN : Number(r.fitFactor);
  if (!isNaN(ff) && ff > 0) attrs.fit_factor = ff;
  if (r.respiratorMake) attrs.respirator_mfg = r.respiratorMake;
  if (r.respiratorModel) attrs.respirator_model = r.respiratorModel;
  if (r.respiratorType) attrs.respirator_type = r.respiratorType.replace(/_/g, '-').toUpperCase(); // full_face → FULL-FACE
  if (r.respiratorSize) attrs.size = r.respiratorSize;
  const kind = r.testType ? (r.testType === 'quantitative' ? 'QNFT' : 'QLFT') : null;
  const via = r.testMethod ? TEST_METHOD_LABELS[r.testMethod] || r.testMethod : null;
  if (kind || via) attrs.method = kind && via ? `${kind} via ${via}` : (kind ?? via)!;
  return Object.keys(attrs).length ? attrs : undefined;
}

/**
 * Mint (or return) the record's permanent student number — the card's printed
 * verify_id / lookup ref back into Sundog. Format TRT<year>-<6-digit seq>
 * (year = the test date's year). Persisted on first use so re-pushes and card
 * reprints always carry the same number.
 */
async function ensureStudentNo(r: { id: string; studentNo: string | null; testDate: Date }): Promise<string> {
  if (r.studentNo) return r.studentNo;
  const [row] = await prisma.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('fit_test_student_no_seq')`;
  const studentNo = `TRT${r.testDate.getUTCFullYear()}-${String(row!.nextval).padStart(6, '0')}`;
  await prisma.fitTestRecord.update({ where: { id: r.id }, data: { studentNo } });
  return studentNo;
}

async function buildOccHealthRecord(
  entityType: 'fit_test' | 'audiometric',
  entityId: string,
  externalId: string,
): Promise<BlueLionTrainingRecord | null> {
  const r = await prisma.fitTestRecord.findUnique({ where: { id: entityId } });
  if (!r) return null;

  const person = await buildPerson(r);

  if (entityType === 'fit_test') {
    // student_no doubles as certNumber — the spec prints student_no as the
    // card's verify_id, falling back to certNumber (handoff sets them equal).
    const studentNo = await ensureStudentNo(r);
    return {
      externalId,
      person,
      classCode: 'FIT-TEST',
      issuedOn: toYmd(r.testDate)!,
      // Fit tests are annual; if the wizard didn't set an expiry, BlueLion
      // computes one from the catalog (FIT-TEST = 12 months).
      expiresOn: toYmd(r.expiryDate),
      certNumber: studentNo,
      notes: fitTestNotes(r),
      attributes: { ...fitTestAttributes(r), student_no: studentNo },
    };
  }

  // Audiometric: an exam record, not pass/fail — baseline vs retest rides in
  // the notes. Expiry omitted → BlueLion computes from catalog (AUDIO = 12mo).
  return {
    externalId,
    person,
    classCode: 'AUDIO',
    issuedOn: toYmd(r.testDate)!,
    notes: r.audiometricResult ? `Audiometric exam — ${r.audiometricResult}` : 'Audiometric exam',
  };
}

// Exported for payload inspection scripts; the processor is the real consumer.
export async function buildRecord(row: {
  entityType: QueueEntityType;
  entityId: string;
  externalId: string;
}): Promise<BlueLionTrainingRecord | null> {
  return row.entityType === 'training'
    ? buildTrainingRecord(row.entityId, row.externalId)
    : buildOccHealthRecord(row.entityType as 'fit_test' | 'audiometric', row.entityId, row.externalId);
}

/**
 * Build the /assets registration record for an `asset` queue row. entityId is
 * the inspection whose serial+category first referenced the unit; purchase
 * date rides along when the serial resolves to a SerializedEquipment row.
 */
export async function buildAssetRecord(
  entityId: string,
  externalId: string,
): Promise<BlueLionAssetRecord | null> {
  const insp = await prisma.equipmentInspection.findUnique({
    where: { id: entityId },
    select: { serialNumber: true, category: true },
  });
  if (!insp) return null;
  const serial = insp.serialNumber.trim();
  const equip = await prisma.serializedEquipment.findUnique({
    where: { serialNumber: insp.serialNumber },
    select: { purchaseDate: true },
  });
  return {
    externalId,
    kind: mapCategoryToAssetKind(insp.category),
    serial,
    label: `${humanizeSnake(insp.category)} ${serial}`,
    purchasedOn: toYmd(equip?.purchaseDate),
  };
}

/** manualRefs captured at lock time (services/inspectionLock.ts's audit snapshot). */
type ManualRef = { key: string; doc: string; section?: string; revision?: string };

/**
 * Build the inspection-ledger event for a queue row — everything except
 * unitId, which the handler resolves from the unit's synced asset registration.
 * A 'pass'/visual-only outcome becomes a /services event; a 'condemn' outcome
 * instead becomes a /documents upload (condemnation PDF, retire=true) — see
 * handleServiceRows.
 */
export async function buildServiceRecord(
  entityId: string,
  externalId: string,
): Promise<{
  record: Omit<BlueLionServiceRecord, 'unitId'>;
  serial: string;
  category: string;
  outcome: string;
  condemnedOn?: string;
  serviceActions?: string[];
  manualRefs?: ManualRef[];
  customer?: string;
  /**
   * Set when a QA snapshot exists but cannot be sent legally. The row must be
   * surfaced, NOT pushed — a Vault record is immutable, so a service filed
   * without its checklist stays thin forever.
   */
  checklistError?: string;
} | null> {
  const insp = await prisma.equipmentInspection.findUnique({
    where: { id: entityId },
    select: {
      id: true, shopItemId: true, serialNumber: true, category: true,
      outcome: true, serviceActions: true, inspectedAt: true, lockedAt: true,
      notes: true, partsReplaced: true, data: true,
      inspectedBy: { select: { name: true } },
      shopItem: { select: { workOrder: { select: { company: { select: { name: true } } } } } },
      ticket: { select: { company: { select: { name: true } } } },
    },
  });
  if (!insp) return null;
  // enqueueInspectionRecord already gates on this; belt & suspenders since the
  // row may have aged in the queue since it was written.
  if (insp.outcome !== 'pass' && insp.outcome !== 'condemn') return null;

  // serviceType: the actions performed, humanized ("recharge, six year"),
  // with condemn surfaced explicitly; a bare pass is "inspection".
  const acts = Array.isArray(insp.serviceActions) ? (insp.serviceActions as string[]) : [];
  const parts = acts.map((a) => a.replace(/_/g, ' '));
  if (insp.outcome === 'condemn' && !acts.includes('condemn')) parts.push('condemned');
  const serviceType = (parts.join(', ') || 'inspection').slice(0, 200);

  const customer = insp.shopItem?.workOrder?.company?.name ?? insp.ticket?.company?.name ?? undefined;
  const noteBits = [
    `${insp.shopItemId ? 'Shop' : 'Field'} inspection — ${humanizeSnake(insp.category)}`,
    customer ? `Customer: ${customer}` : null,
    insp.notes || null,
    insp.partsReplaced ? `Parts replaced: ${insp.partsReplaced}` : null,
  ].filter(Boolean);

  const snapshot = (insp.data as { auditSnapshot?: { manualRefs?: unknown } } | null)?.auditSnapshot;
  const manualRefs = Array.isArray(snapshot?.manualRefs) ? (snapshot!.manualRefs as ManualRef[]) : undefined;

  // WI-06's batch QA, structured (SERVICEPRO-INTEGRATION.md §3.3). The write-once
  // vault snapshot is materialized onto exactly one locked inspection, so this
  // is a 1:1 lookup — an inspection that came from anywhere else simply has no
  // QA to send, which is `absent`, not an error.
  const qa = await prisma.shopQaUnitResult.findUnique({
    where: { inspectionId: insp.id },
    select: { vaultSnapshot: true },
  });
  const mapped = toBlueLionChecklist(qa?.vaultSnapshot as QaVaultSnapshot | null);
  if (mapped.status === 'invalid') {
    return {
      serial: insp.serialNumber.trim(),
      category: insp.category,
      outcome: insp.outcome,
      customer,
      checklistError: mapped.reason,
      record: { externalId, servicedOn: toYmd(insp.inspectedAt)!, serviceType },
    };
  }
  if (mapped.status === 'ok' && mapped.truncatedLabels > 0) {
    console.warn(
      `[BlueLion Queue] ${externalId}: truncated ${mapped.truncatedLabels} checkpoint label(s) to `
      + `${240} chars for the Vault record`,
    );
  }

  return {
    serial: insp.serialNumber.trim(),
    category: insp.category,
    outcome: insp.outcome,
    condemnedOn: insp.outcome === 'condemn' ? toYmd(insp.lockedAt ?? insp.inspectedAt) : undefined,
    serviceActions: acts.length ? acts : undefined,
    manualRefs: manualRefs && manualRefs.length ? manualRefs : undefined,
    customer,
    record: {
      externalId,
      servicedOn: toYmd(insp.inspectedAt)!,
      serviceType,
      technician: insp.inspectedBy?.name ?? undefined,
      // 2000, not 500. The 500 cap was ServicePRO's own, adopted on the belief
      // that BlueLion capped `notes` — BlueLion confirmed 2026-08-31 it never
      // has. The real ceiling is the 1MB request body.
      notes: noteBits.length ? noteBits.join(' — ').slice(0, 2000) : undefined,
      ...(mapped.status === 'ok'
        ? { checklist: mapped.checklist, checklistVersion: mapped.checklistVersion }
        : {}),
    },
  };
}

/**
 * Resolve the BlueLion assetId ("unitId") for a serial: prefer the stamp on
 * the SerializedEquipment row, fall back to the synced asset queue row (covers
 * serials with no equipment record).
 */
async function resolveUnitId(serial: string, category: string): Promise<string | null> {
  const equip = await prisma.serializedEquipment.findUnique({
    where: { serialNumber: serial },
    select: { blueLionAssetId: true },
  });
  if (equip?.blueLionAssetId) return equip.blueLionAssetId;
  const assetRow = await prisma.blueLionSyncQueue.findUnique({
    where: { externalId: assetExternalId(category, serial) },
    select: { status: true, blueLionAssetId: true },
  });
  return assetRow?.status === 'synced' ? (assetRow.blueLionAssetId ?? null) : null;
}

async function markRetryOrError(row: QueueRow, message: string): Promise<void> {
  if (row.retryCount < MAX_RETRIES) {
    await prisma.blueLionSyncQueue.update({
      where: { id: row.id },
      data: { status: 'retrying', retryCount: row.retryCount + 1, errorMessage: message.slice(0, 2000) },
    });
    console.warn(`[BlueLion Queue] ↻ retry ${row.externalId} (${row.retryCount + 1}/${MAX_RETRIES}): ${message}`);
  } else {
    await prisma.blueLionSyncQueue.update({
      where: { id: row.id },
      data: { status: 'error', errorMessage: message.slice(0, 2000), respondedAt: new Date() },
    });
    console.error(`[BLUELION ALERT] ✗ permanent failure ${row.externalId}: ${message}`);
  }
}

async function applyResult(row: QueueRow, result: BlueLionTrainingResult): Promise<void> {
  // Resolve the source row's ticketId once for event payloads.
  const isTraining = row.entityType === 'training';
  const certType = isTraining ? null : (row.entityType as 'fit_test' | 'audiometric');
  const source = isTraining
    ? await prisma.trainingRosterRecord.findUnique({
        where: { id: row.entityId },
        select: { ticketId: true },
      })
    : await prisma.fitTestRecord.findUnique({
        where: { id: row.entityId },
        select: { ticketId: true },
      });
  const ticketId = source?.ticketId ?? '';

  if (result.status === 'added' || result.status === 'skipped') {
    const personId = result.personId ?? null;
    const trainingSeq = result.trainingSeq ?? null;
    await prisma.blueLionSyncQueue.update({
      where: { id: row.id },
      data: {
        status: 'synced',
        resultStatus: result.status,
        blueLionPersonId: personId,
        trainingSeq,
        candidates: undefined,
        errorMessage: null,
        respondedAt: new Date(),
        responsePayload: JSON.stringify(result).slice(0, 10000),
      },
    });
    // Stamp the source row; it may have been deleted since enqueue.
    if (isTraining) {
      await prisma.trainingRosterRecord
        .update({
          where: { id: row.entityId },
          data: {
            blueLionPersonId: personId,
            blueLionTrainingSeq: trainingSeq,
            blueLionSyncedAt: new Date(),
          },
        })
        .catch(() => {});
    } else {
      await prisma.fitTestRecord
        .update({
          where: { id: row.entityId },
          data: { blueLionPersonId: personId, blueLionSyncedAt: new Date() },
        })
        .catch(() => {});
    }

    console.log(`[BlueLion Queue] ✓ ${result.status} ${row.externalId} → person ${personId ?? 'n/a'} seq ${trainingSeq ?? 'n/a'}`);
    if (isTraining) {
      void emitEvent('bluelion.training.synced', {
        rosterRecordId: row.entityId,
        ticketId,
        externalId: row.externalId,
        personId,
        trainingSeq,
        syncedAt: new Date().toISOString(),
      });
    } else {
      void emitEvent('bluelion.occhealth.synced', {
        fitTestRecordId: row.entityId,
        certType: certType!,
        ticketId,
        externalId: row.externalId,
        personId,
        trainingSeq,
        syncedAt: new Date().toISOString(),
      });
    }
    return;
  }

  // ambiguous | invalid → needs human action
  const reason =
    result.status === 'ambiguous'
      ? `Multiple BlueLion persons match — pick one and resolve (${result.candidates?.length ?? 0} candidates)`
      : result.error || 'BlueLion rejected the record as invalid';

  await prisma.blueLionSyncQueue.update({
    where: { id: row.id },
    data: {
      status: 'needs_attention',
      resultStatus: result.status,
      candidates: result.candidates ? (result.candidates as unknown as object) : undefined,
      errorMessage: reason.slice(0, 2000),
      respondedAt: new Date(),
      responsePayload: JSON.stringify(result).slice(0, 10000),
    },
  });

  console.warn(`[BlueLion Queue] ⚠ ${result.status} ${row.externalId}: ${reason}`);
  if (isTraining) {
    void emitEvent('bluelion.training.needs_attention', {
      rosterRecordId: row.entityId,
      ticketId,
      externalId: row.externalId,
      resultStatus: result.status,
      reason,
    });
  } else {
    void emitEvent('bluelion.occhealth.needs_attention', {
      fitTestRecordId: row.entityId,
      certType: certType!,
      ticketId,
      externalId: row.externalId,
      resultStatus: result.status,
      reason,
    });
  }
}

/** Apply a /assets result: store the assetId and stamp the equipment row. */
async function applyAssetResult(row: QueueRow, record: BlueLionAssetRecord, result: BlueLionAssetResult): Promise<void> {
  if (result.status === 'added' || result.status === 'found' || result.status === 'skipped') {
    const assetId = result.assetId ?? null;
    await prisma.blueLionSyncQueue.update({
      where: { id: row.id },
      data: {
        status: 'synced',
        resultStatus: result.status,
        blueLionAssetId: assetId,
        errorMessage: null,
        respondedAt: new Date(),
        responsePayload: JSON.stringify(result).slice(0, 10000),
      },
    });
    if (assetId) {
      // serialNumber is unique → 0 or 1 rows; serial-only units simply have no
      // equipment row to stamp (the queue row keeps the assetId for them).
      await prisma.serializedEquipment
        .updateMany({
          where: { serialNumber: record.serial },
          data: { blueLionAssetId: assetId, blueLionSyncedAt: new Date() },
        })
        .catch(() => {});
    }
    console.log(`[BlueLion Queue] ✓ ${result.status} ${row.externalId} → asset ${assetId ?? 'n/a'}`);
    return;
  }
  const reason = result.error || 'BlueLion rejected the asset record as invalid';
  await prisma.blueLionSyncQueue.update({
    where: { id: row.id },
    data: {
      status: 'needs_attention',
      resultStatus: 'invalid',
      errorMessage: reason.slice(0, 2000),
      respondedAt: new Date(),
      responsePayload: JSON.stringify(result).slice(0, 10000),
    },
  });
  console.warn(`[BlueLion Queue] ⚠ invalid ${row.externalId}: ${reason}`);
}

/** Apply a BlueLion /documents result (the condemn path) to its queue row. */
async function applyDocumentResult(row: QueueRow, result: BlueLionDocumentResult): Promise<void> {
  if (result.status === 'added' || result.status === 'skipped') {
    await prisma.blueLionSyncQueue.update({
      where: { id: row.id },
      data: {
        status: 'synced',
        resultStatus: result.status,
        errorMessage: null,
        respondedAt: new Date(),
        responsePayload: JSON.stringify(result).slice(0, 10000),
      },
    });
    console.log(`[BlueLion Queue] ✓ ${result.status} ${row.externalId} (document${result.docId ? ` → ${result.docId}` : ''})`);
    return;
  }
  // BlueLion echoes `allowedDocTypes` on an unknown type specifically so the
  // vocabulary is discoverable from the rejection. Dropping it on the floor
  // would leave a queue row saying "invalid" and nothing else.
  const allowed = Array.isArray(result.allowedDocTypes) && result.allowedDocTypes.length
    ? ` (BlueLion accepts: ${result.allowedDocTypes.join(', ')})`
    : '';
  const reason = `${result.error || 'BlueLion rejected the document as invalid'}${allowed}`;
  await prisma.blueLionSyncQueue.update({
    where: { id: row.id },
    data: {
      status: 'needs_attention',
      resultStatus: 'invalid',
      errorMessage: reason.slice(0, 2000),
      respondedAt: new Date(),
      responsePayload: JSON.stringify(result).slice(0, 10000),
    },
  });
  console.warn(`[BlueLion Queue] ⚠ invalid ${row.externalId}: ${reason}`);
}

/**
 * Close out a /services batch.
 *
 * TWO SHAPES, and both are legal. BlueLion added per-record `results` on
 * 2026-08-31 so a malformed record stops discarding the healthy ones beside it;
 * a BlueLion that predates that answers with the counts alone, and was
 * explicitly promised the counts keep their old meaning. So the array is used
 * when present and the batch verdict stands in when it is not — rather than SP
 * hard-depending on a field a partner may not send yet.
 *
 * The difference matters: under the old shape every row in a 202 batch was
 * marked `synced`, INCLUDING one BlueLion had rejected. Per-record results are
 * the first time a single bad record is visible as itself.
 */
async function markServiceRowsSynced(rows: QueueRow[], resp: BlueLionServicesResponse): Promise<void> {
  const now = new Date();
  const byExternalId = new Map<string, BlueLionServiceResult>();
  if (Array.isArray(resp.results)) {
    for (const r of resp.results) if (r?.externalId) byExternalId.set(r.externalId, r);
  }
  const perRecord = byExternalId.size > 0;

  for (const row of rows) {
    const result = perRecord ? byExternalId.get(row.externalId) : undefined;

    // A results array that skips one of our records tells us nothing about it.
    // Guessing 'synced' would bury a rejection; say we do not know instead.
    if (perRecord && !result) {
      await prisma.blueLionSyncQueue.update({
        where: { id: row.id },
        data: {
          status: 'needs_attention',
          resultStatus: 'invalid',
          errorMessage: 'BlueLion returned no per-record result for this service record',
          respondedAt: now,
          responsePayload: JSON.stringify(resp).slice(0, 10000),
        },
      });
      console.error(`[BLUELION ALERT] ✗ service ${row.externalId}: absent from the results array`);
      continue;
    }

    if (result && result.status === 'invalid') {
      await prisma.blueLionSyncQueue.update({
        where: { id: row.id },
        data: {
          status: 'needs_attention',
          resultStatus: 'invalid',
          errorMessage: (result.error || 'BlueLion rejected the service record').slice(0, 2000),
          respondedAt: now,
          responsePayload: JSON.stringify(result).slice(0, 10000),
        },
      });
      console.error(`[BLUELION ALERT] ✗ service ${row.externalId}: ${result.error || 'invalid'}`);
      continue;
    }

    await prisma.blueLionSyncQueue.update({
      where: { id: row.id },
      data: {
        status: 'synced',
        resultStatus: result?.status === 'skipped' ? 'skipped' : 'added',
        errorMessage: null,
        respondedAt: now,
        ...(result?.assetId ? { blueLionAssetId: result.assetId } : {}),
        responsePayload: JSON.stringify(result ?? resp).slice(0, 10000),
      },
    });
    console.log(
      result
        ? `[BlueLion Queue] ✓ ${result.status} service ${row.externalId}${result.eventSeq ? ` (seq ${result.eventSeq})` : ''}`
        : `[BlueLion Queue] ✓ service ${row.externalId} (batch added=${resp.added} skipped=${resp.skipped})`,
    );
  }
}

/** On a whole-batch transport failure, retry/error every row in the batch. */
async function failBatch(rows: QueueRow[], err: unknown, label: string): Promise<void> {
  const isApiError = err instanceof BlueLionApiError;
  const isRetryable = isApiError && err.isRetryable;
  const message = err instanceof Error ? err.message : String(err);
  const statusCode = isApiError ? err.statusCode : null;
  for (const row of rows) {
    if (isRetryable) {
      await markRetryOrError(row, message);
    } else {
      await prisma.blueLionSyncQueue.update({
        where: { id: row.id },
        data: { status: 'error', errorMessage: message.slice(0, 2000), responseStatusCode: statusCode, respondedAt: new Date() },
      });
    }
  }
  console.error(`[BLUELION ALERT] ${label} batch POST failed (${rows.length} rows): ${message}`);
}

function toRow(e: { id: string; entityType: string; entityId: string; externalId: string; retryCount: number }): QueueRow {
  return { id: e.id, entityType: e.entityType as QueueEntityType, entityId: e.entityId, externalId: e.externalId, retryCount: e.retryCount };
}

async function markRowInvalid(id: string, message: string): Promise<void> {
  await prisma.blueLionSyncQueue.update({
    where: { id },
    data: { status: 'needs_attention', resultStatus: 'invalid', errorMessage: message, respondedAt: new Date() },
  });
}

/** Cert rows (training / fit_test / audiometric) → the /trainings endpoint. */
async function handleCertRows(entries: Array<Parameters<typeof toRow>[0]>): Promise<void> {
  const built: { row: QueueRow; record: BlueLionTrainingRecord }[] = [];
  for (const e of entries) {
    const row = toRow(e);
    const record = await buildRecord(row);
    if (!record) {
      await markRowInvalid(e.id, 'Source record missing or course has no BlueLion classCode mapping');
      continue;
    }
    built.push({ row, record });
  }
  if (built.length === 0) return;

  console.log(`[BlueLion Queue] Submitting ${built.length} cert record(s)`);
  await Promise.all(
    built.map((b) =>
      prisma.blueLionSyncQueue.update({
        where: { id: b.row.id },
        data: { requestPayload: JSON.stringify(b.record).slice(0, 10000), submittedAt: new Date() },
      }),
    ),
  );

  try {
    const resp = await pushTrainings(built.map((b) => b.record));
    const byId = new Map<string, BlueLionTrainingResult>((resp.body.results || []).map((r) => [r.externalId, r]));
    for (const b of built) {
      const result = byId.get(b.row.externalId);
      if (!result) await markRetryOrError(b.row, 'BlueLion returned no result for this externalId');
      else await applyResult(b.row, result);
    }
  } catch (err) {
    await failBatch(built.map((b) => b.row), err, 'trainings');
  }
}

/** `asset` rows → POST /assets. Runs BEFORE service rows each tick so a fresh
 *  unit's registration resolves in the same tick as its first service event. */
async function handleAssetRows(entries: Array<Parameters<typeof toRow>[0]>): Promise<void> {
  const built: { row: QueueRow; record: BlueLionAssetRecord }[] = [];
  for (const e of entries) {
    const row = toRow(e);
    const record = await buildAssetRecord(row.entityId, row.externalId);
    if (!record) {
      await markRowInvalid(e.id, 'Source inspection for this unit registration is missing');
      continue;
    }
    built.push({ row, record });
  }
  if (built.length === 0) return;

  console.log(`[BlueLion Queue] Submitting ${built.length} asset registration(s)`);
  await Promise.all(
    built.map((b) =>
      prisma.blueLionSyncQueue.update({
        where: { id: b.row.id },
        data: { requestPayload: JSON.stringify(b.record).slice(0, 10000), submittedAt: new Date() },
      }),
    ),
  );

  try {
    const resp = await pushAssets(built.map((b) => b.record));
    const byId = new Map<string, BlueLionAssetResult>((resp.body.results || []).map((r) => [r.externalId, r]));
    for (const b of built) {
      const result = byId.get(b.row.externalId);
      if (!result) await markRetryOrError(b.row, 'BlueLion returned no result for this externalId');
      else await applyAssetResult(b.row, b.record, result);
    }
  } catch (err) {
    await failBatch(built.map((b) => b.row), err, 'assets');
  }
}

/**
 * Inspection rows → either POST /services (pass / visual_only) or POST
 * /documents+retire (condemn), using the unit's synced assetId as unitId /
 * blueLionId. Rows whose unit isn't registered yet stay pending (the asset
 * row is ensured and, being older-or-equal in the ordered queue, syncs
 * first).
 */
async function handleServiceRows(entries: Array<Parameters<typeof toRow>[0]>): Promise<void> {
  const built: { row: QueueRow; unitId: string; result: NonNullable<Awaited<ReturnType<typeof buildServiceRecord>>> }[] = [];
  for (const e of entries) {
    const row = toRow(e);
    const result = await buildServiceRecord(row.entityId, row.externalId);
    if (!result) {
      await markRowInvalid(e.id, 'Source inspection missing');
      continue;
    }
    // Refuse to file a thin immutable record. Retry after fixing the snapshot.
    if (result.checklistError) {
      await markRowInvalid(e.id, `QA checklist cannot be sent: ${result.checklistError}`);
      continue;
    }
    const unitId = await resolveUnitId(result.serial, result.category);
    if (!unitId) {
      // Legacy Wave-3 rows predate the asset stage — make sure the unit's
      // registration is queued, then wait for it (row stays pending).
      await ensureAssetRow({ id: row.entityId, category: result.category, serialNumber: result.serial });
      await prisma.blueLionSyncQueue.update({
        where: { id: row.id },
        data: { errorMessage: 'Waiting for unit registration (/assets) to sync' },
      });
      continue;
    }
    built.push({ row, unitId, result });
  }
  if (built.length === 0) return;

  console.log(`[BlueLion Queue] Submitting ${built.length} inspection event(s)`);
  await Promise.all(
    built.map((b) =>
      prisma.blueLionSyncQueue.update({
        where: { id: b.row.id },
        data: { requestPayload: JSON.stringify(b.result.record).slice(0, 10000), submittedAt: new Date() },
      }),
    ),
  );

  const passRows = built.filter((b) => b.result.outcome !== 'condemn');
  const condemnRows = built.filter((b) => b.result.outcome === 'condemn');

  // pass / visual_only → one /services batch call.
  if (passRows.length > 0) {
    try {
      const resp = await pushServices(passRows.map((b) => ({ ...b.result.record, unitId: b.unitId })));
      await markServiceRowsSynced(passRows.map((b) => b.row), resp.body);
    } catch (err) {
      await failBatch(passRows.map((b) => b.row), err, 'services');
    }
  }

  // condemn → one /documents upload per row (BlueLion accepts one file per request).
  for (const b of condemnRows) {
    try {
      const doc = await generateEquipmentInspectionPdf({
        serialNumber: b.result.serial,
        category: b.result.category,
        outcome: b.result.outcome,
        inspectedOn: b.result.record.servicedOn,
        condemnedOn: b.result.condemnedOn,
        serviceActions: b.result.serviceActions,
        notes: b.result.record.notes,
        technician: b.result.record.technician,
        customer: b.result.customer,
        manualRefs: b.result.manualRefs,
      });
      const fileBuffer = await pdfToBuffer(doc);
      const resp = await uploadDocument({
        externalId: b.row.externalId,
        docType: 'condemnation',
        file: fileBuffer,
        filename: `condemnation-${b.result.serial}.pdf`,
        contentType: 'application/pdf',
        blueLionId: b.unitId,
        title: `Condemnation — ${b.result.serial}`,
        issuedOn: b.result.condemnedOn || b.result.record.servicedOn,
        retire: true,
        reason: b.result.record.notes,
      });
      await applyDocumentResult(b.row, resp.body);
    } catch (err) {
      await failBatch([b.row], err, 'equipment-inspection condemnation document');
    }
  }
}

/**
 * WI-04 — push per-unit evidence to VaultPRO as documents.
 *
 * One upload per row (BlueLion takes one file per request), same as the
 * condemnation-document path above.
 *
 * WHAT ACTUALLY GOES. BlueLion's docType vocabulary is narrower than ours --
 * services/equipmentDocuments.ts already learned this and maps only the types
 * BlueLion accepts. UE reports, condition photos, flow-test reports and test
 * paperwork have explicit mappings there. Billing and other unmapped documents
 * stay ServicePRO-only; do not guess a partner docType for them.
 *
 * A row whose unit has no resolved assetId yet is LEFT PENDING, not failed.
 * That is the ordinary state of a freshly photographed unit: its `asset`
 * registration is in the same queue and usually syncs a moment later. Marking
 * it an error would put a red count on the Ops dashboard for something working
 * exactly as designed.
 */
const DOC_TITLE_FOR_KIND: Record<string, string> = {
  ue_report: 'UE Report',
  photo: 'Condition Photo',
  pozi_report: 'Flow Test',
  test_paperwork: 'Test Paperwork',
};

/** Close a queue row out as "nothing to send", without it looking like a failure. */
async function skipAttachmentRow(rowId: string): Promise<void> {
  await prisma.blueLionSyncQueue.update({
    where: { id: rowId },
    data: { status: 'synced', resultStatus: 'skipped', errorMessage: null, respondedAt: new Date() },
  });
}

async function handleAttachmentRows(
  entries: Array<Parameters<typeof toRow>[0]>,
): Promise<void> {
  if (entries.length === 0) return;

  for (const entry of entries) {
    const row = toRow(entry);
    try {
      const attachment = await prisma.attachment.findUnique({
        where: { id: entry.entityId },
        select: {
          id: true, fileName: true, mimeType: true, kind: true, serialNumber: true,
          storageState: true, bufferKey: true, remoteKey: true, capturedAt: true,
          shopItem: { select: { equipmentCategory: true, serialNumber: true } },
          inspection: { select: { category: true, serialNumber: true } },
        },
      });

      // Deleted after being queued: nothing to push, nothing wrong.
      if (!attachment) { await skipAttachmentRow(row.id); continue; }

      const docType = blueLionDocTypeForAttachmentKind(attachment.kind);
      if (!docType) { await skipAttachmentRow(row.id); continue; }

      const serial = attachment.serialNumber
        || attachment.shopItem?.serialNumber
        || attachment.inspection?.serialNumber;
      const category = attachment.shopItem?.equipmentCategory || attachment.inspection?.category;
      // Evidence with no unit has nothing in VaultPRO to hang on.
      if (!serial || !category) { await skipAttachmentRow(row.id); continue; }

      const unitId = await resolveUnitId(serial, category);
      // Normal early state — see the note above. Left pending for the next tick.
      if (!unitId) continue;

      // Read from whichever tier holds the bytes. A file still in the SP buffer
      // (B2 not caught up) is perfectly pushable — VaultPRO does not care which
      // of our tiers it came from.
      const file = await readAttachmentBytes(attachment);

      const resp = await uploadDocument({
        externalId: row.externalId,
        docType,
        file,
        filename: attachment.fileName,
        contentType: attachment.mimeType || 'application/octet-stream',
        blueLionId: unitId,
        serial,
        title: `${DOC_TITLE_FOR_KIND[attachment.kind] ?? 'Attachment'} — ${serial}`,
        issuedOn: attachment.capturedAt.toISOString().slice(0, 10),
      });

      await applyDocumentResult(row, resp.body);
      if (resp.body?.docId) {
        await prisma.attachment.update({
          where: { id: attachment.id },
          data: { blueLionDocId: resp.body.docId, blueLionSyncedAt: new Date() },
        });
      }
    } catch (err) {
      await failBatch([row], err, 'attachment document');
    }
  }
}

async function processBatch(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  try {
    const entries = await prisma.blueLionSyncQueue.findMany({
      where: { status: { in: ['pending', 'retrying'] } },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    });
    if (entries.length === 0) return;

    // Three endpoints, one queue: assets FIRST (service rows need the returned
    // assetId), then person certs, then service events.
    const assetEntries = entries.filter((e) => e.entityType === 'asset');
    const serviceEntries = entries.filter((e) => e.entityType === 'equipment_inspection');
    const attachmentEntries = entries.filter((e) => e.entityType === 'attachment');
    // NB certEntries is a catch-all by design, so every new entityType has to be
    // excluded here explicitly or it gets pushed at BlueLion as a person cert.
    const certEntries = entries.filter(
      (e) => e.entityType !== 'equipment_inspection'
        && e.entityType !== 'asset'
        && e.entityType !== 'attachment',
    );
    await handleAssetRows(assetEntries);
    await handleCertRows(certEntries);
    await handleServiceRows(serviceEntries);
    // Documents last: they need the assetId the asset rows above just resolved.
    await handleAttachmentRows(attachmentEntries);
  } catch (err) {
    console.error('[BlueLion Queue] Unexpected error in submission loop:', err);
  } finally {
    isProcessing = false;
  }
}

export function startBlueLionQueueProcessor(): void {
  if (!isConfigured()) {
    console.log('[BlueLion Queue] Skipped — BLUELION_URL / BLUELION_TOKEN not configured');
    return;
  }
  console.log(`[BlueLion Queue] Starting processor (submit every ${SUBMIT_INTERVAL_MS / 1000}s, batch ${BATCH_SIZE})`);
  const runSubmit = () => { heartbeat('bluelion'); return runScheduledJob('bluelion.submit', 600, processBatch); };
  submitTimer = setInterval(runSubmit, SUBMIT_INTERVAL_MS);
  setTimeout(runSubmit, 7000); // once shortly after warmup
}

export function stopBlueLionQueueProcessor(): void {
  if (submitTimer) {
    clearInterval(submitTimer);
    submitTimer = null;
  }
  console.log('[BlueLion Queue] Processor stopped');
}
