import type { PrismaClient } from '../db.js';

export interface CustomerDescription {
  productId: string;
  qbItemListId: string;
  partNumber: string;
  standardName: string;
  standardDescription: string | null;
  description: string;
}

interface DescriptionLine {
  description: string;
  originalDescription?: string | null;
  qbItemListId?: string | null;
  qbSkip?: boolean;
  quantity?: unknown;
}

/** Only called when generating a new invoice. Edits and exports use its snapshot. */
export async function applyCustomerDescriptions(
  db: Pick<PrismaClient, 'company' | 'product'>, companyId: string | null, lines: DescriptionLine[],
): Promise<void> {
  if (!companyId || !lines.some(line => line.qbItemListId && !line.qbSkip && Number(line.quantity) !== 0)) return;
  const company = await db.company.findUnique({ where: { id: companyId }, select: { customerDescriptions: true } });
  const rules = (company?.customerDescriptions ?? []) as unknown as CustomerDescription[];
  if (!rules.length) return;
  const products = await db.product.findMany({
    where: { qbItemListId: { in: rules.map(rule => rule.qbItemListId) } },
    select: { qbItemListId: true, name: true, description: true },
  });
  for (const line of lines) {
    if (line.qbSkip || Number(line.quantity) === 0) continue; // documentation/attendee lines
    const rule = rules.find(candidate => candidate.qbItemListId === line.qbItemListId);
    if (!rule) continue;
    line.originalDescription = line.description;
    const product = products.find(candidate => candidate.qbItemListId === line.qbItemListId);
    line.description = resolveCustomerDescription(line.description, rule,
      [product?.name, product?.description]);
  }
}

/** Replace the catalog wording while retaining ticket prefixes, dates and serials.
 * If the generated text uses a custom label, retain it as context rather than
 * silently discard details we cannot safely separate from the item name.
 */
export function resolveCustomerDescription(
  original: string, rule: CustomerDescription, currentNames: Array<string | null | undefined> = [],
): string {
  const names = [rule.standardName, rule.standardDescription, ...currentNames]
    .filter((name): name is string => !!name?.trim())
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const index = original.toLowerCase().indexOf(name.toLowerCase());
    if (index !== -1) return original.slice(0, index) + rule.description + original.slice(index + name.length);
  }
  return original.trim() ? `${rule.description} — ${original}` : rule.description;
}
