/**
 * Service → QB Part Number Mapping
 *
 * QuickBooks is the source of truth for part numbers; this tells the system
 * which QB product to auto-fill when a line type is added to a ticket.
 *
 * LABOR AND MILEAGE FOLLOW THE TICKET'S DIVISION. Under the 2026 numbering
 * scheme every division has fixed part numbers — [DIV]00001 is always that
 * division's Mileage and [DIV]00002 is always its Labor — so D3 field service
 * bills 0300001 / 0300002, occ health bills 0800001 / 0800002, and so on down.
 * Use getMileageProduct() / getLaborProduct() with the division; they only fall
 * back to the legacy flat numbers (101 / 406) when a division's pair hasn't
 * been pulled from QB into this environment's catalog yet.
 *
 * The static map below is that fallback, plus the handful of one-off service
 * fees that aren't division-scoped.
 *
 * Rules:
 *   1. Most specific match wins: (ticketType + serviceSubtype + lineType)
 *   2. Then ticketType + lineType
 *   3. Then wildcard ('*') + lineType
 *   4. null = no default (tech must pick a product manually)
 */

import { prisma } from '../db.js';
import { divisionLaborPartNumber, divisionMileagePartNumber, divisionNumber } from './partNumber.js';
import type { ServiceDivision } from '../db.js';

// ── Static mapping ──────────────────────────────────────────────

interface PartMapEntry {
  ticketType: string;   // e.g. 'field_service', 'rental', '*'
  lineType: string;     // e.g. 'labor', 'travel', 'part'
  serviceSubtype?: string; // e.g. 'fit_test' — optional for more specific match
  partNumber: string;   // QB part number
}

// Pre-renumber flat part numbers. Only reached when a division's own pair
// isn't in the catalog yet.
const LEGACY_LABOR_PART = '406';
const LEGACY_MILEAGE_PART = '101';

const SERVICE_PART_MAP: PartMapEntry[] = [
  // ── Training / Fit Test (most specific — subtype match) ──
  { ticketType: 'training', lineType: 'fit_test', serviceSubtype: 'fit_test', partNumber: '11009' },

  // ── Field Service ──
  { ticketType: 'field_service', lineType: 'labor',    partNumber: '406' },
  { ticketType: 'field_service', lineType: 'travel',   partNumber: '101' },

  // ── Shop Service ──
  { ticketType: 'repair',        lineType: 'labor',    partNumber: '406' },

  // ── Rental ──
  { ticketType: 'rental',        lineType: 'labor',    partNumber: '406' },
  { ticketType: 'rental',        lineType: 'travel',   partNumber: '101' },

  // ── Inspection ──
  { ticketType: 'inspection',    lineType: 'labor',    partNumber: '406' },
  { ticketType: 'inspection',    lineType: 'travel',   partNumber: '101' },

  // ── Wildcard fallbacks (any ticket type) ──
  { ticketType: '*', lineType: 'labor',    partNumber: '406' },
  { ticketType: '*', lineType: 'travel',   partNumber: '101' },
  { ticketType: '*', lineType: 'fit_test', partNumber: '11009' },
];

// ── Lookup function ──────────────────────────────────────────────

/**
 * Resolve the default QB part number for a given ticket + line combination.
 *
 * @returns The QB part number string, or null if no default exists
 *          (e.g. for 'part' line type — tech picks their own product).
 */
export function getDefaultPartNumber(
  ticketType: string,
  lineType: string,
  serviceSubtype?: string,
): string | null {
  // Priority 1: exact match with serviceSubtype
  if (serviceSubtype) {
    const exact = SERVICE_PART_MAP.find(
      e => e.ticketType === ticketType && e.lineType === lineType && e.serviceSubtype === serviceSubtype,
    );
    if (exact) return exact.partNumber;
  }

  // Priority 2: ticketType + lineType (no subtype constraint)
  const byType = SERVICE_PART_MAP.find(
    e => e.ticketType === ticketType && e.lineType === lineType && !e.serviceSubtype,
  );
  if (byType) return byType.partNumber;

  // Priority 3: wildcard ticketType
  const wildcard = SERVICE_PART_MAP.find(
    e => e.ticketType === '*' && e.lineType === lineType && !e.serviceSubtype,
  );
  if (wildcard) return wildcard.partNumber;

  return null;
}

// ── DB lookup ────────────────────────────────────────────────────

export interface ServiceProductInfo {
  id: string;
  partNumber: string;
  name: string;
  defaultSellPrice: number | null;
  unitOfMeasure: string | null;
  qbItemListId: string | null;
  qbItemFullName: string | null;
}

/**
 * Resolve the default product record from the DB for a given combination.
 * Returns null if no mapping exists or the product isn't in the DB.
 */
export async function getDefaultProduct(
  ticketType: string,
  lineType: string,
  serviceSubtype?: string,
): Promise<ServiceProductInfo | null> {
  const partNumber = getDefaultPartNumber(ticketType, lineType, serviceSubtype);
  if (!partNumber) return null;

  const product = await loadProductByPartNumber(partNumber);
  if (!product) {
    console.warn(`[servicePartMap] Product not found in DB for part number "${partNumber}" (ticketType=${ticketType}, lineType=${lineType}, serviceSubtype=${serviceSubtype ?? 'none'})`);
  }
  return product;
}

async function loadProductByPartNumber(partNumber: string): Promise<ServiceProductInfo | null> {
  const product = await prisma.product.findFirst({
    where: { partNumber },
    select: {
      id: true,
      partNumber: true,
      name: true,
      defaultSellPrice: true,
      unitOfMeasure: true,
      qbItemListId: true,
      qbItemFullName: true,
    },
  });
  if (!product) return null;

  return {
    id: product.id,
    partNumber: product.partNumber,
    name: product.name,
    defaultSellPrice: product.defaultSellPrice ? parseFloat(product.defaultSellPrice.toString()) : null,
    unitOfMeasure: product.unitOfMeasure,
    qbItemListId: product.qbItemListId,
    qbItemFullName: product.qbItemFullName,
  };
}

// ── Division-scoped labor & mileage ──────────────────────────────

async function divisionScopedProduct(
  kind: 'labor' | 'mileage',
  division: ServiceDivision | number | null | undefined,
  legacyPartNumber: string,
): Promise<ServiceProductInfo | null> {
  const n = divisionNumber(division);

  if (n != null) {
    const partNumber = kind === 'labor' ? divisionLaborPartNumber(n) : divisionMileagePartNumber(n);
    const scoped = await loadProductByPartNumber(partNumber);
    if (scoped) return scoped;
    console.warn(
      `[servicePartMap] D${n} has no ${kind} part ${partNumber} in the catalog — ` +
      `falling back to legacy ${legacyPartNumber}. Pull parts from QB to pick it up.`,
    );
  }

  return loadProductByPartNumber(legacyPartNumber);
}

/** The division's Labor product ([DIV]00002), legacy 406 until it exists. */
export function getLaborProduct(division: ServiceDivision | number | null | undefined) {
  return divisionScopedProduct('labor', division, LEGACY_LABOR_PART);
}

/** The division's Mileage product ([DIV]00001), legacy 101 until it exists. */
export function getMileageProduct(division: ServiceDivision | number | null | undefined) {
  return divisionScopedProduct('mileage', division, LEGACY_MILEAGE_PART);
}

// ── Bulk defaults (for the API endpoint) ─────────────────────────

/**
 * Returns a map of lineType → resolved product for the common defaults.
 * Used by GET /api/products/defaults so the client can auto-fill.
 *
 * Labor and mileage follow the division ([DIV]00002 / [DIV]00001); fit test is
 * a flat service fee with no division variant.
 */
export async function getAllDefaults(division?: number | null): Promise<Record<string, ServiceProductInfo>> {
  const results: Record<string, ServiceProductInfo> = {};

  const [labor, travel, fitTest] = await Promise.all([
    getLaborProduct(division),
    getMileageProduct(division),
    getDefaultProduct('training', 'fit_test', 'fit_test'),
  ]);

  if (labor) results.labor = labor;
  if (travel) results.travel = travel;
  if (fitTest) results.fit_test = fitTest;

  return results;
}
