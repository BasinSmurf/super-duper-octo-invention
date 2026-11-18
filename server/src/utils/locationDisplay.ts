import { prisma } from '../db.js';

/**
 * Build a human-readable location display string.
 * Format: "Company > Field > Pad > Well"
 * Skips any null/missing levels.
 */
export async function buildLocationDisplay(ids: {
  companyId?: string | null;
  fieldId?: string | null;
  padId?: string | null;
  wellId?: string | null;
}): Promise<string | undefined> {
  if (!ids.companyId) return undefined;

  const parts: string[] = [];

  if (ids.companyId) {
    const co = await prisma.company.findUnique({ where: { id: ids.companyId }, select: { name: true } });
    if (co) parts.push(co.name);
  }
  if (ids.fieldId) {
    const f = await prisma.field.findUnique({ where: { id: ids.fieldId }, select: { name: true } });
    if (f) parts.push(f.name);
  }
  if (ids.padId) {
    const p = await prisma.pad.findUnique({ where: { id: ids.padId }, select: { name: true } });
    if (p) parts.push(p.name);
  }
  if (ids.wellId) {
    const w = await prisma.well.findUnique({ where: { id: ids.wellId }, select: { wellName: true } });
    if (w && w.wellName) parts.push(w.wellName);
  }

  return parts.length > 0 ? parts.join(' > ') : undefined;
}
