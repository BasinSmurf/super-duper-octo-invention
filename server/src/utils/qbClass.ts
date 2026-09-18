import type { ServiceDivision } from '../db.js';
import { RENTAL_DEFAULT_DIVISION } from '../services/rentalComposition.js';

// The exact QuickBooks Class FullName strings, transcribed from QB's own Class
// list (2026-08-25). A ClassRef that doesn't match character-for-character is a
// hard reject — QB 3140, "invalid reference to QuickBooks Class" — so do not
// reformat, re-space or pluralize these. Note the inconsistencies are QB's own:
// D4 is "Services" but Dickinson4 is "Service", and D6 has spaces around its
// dash while nothing else does.
//
// Dickinson work bills to a sub-class of the "Dickinson" parent, hence the
// "Dickinson:" prefix. D7 and D8 have no Dickinson counterpart yet — those fall
// back to the base class rather than inventing a name QB would reject.
//
// D0 (Basin Integrated, with its Camp Road Prop / Jon Greiner sub-classes) is
// deliberately absent: it's the admin/holding class, not service revenue.
const QB_CLASS_MAP: Record<ServiceDivision, { base: string; dickinson: string | null }> = {
  D1: {
    base: 'D1 Basin Safety Training',
    dickinson: 'Dickinson:Dickinson1 Training',
  },
  D2: {
    base: 'D2 Basin Consulting',
    dickinson: 'Dickinson:Dickinson2 Consulting',
  },
  D3: {
    base: 'D3 Basin Safety Service',
    dickinson: 'Dickinson:Dickinson3 Safety Service',
  },
  D4: {
    base: 'D4 Basin On Site Services',
    dickinson: 'Dickinson:Dickinson4 On Site Service',
  },
  D5: {
    base: 'D5 Basin Safety Store',
    dickinson: 'Dickinson:Dickinson5 Store',
  },
  D6: {
    base: 'D6 - FEX Services',
    dickinson: 'Dickinson:Dickinson6 FEX',
  },
  D7: {
    base: 'D7 Sky Shield',
    dickinson: null,
  },
  D8: {
    base: 'D8 Occupational Health',
    dickinson: null,
  },
};

/** Every division we bill against, in QB Class order. */
export const SERVICE_DIVISIONS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'] as const;

export function isServiceDivision(val: unknown): val is ServiceDivision {
  return typeof val === 'string' && (SERVICE_DIVISIONS as readonly string[]).includes(val);
}

export function resolveQbClassFullName(
  division: ServiceDivision | null | undefined,
  isDickinson: boolean | null | undefined,
): string | null {
  if (!division) return null;
  const entry = QB_CLASS_MAP[division];
  if (!entry) return null;
  return (isDickinson && entry.dickinson) || entry.base;
}

// ---------------------------------------------------------------------------
// Work-type → division fallback
// ---------------------------------------------------------------------------
//
// The wizard only shows the DivisionSelector on the field-service / field-
// inspection step, so every other flow (IH testing, occ health, training,
// in-shop air fill) saved tickets with division = null — and a null division
// means no <ClassRef>, which is why QB invoices came out with a blank CLASS.
//
// For most work types the division isn't a judgement call at all, it's implied
// by the work: shop work is D6, rentals are D4, IH testing is field safety
// service (D3). Deriving it beats asking the tech to classify revenue.
//
// Returns null only when the work type says nothing about the division — the
// QBWC push logs a loud warning in that case rather than pushing a silently
// blank CLASS.
const SUBTYPE_DIVISION: Record<string, ServiceDivision> = {
  // Field Equipment Inspection is FEX (D6) work. In-shop air fill is NOT —
  // ADR-0017 bills it as safety service (D3). Note the parts-catalog facet puts
  // air refill on shelf 06; that's "which shelf", not revenue attribution.
  inspection: 'D6',
  air_fill: 'D3',
  // Tickets auto-generated when a Shop WO closes — the "location" is the shop.
  shop_repair: 'D6',
  // Occupational Health (D8): testing people, not equipment. Audiometric sits
  // under the legacy IH subtypes but is occ-health work, not field service.
  fit_test: 'D8',
  ih_audiometric: 'D8',
  safety_training: 'D1',
};

const TICKET_TYPE_DIVISION: Record<string, ServiceDivision> = {
  rental: RENTAL_DEFAULT_DIVISION,
  repair: 'D6',
  training: 'D1',
  // Counter/walk-in sales. Those post as SalesReceipts, which don't carry a
  // class today, but the ticket still records where the revenue belongs.
  sale: 'D5',
  // IH testing (ih_h2s / ih_o2_voc / ih_sampling) rides on `inspection`
  // tickets and bills as field safety service.
  inspection: 'D3',
  // Legacy field-service tickets created before the picker was mandatory.
  // D3 (Basin Safety Service) is the general field bucket.
  field_service: 'D3',
};

export function defaultDivisionForWork(work: {
  ticketType?: string | null;
  serviceSubtype?: string | null;
}): ServiceDivision | null {
  if (work.serviceSubtype && SUBTYPE_DIVISION[work.serviceSubtype]) {
    return SUBTYPE_DIVISION[work.serviceSubtype];
  }
  if (work.ticketType && TICKET_TYPE_DIVISION[work.ticketType]) {
    return TICKET_TYPE_DIVISION[work.ticketType];
  }
  return null;
}

/** Shop WO work is D6; the Dickinson shop splits onto the Dickinson class. */
export const DICKINSON_SITE_SHORT_CODE = 'DIC';
export const SHOP_DIVISION: ServiceDivision = 'D6';
