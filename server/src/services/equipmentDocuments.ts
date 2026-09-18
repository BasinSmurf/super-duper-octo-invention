/**
 * equipmentDocuments.ts — unit-scoped regulatory documents.
 *
 * The flow this exists to make boring:
 *
 *   shop uploads a UE PDF
 *     → stored once via the FileStore (S3 in prod, disk in dev)
 *     → rowed against the CYLINDER, not the inspection
 *     → pushed to BlueLion as bytes; their returned docId is stored back
 *
 * The file ends up in two places on purpose. BlueLion's `/documents` endpoint
 * takes an upload, not a URL, and their customer-facing record page has to keep
 * working when SP is down — that independence is the whole "bad divorce"
 * premise, and a second copy of a 2MB PDF is a rounding error against it.
 */
import { prisma } from '../db.js';
import { getFileStore, equipmentDocumentKey } from './fileStore.js';
import type { BlueLionDocType } from './blueLionClient.js';

export type EquipmentDocType = 'ultrasonic_exam' | 'hydrostatic_test' | 'condemnation' | 'other';

/**
 * Only these ride to BlueLion — their docType enum is still narrower than ours.
 *
 * `hydrostatic_test` is deliberately UNMAPPED. BlueLion's vocabulary has no
 * hydro type, and `flow_test` / `test_paperwork` are not it — a hydro is a
 * pressure test of a cylinder, not a flow check and not paperwork. Filing it
 * under a plausible-sounding neighbour would put a permanently mislabelled
 * record in an immutable ledger, which is worse than not filing it. If hydros
 * need to reach the Vault, that is a seventh docType to ask BlueLion for.
 */
const BLUELION_DOC_TYPES: Record<string, BlueLionDocType | undefined> = {
  ultrasonic_exam: 'ultrasonic_exam',
  condemnation: 'condemnation',
};

export function blueLionDocType(docType: EquipmentDocType): BlueLionDocType | undefined {
  return BLUELION_DOC_TYPES[docType];
}

/**
 * The same narrowing, for WI-04's per-unit attachment kinds.
 *
 * BlueLion accepted the Div-6 request and added four types on 2026-08-31, so
 * the categories ServicePRO had been holding rather than mislabelling now have
 * real homes. Note `flow_test`, NOT `posi_check`: Posi-Check is one vendor's
 * instrument, and a record type outlives the brand of the box in the shop.
 *
 * `vendor_invoice` IS NOT PUSHED, even though BlueLion built the docType for
 * it. Max's call 2026-09-01, and it is the right line: the Vault is the unit's
 * condition history, and a vendor invoice is not condition — it is what Basin
 * paid. The service record already tells the Vault that an outside repair
 * happened and what was done to the unit; the price attached to it adds nothing
 * a future reader of the equipment record needs, and puts Basin's cost data in
 * an external, immutable ledger to do it. It stays a ServicePRO record, which
 * is where billing reads it from anyway.
 * The docType exists on BlueLion's side if that judgement ever reverses.
 *
 * `packing_slip`, `signature`, `document` and `other` stay unmapped too — they are not evidence
 * about a unit's condition, and SP remains the system of record for them.
 *
 * Lives here, beside the EquipmentDocument mapping, so "what BlueLion accepts"
 * has exactly one home.
 */
const BLUELION_ATTACHMENT_DOC_TYPES: Record<string, BlueLionDocType | undefined> = {
  ue_report: 'ultrasonic_exam',
  photo: 'condition_photo',
  pozi_report: 'flow_test',
  test_paperwork: 'test_paperwork',
};

export function blueLionDocTypeForAttachmentKind(kind: string): BlueLionDocType | undefined {
  return BLUELION_ATTACHMENT_DOC_TYPES[kind];
}

/** The attachment kinds that now reach the Vault — used by the backfill drain. */
export const BLUELION_PUSHABLE_ATTACHMENT_KINDS = Object.keys(
  BLUELION_ATTACHMENT_DOC_TYPES,
) as string[];

/**
 * BlueLion's idempotency key for a document. The revision is IN the id by
 * design: their ingest dedupes on externalId, so a corrected report re-pushed
 * under the old id comes back `skipped` and their copy silently stays wrong.
 */
export function documentExternalId(equipmentId: string, docType: EquipmentDocType, revision: number): string {
  return `sp-doc-${docType}-${equipmentId}-r${revision}`;
}

/**
 * Next revision for this unit + docType. A first upload is r1; every
 * correction increments, and nothing is ever overwritten — the superseded PDF
 * stays at its own storage key so the record of what was believed, and when,
 * survives.
 */
export async function nextRevision(equipmentId: string, docType: EquipmentDocType): Promise<number> {
  const latest = await prisma.equipmentDocument.findFirst({
    where: { equipmentId, docType },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  });
  return (latest?.revision ?? 0) + 1;
}

export interface StoreDocumentArgs {
  equipmentId: string;
  docType: EquipmentDocType;
  file: Buffer;
  fileName: string;
  mimeType?: string;
  issuedOn?: Date;
  /** Provenance — the inspection that produced it, when there was one. */
  inspectionId?: string;
  uploadedById?: string;
}

export interface StoredDocument {
  id: string;
  revision: number;
  storageKey: string;
  externalId: string;
}

/** Store the bytes, then the row. Never overwrites an existing revision. */
export async function storeEquipmentDocument(args: StoreDocumentArgs): Promise<StoredDocument> {
  const revision = await nextRevision(args.equipmentId, args.docType);
  const key = equipmentDocumentKey(args.equipmentId, revision, args.fileName);

  await getFileStore().write(key, args.file, args.mimeType);

  const row = await prisma.equipmentDocument.create({
    data: {
      equipmentId: args.equipmentId,
      docType: args.docType,
      revision,
      storageKey: key,
      fileName: args.fileName,
      mimeType: args.mimeType,
      fileSizeBytes: args.file.length,
      issuedOn: args.issuedOn,
      inspectionId: args.inspectionId,
      uploadedById: args.uploadedById,
    },
    select: { id: true },
  });

  return {
    id: row.id,
    revision,
    storageKey: key,
    externalId: documentExternalId(args.equipmentId, args.docType, revision),
  };
}

/** Stamp BlueLion's docId once their /documents call comes back `added`. */
export async function markDocumentSynced(id: string, blueLionDocId: string | null): Promise<void> {
  await prisma.equipmentDocument.update({
    where: { id },
    data: { blueLionDocId, blueLionSyncedAt: new Date() },
  });
}

/** Every document for a unit, newest revision of each type first. */
export async function documentsForEquipment(equipmentId: string) {
  return prisma.equipmentDocument.findMany({
    where: { equipmentId },
    orderBy: [{ docType: 'asc' }, { revision: 'desc' }],
  });
}
