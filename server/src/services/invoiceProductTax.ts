import type { PrismaClient } from '../db.js';

interface TaxLine {
  productId?: string | null;
  qbItemListId?: string | null;
  partNumber?: string | null;
  isTaxable: boolean;
}

/** Snapshot catalog tax defaults when generating an invoice, before totals.
 * Saved invoice lines and explicit edits remain independent of later catalog pulls.
 */
export async function applyInvoiceProductTax(
  db: Pick<PrismaClient, 'product'>, lines: TaxLine[], taxExempt: boolean,
): Promise<void> {
  if (taxExempt) { for (const line of lines) line.isTaxable = false; return; }
  const ids = [...new Set(lines.flatMap(line => line.productId ? [line.productId] : []))];
  const qbIds = [...new Set(lines.flatMap(line => line.qbItemListId ? [line.qbItemListId] : []))];
  const parts = [...new Set(lines.flatMap(line => line.partNumber ? [line.partNumber] : []))];
  if (!ids.length && !qbIds.length && !parts.length) return;
  const products = await db.product.findMany({
    where: { OR: [{ id: { in: ids } }, { qbItemListId: { in: qbIds } }, { partNumber: { in: parts } }] },
    select: { id: true, qbItemListId: true, partNumber: true, isTaxable: true },
  });
  for (const line of lines) {
    const product = products.find(p => line.productId && p.id === line.productId)
      || products.find(p => line.qbItemListId && p.qbItemListId === line.qbItemListId)
      || products.find(p => line.partNumber && p.partNumber === line.partNumber);
    if (typeof product?.isTaxable === 'boolean') line.isTaxable = product.isTaxable;
  }
}
