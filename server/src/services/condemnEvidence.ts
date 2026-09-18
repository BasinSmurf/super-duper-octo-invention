/**
 * condemnEvidence.ts — a unit cannot be condemned without evidence.
 *
 * WI-04: "Attachments are optional in general, REQUIRED on condemn. A unit
 * cannot be marked condemned without at least one attachment."
 *
 * WHY THIS IS ONE FUNCTION AND NOT A UI CHECK. Condemning is the one shop
 * action with no undo and real money attached: the unit is dead, a DEAD record
 * goes to VaultPRO, the customer is told their equipment is scrap, and the
 * inspection labour bills anyway. When that is questioned six months later, the
 * photo is the whole answer. There are two code paths that reach `condemned`:
 *
 *   1. the raw status button on the shop board (PATCH .../items/:id/status)
 *   2. the inspection cascade, when an outcome or a CONDEMN rule fires
 *      (services/inspectionRouting.ts)
 *
 * A check in the condemn dialog covers neither of those reliably, so the gate
 * lives here and both call it. Adding a third path without calling this is
 * possible — but it now requires ignoring a function whose name says what it is
 * for, rather than merely forgetting a form validation.
 *
 * WHAT COUNTS AS EVIDENCE: any attachment on the unit, of any kind. A photo of
 * the crack, the UE report that failed it, the vendor's teardown note. The rule
 * is "show me why", not "produce a specific document" — over-specifying the kind
 * would just push techs into attaching the wrong thing to get past the gate.
 *
 * Sub-components (parentItemId set) inherit their parent assembly's disposition
 * and are not separately gated, matching how the QA gate already treats them.
 */

import type { PrismaClient } from '../db.js';

export const CONDEMN_EVIDENCE_MESSAGE =
  'A unit cannot be condemned without evidence. Attach at least one photo or ' +
  'report to this unit first — the attachment is what answers "why was this ' +
  'scrapped?" when the customer asks.';

export interface CondemnEvidenceCheck {
  satisfied: boolean;
  attachmentCount: number;
  message?: string;
}

/**
 * Does this unit have the evidence a condemn requires?
 *
 * Counts attachments on the unit itself AND on any inspection of that unit —
 * a tech who photographed the fault inside the inspection editor has already
 * done the thing being asked for, and should not be told to do it twice
 * somewhere else.
 */
export async function checkCondemnEvidence(
  prisma: Pick<PrismaClient, 'attachment' | 'shopWorkOrderItem'>,
  shopItemId: string,
): Promise<CondemnEvidenceCheck> {
  const item = await prisma.shopWorkOrderItem.findUnique({
    where: { id: shopItemId },
    select: { id: true, parentItemId: true },
  });

  // Unknown item, or a child riding along with its parent: not this gate's call.
  if (!item) return { satisfied: true, attachmentCount: 0 };
  if (item.parentItemId) return { satisfied: true, attachmentCount: 0 };

  const attachmentCount = await prisma.attachment.count({
    where: {
      OR: [
        { shopItemId },
        { inspection: { shopItemId } },
      ],
    },
  });

  return attachmentCount > 0
    ? { satisfied: true, attachmentCount }
    : { satisfied: false, attachmentCount: 0, message: CONDEMN_EVIDENCE_MESSAGE };
}

/** Throwing form, for the transition paths. */
export async function assertCondemnEvidence(
  prisma: Pick<PrismaClient, 'attachment' | 'shopWorkOrderItem'>,
  shopItemId: string,
): Promise<void> {
  const result = await checkCondemnEvidence(prisma, shopItemId);
  if (!result.satisfied) {
    const err = new Error(result.message ?? CONDEMN_EVIDENCE_MESSAGE);
    err.name = 'CondemnEvidenceMissing';
    throw err;
  }
}
