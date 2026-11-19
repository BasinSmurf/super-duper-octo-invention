/**
 * printService.ts — printer selection + label-template lookup.
 *
 * Routing precedence lives here so the intake-label and reprint endpoints in
 * the shop-order route share one printer-resolution implementation.
 */

import { prisma } from '../db.js';
import type { Printer } from '../db.js';

const DEFAULT_TEMPLATE_NAME = 'ticket_default';

/**
 * Pick a printer for a site, master doc §9.6 precedence (the kiosk-origin
 * steps arrive with Phase 3):
 *   1. site + a printer whose defaultForStation matches `station`
 *   2. site + any active printer (first by name)
 * Returns null when the site has no usable printer — callers decide whether
 * that's a soft skip (auto-print) or a hard error (explicit print request).
 */
export async function resolvePrinter(
  siteId: string,
  station?: string | null,
): Promise<Printer | null> {
  if (station) {
    const stationMatch = await prisma.printer.findFirst({
      where: { siteId, active: true, defaultForStation: station },
      orderBy: { name: 'asc' },
    });
    if (stationMatch) return stationMatch;
  }
  return prisma.printer.findFirst({
    where: { siteId, active: true },
    orderBy: { name: 'asc' },
  });
}

/** The active label template used for shop work order labels. */
export function getDefaultTemplate() {
  return prisma.labelTemplate.findFirst({
    where: { name: DEFAULT_TEMPLATE_NAME, active: true },
  });
}
