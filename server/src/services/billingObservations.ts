// Billing Lineage Phase 1 — the mirror-write helper.
//
// Rule 2/3 from the handoff: anything QB or Enverus asserts is a mirror, and
// every mirror stores value + source + as-of + observed-at. This is the ONE
// place that writes billing_observation rows, so validation lives once
// instead of being re-implemented at every QBWC/Enverus call site.
//
// Phase 2 (scripts/backfill-billing-doc-refs.ts + services/billingLineage.ts)
// backfilled doc_ref for pre-existing invoices and now creates one live for
// every new invoice, so this no-op path should be rare in practice — but
// `recordDocRefObservationByDocNumber` still checks rather than assumes: it
// logs and returns null instead of writing an observation that dangles with
// nothing to hang off, for any invoice number that genuinely has no doc_ref
// yet (e.g. the backfill hasn't run in a given environment).

import { prisma, Prisma } from '../db.js';

export type ObservationSource = 'quickbooks' | 'openinvoice' | 'human';

export interface ObservationInput {
  factKey: string;
  factValue: unknown;
  source: ObservationSource;
  sourceActor?: string | null;
  asOf: Date;
}

type Subject =
  | { docRefId: string; docLineRefId?: never; ticketId?: never }
  | { docLineRefId: string; docRefId?: never; ticketId?: never }
  | { ticketId: string; docRefId?: never; docLineRefId?: never };

/**
 * Append-only write to billing_observation. Exactly one subject key must be
 * set (docRefId | docLineRefId | ticketId) — enforced here in addition to the
 * DB-level `human` source CHECK, so callers get a clear error before the
 * insert round-trip.
 */
export async function recordObservation(
  tx: Prisma.TransactionClient,
  subject: Subject,
  input: ObservationInput,
): Promise<{ id: string }> {
  const subjectKeys = ['docRefId', 'docLineRefId', 'ticketId'].filter(
    (k) => (subject as Record<string, unknown>)[k] != null,
  );
  if (subjectKeys.length !== 1) {
    throw new Error(
      `recordObservation: expected exactly one subject key, got ${subjectKeys.length} (${JSON.stringify(subject)})`,
    );
  }
  if (input.source === 'human' && !input.sourceActor) {
    throw new Error('recordObservation: source "human" requires sourceActor');
  }

  // note: `tx` param kept for call-site symmetry with the rest of the
  // codebase's transaction-scoped helpers (see companyGuards.ts), even though
  // this call currently goes through the global `prisma` client — swap to
  // `tx.billingObservation.create` once call sites wrap this in a $transaction.
  void tx;
  return prisma.billingObservation.create({
    data: {
      ...subject,
      factKey: input.factKey,
      factValue: input.factValue as Prisma.InputJsonValue,
      source: input.source,
      sourceActor: input.sourceActor ?? null,
      asOf: input.asOf,
    },
    select: { id: true },
  });
}

/**
 * Resolve a billing_doc_ref by its doc number (latest revision) and record an
 * observation against it. No-ops — logs and returns null — when no doc_ref
 * exists yet for that doc number, which is expected for every invoice until
 * Phase 2's backfill runs. Never throws on a missing doc_ref; a missing
 * mirror target must not break the QBWC/Enverus flow it's attached to
 * (bad-divorce rule — a failed/skipped observation gates nothing).
 */
export async function recordDocRefObservationByDocNumber(
  tx: Prisma.TransactionClient,
  docNumber: string,
  input: ObservationInput,
): Promise<{ id: string } | null> {
  try {
    const docRef = await prisma.billingDocRef.findFirst({
      where: { docNumber },
      orderBy: { revision: 'desc' },
      select: { id: true },
    });
    if (!docRef) {
      console.log(`[billingObservations] no billing_doc_ref for doc_number=${docNumber} yet — skipping observation "${input.factKey}"`);
      return null;
    }
    return recordObservation(tx, { docRefId: docRef.id }, input);
  } catch (err) {
    // Same bad-divorce rule as above — a mirror-write failure never bubbles
    // up into the QB/Enverus response handler that's doing the real work.
    console.error(`[billingObservations] failed to record observation "${input.factKey}" for doc_number=${docNumber}:`, err);
    return null;
  }
}
