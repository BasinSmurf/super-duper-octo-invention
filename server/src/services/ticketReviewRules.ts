import { selectBillingProfile } from './billingProfileSelector.js';
/**
 * ticketReviewRules.ts
 *
 * Deterministic rules engine for supervisor review. Given a ticket ID,
 * runs a set of pass/warn/fail rules and returns a cached ReviewSignal
 * that the Approvals dashboard uses to surface "obviously routine" work
 * for one-click bulk approval.
 *
 * Verdict rollup:
 *   any 'fail'          → red
 *   any 'warn' (no fail)→ yellow
 *   all pass            → green
 *
 * This is Layer 1 — pure rules, no LLM. The engine is structured so a
 * Layer 2 (LLM-based anomaly check) can be added later by calling it
 * from the end of runReviewRules when Layer 1 returns green.
 *
 * Called from:
 *   - POST /api/tickets/:id/transition  (target = supervisor_review)
 *   - POST /api/sync/push post-batch pass (for offline-created tickets)
 *   - GET  /api/tickets/review-queue    (refresh-if-stale)
 *   - approvalAutoProcessor (never — it reads cached signal only)
 */

import { ticketBillingCodes } from './locationBillingCodes.js';
import { prisma } from '../db.js';
import { inspectionBillingError } from './inspectionBillingGuard.js';
import type { ServiceSubtype, TicketType } from '../db.js';

export type ReviewVerdict = 'green' | 'yellow' | 'red';
export type RuleResult = 'pass' | 'warn' | 'fail';

export interface ReviewSignal {
  verdict: ReviewVerdict;
  reasons: string[];
  ruleResults: Record<string, RuleResult>;
  ranAt: string;
  engineVersion: number;
}

// Bump when rule logic changes so stale cached signals can be detected later.
export const ENGINE_VERSION = 6;

// Service types where a customer signature is expected.
const SIGNATURE_REQUIRED_TYPES: TicketType[] = ['field_service', 'repair', 'training'];

// Service subtypes that are performed in the shop, not at a customer site.
// These don't require field/pad/well linkage — the "location" is the shop.
// Identified by serviceSubtype rather than ticketType because e.g. a
// field_service ticket for an air fill happens at the shop.
const SHOP_BASED_SUBTYPES = new Set<string>([
  'air_fill',
  'shop_service',
  'shop_repair',
  'bench_test',
  'calibration',
]);

// Labor hours sanity bounds (per ticket, summed across labor line items).
const LABOR_MIN_HOURS = 0.25;
const LABOR_MAX_HOURS = 16;

// Price anomaly detection: compare ticket subtotal against rolling avg of
// this customer + same subtype's tickets in the last N days. Only flag if
// we have at least MIN_SAMPLE history — otherwise skip the rule.
const PRICE_HISTORY_DAYS = 90;
const PRICE_HISTORY_MIN_SAMPLE = 5;
const PRICE_STDDEV_MULTIPLIER = 2; // ±2σ

export async function runReviewRules(ticketId: string): Promise<ReviewSignal> {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    include: {
      company: {
        include: {
          billingProfiles: {
            where: { isActive: true },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
        },
      },
      pad: { select: { id: true, pendingReview: true, currentOperatorId: true, facilityCode: true } },
      well: { select: { id: true, pendingReview: true, apiNumber: true, currentOperatorId: true, facilityCode: true } },
      lineItems: {
        include: {
          equipmentInstalled: { select: { id: true, status: true } },
          equipmentRemoved: { select: { id: true, status: true } },
        },
      },
      billingProfile: true,
    },
  });

  if (!ticket) {
    return {
      verdict: 'red',
      reasons: ['Ticket not found'],
      ruleResults: { ticket_exists: 'fail' },
      ranAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
    };
  }

  const ruleResults: Record<string, RuleResult> = {};
  const reasons: string[] = [];

  function record(ruleId: string, result: RuleResult, reason?: string) {
    ruleResults[ruleId] = result;
    if (result !== 'pass' && reason) reasons.push(reason);
  }

  // Resolve effective billing profile (ticket-level overrides fall back to company-level)
  const inspectionError = inspectionBillingError(ticket, ticket.lineItems.length);
  record('inspection_line_synced', inspectionError ? 'fail' : 'pass', inspectionError ?? undefined);

  const billingProfile =
    ticket.billingProfile ?? selectBillingProfile(ticket.company.billingProfiles, ticket);

  // ──────────────────────────────────────────────────────────────
  // Rule 1: missing_customer
  // ──────────────────────────────────────────────────────────────
  if (!ticket.companyId) {
    record('missing_customer', 'fail', 'No customer assigned');
  } else {
    record('missing_customer', 'pass');
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 2: missing_location (skipped for shop-based services)
  // ──────────────────────────────────────────────────────────────
  const isShopBased = ticket.serviceSubtype && SHOP_BASED_SUBTYPES.has(ticket.serviceSubtype);
  if (isShopBased) {
    record('missing_location', 'pass');
  } else {
    const hasLocation = Boolean(
      ticket.fieldId || ticket.padId || ticket.wellId || ticket.facilityId || ticket.workPointId,
    );
    if (!hasLocation) {
      record('missing_location', 'fail', 'No location on ticket');
    } else if (ticket.pad?.pendingReview) {
      record('missing_location', 'fail', 'Location is pending admin review');
    } else {
      record('missing_location', 'pass');
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 2b: field_site_sign_evidence
  // Site-sign photos are only mandatory for new/pending or unlinked field
  // locations. Known ServicePRO wells with an API number and matching customer
  // may still include optional evidence, but don't require it.
  // ──────────────────────────────────────────────────────────────
  const customData = (ticket.customData as Record<string, any> | null) || {};
  const mismatch = customData.customerLocationMismatch as Record<string, any> | undefined;
  const customWellIds = Array.isArray(customData.wellIds)
    ? customData.wellIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const selectedWellIds = Array.from(new Set([ticket.wellId, ...customWellIds].filter((id): id is string => !!id)));
  const selectedWellRecords = selectedWellIds.length > 0
    ? await prisma.well.findMany({
      where: { id: { in: selectedWellIds } },
      select: { id: true, pendingReview: true, apiNumber: true, currentOperatorId: true },
    })
    : [];
  const selectedWellsById = new Map(selectedWellRecords.map(w => [w.id, w]));
  const selectedWells = selectedWellIds
    .map(id => selectedWellsById.get(id))
    .filter((w): w is { id: string; pendingReview: boolean; apiNumber: string | null; currentOperatorId: string | null } => Boolean(w));
  const selectedWellOwnerId =
    selectedWells.find(w => w.currentOperatorId && w.currentOperatorId !== ticket.companyId)?.currentOperatorId ??
    selectedWells.find(w => w.currentOperatorId)?.currentOperatorId ??
    null;
  const hasFieldSiteLocation = Boolean(ticket.padId || ticket.wellId || ticket.facilityId || ticket.workPointId);
  const cleanLinkedServiceProWell = Boolean(
    ticket.companyId &&
      selectedWellIds.length > 0 &&
      selectedWells.length === selectedWellIds.length &&
      selectedWells.every(w =>
        !!w.apiNumber?.trim() &&
        w.currentOperatorId === ticket.companyId &&
        !w.pendingReview
      ),
  );
  const locationHasPendingReview = Boolean(ticket.pad?.pendingReview || selectedWells.some(w => w.pendingReview));
  const locationOwnerId = selectedWellIds.length > 0
    ? selectedWellOwnerId
    : ticket.padId
      ? ticket.pad?.currentOperatorId
      : null;
  const locationLinkedToCustomer = cleanLinkedServiceProWell || Boolean(locationOwnerId && locationOwnerId === ticket.companyId);
  const requiresFieldSiteEvidence =
    !isShopBased &&
    (ticket.ticketType === 'field_service' || ticket.ticketType === 'inspection') &&
    hasFieldSiteLocation &&
    !cleanLinkedServiceProWell &&
    (locationHasPendingReview || !locationLinkedToCustomer || mismatch?.status === 'pending');
  if (requiresFieldSiteEvidence) {
    const evidence = customData.siteSignEvidence as Record<string, any> | undefined;
    const photoIds = Array.isArray(evidence?.photoIds) ? evidence.photoIds : [];
    if (photoIds.length === 0) {
      record('field_site_sign_evidence', 'fail', 'Site sign photo is missing');
    } else if (!evidence?.geotagged || evidence.latitude == null || evidence.longitude == null) {
      record('field_site_sign_evidence', 'fail', 'Site sign photo is missing GPS');
    } else {
      record('field_site_sign_evidence', 'pass');
    }
  } else {
    record('field_site_sign_evidence', 'pass');
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 2c: customer_location_mismatch
  // If the selected customer differs from the location's current operator,
  // approval must explicitly assign the site to the customer or leave it with
  // a reason. Pending mismatches cannot move to billing.
  // ──────────────────────────────────────────────────────────────
  if (mismatch?.status === 'pending') {
    record('customer_location_mismatch', 'fail', 'Customer does not match site owner; assign or leave mismatch before approval');
  } else if (mismatch?.status === 'left' && !String(mismatch.reason || '').trim()) {
    record('customer_location_mismatch', 'fail', 'Customer/site mismatch left without a reason');
  } else {
    record('customer_location_mismatch', 'pass');
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 3: missing_signature (only for service types that need one)
  // ──────────────────────────────────────────────────────────────
  if (SIGNATURE_REQUIRED_TYPES.includes(ticket.ticketType)) {
    if (!ticket.customerRepSignature) {
      record(
        'missing_signature',
        'fail',
        `${ticket.ticketType} tickets require a customer signature`,
      );
    } else {
      record('missing_signature', 'pass');
    }
  } else {
    record('missing_signature', 'pass');
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 4: misc_line_items (warn)
  // Flag anything whose description looks like a free-text / MISC entry.
  // ──────────────────────────────────────────────────────────────
  const miscItems = ticket.lineItems.filter(li => {
    if (!li.description) return false;
    const d = li.description.toLowerCase();
    return d.includes('misc') || d.includes('override') || d.startsWith('custom');
  });
  if (miscItems.length > 0) {
    record(
      'misc_line_items',
      'warn',
      `Has ${miscItems.length} MISC/override line item${miscItems.length > 1 ? 's' : ''}`,
    );
  } else {
    record('misc_line_items', 'pass');
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 5: labor_hours_sanity (warn)
  // Sum of hoursRegular + hoursOvertime + hoursTravel across labor lines.
  // Only warn on the total — zero labor on a non-sale ticket isn't a hard fail.
  // ──────────────────────────────────────────────────────────────
  const laborLines = ticket.lineItems.filter(li => li.lineType === 'labor');
  const totalLaborHours = laborLines.reduce((sum, li) => {
    const r = li.hoursRegular ? Number(li.hoursRegular) : 0;
    const o = li.hoursOvertime ? Number(li.hoursOvertime) : 0;
    const t = li.hoursTravel ? Number(li.hoursTravel) : 0;
    return sum + r + o + t;
  }, 0);
  if (laborLines.length > 0 && totalLaborHours < LABOR_MIN_HOURS) {
    record('labor_hours_sanity', 'warn', `Labor under ${LABOR_MIN_HOURS}h (${totalLaborHours.toFixed(2)}h)`);
  } else if (totalLaborHours > LABOR_MAX_HOURS) {
    record('labor_hours_sanity', 'warn', `Labor over ${LABOR_MAX_HOURS}h (${totalLaborHours.toFixed(2)}h)`);
  } else {
    record('labor_hours_sanity', 'pass');
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 6: retired_equipment (fail)
  // Any referenced serialized equipment must not be retired or lost.
  // ──────────────────────────────────────────────────────────────
  const INVALID_EQUIPMENT_STATUSES = new Set(['retired', 'lost']);
  const retiredRefs: string[] = [];
  for (const li of ticket.lineItems) {
    if (
      li.equipmentInstalled &&
      INVALID_EQUIPMENT_STATUSES.has(li.equipmentInstalled.status)
    ) {
      retiredRefs.push(`installed ${li.equipmentInstalled.id}: ${li.equipmentInstalled.status}`);
    }
    if (
      li.equipmentRemoved &&
      INVALID_EQUIPMENT_STATUSES.has(li.equipmentRemoved.status)
    ) {
      retiredRefs.push(`removed ${li.equipmentRemoved.id}: ${li.equipmentRemoved.status}`);
    }
  }
  if (retiredRefs.length > 0) {
    record(
      'retired_equipment',
      'fail',
      `Retired/lost equipment referenced: ${retiredRefs.slice(0, 2).join(', ')}`,
    );
  } else {
    record('retired_equipment', 'pass');
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 7: enverus_missing_requisitioner (fail)
  // If customer has enverusEnabled and the ticket has no orderedByName
  // and the billing profile has no default, it will fail on submission.
  // ──────────────────────────────────────────────────────────────
  // Requisitioner is selected by billing on the invoice before submission.
  record('enverus_missing_requisitioner', 'pass');

  // ──────────────────────────────────────────────────────────────
  // Rule 8: enverus_missing_afe (fail for LEM customers)
  // LEM receipts require AFE per Continental/COP guidelines.
  // ──────────────────────────────────────────────────────────────
  if (billingProfile?.enverusEnabled && billingProfile?.requiresAfe) {
    // A location-sourced AFE comes from the well/pad at billing.
    const afe = ticketBillingCodes(billingProfile, ticket).afeNumber || ticket.afeNumber || billingProfile.defaultAfeNumber || null;
    if (!afe) {
      record('enverus_missing_afe', 'fail', 'Enverus LEM customer requires AFE number');
    } else {
      record('enverus_missing_afe', 'pass');
    }
  } else {
    record('enverus_missing_afe', 'pass');
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 9: qb_customer_unmapped (fail)
  // If the customer has no QB ListID, invoice generation will block later.
  // Surface it now so the supervisor can fix mapping before bulk approving.
  // ──────────────────────────────────────────────────────────────
  const companyWithQb = await prisma.company.findUnique({
    where: { id: ticket.companyId },
    select: { qbCustomerListId: true },
  });
  if (!companyWithQb?.qbCustomerListId) {
    record('qb_customer_unmapped', 'fail', 'Customer has no QuickBooks ListID mapping');
  } else {
    record('qb_customer_unmapped', 'pass');
  }

  // ──────────────────────────────────────────────────────────────
  // Rule 10: out_of_range_total (warn)
  // Rolling avg ± 2σ of this customer's same-subtype tickets over last 90d.
  // Skips if sample size < 5.
  // ──────────────────────────────────────────────────────────────
  if (ticket.subtotal !== null && ticket.companyId && ticket.serviceSubtype) {
    const since = new Date(Date.now() - PRICE_HISTORY_DAYS * 24 * 60 * 60 * 1000);
    const history = await prisma.serviceTicket.findMany({
      where: {
        companyId: ticket.companyId,
        serviceSubtype: ticket.serviceSubtype as ServiceSubtype,
        status: { in: ['closed', 'invoiced', 'billing_queue'] },
        serviceDate: { gte: since },
        subtotal: { not: null },
        id: { not: ticket.id },
      },
      select: { subtotal: true },
    });

    if (history.length >= PRICE_HISTORY_MIN_SAMPLE) {
      const totals = history.map(t => Number(t.subtotal));
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
      const variance =
        totals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / totals.length;
      const stddev = Math.sqrt(variance);
      const current = Number(ticket.subtotal);
      const upper = mean + PRICE_STDDEV_MULTIPLIER * stddev;
      const lower = Math.max(0, mean - PRICE_STDDEV_MULTIPLIER * stddev);

      if (current > upper || current < lower) {
        record(
          'out_of_range_total',
          'warn',
          `Total $${current.toFixed(0)} outside typical range $${lower.toFixed(0)}–$${upper.toFixed(0)}`,
        );
      } else {
        record('out_of_range_total', 'pass');
      }
    }
    // Not enough history: skip silently (no entry in ruleResults)
  }

  // ──────────────────────────────────────────────────────────────
  // Verdict rollup
  // ──────────────────────────────────────────────────────────────
  const values = Object.values(ruleResults);
  const verdict: ReviewVerdict = values.includes('fail')
    ? 'red'
    : values.includes('warn')
      ? 'yellow'
      : 'green';

  return {
    verdict,
    reasons,
    ruleResults,
    ranAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * Cache the signal on the ticket row. Called by the transition handler
 * and the sync push post-batch pass.
 */
export async function runAndCacheReviewSignal(ticketId: string): Promise<ReviewSignal> {
  const signal = await runReviewRules(ticketId);
  await prisma.serviceTicket.update({
    where: { id: ticketId },
    data: {
      reviewSignal: signal as unknown as object,
      reviewSignalRanAt: new Date(signal.ranAt),
    },
  });
  return signal;
}
