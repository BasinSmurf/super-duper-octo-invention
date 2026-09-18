/**
 * One-time backfill: decode HTML entities in text imported from QuickBooks.
 *
 * Usage:
 *   npx tsx scripts/decode-html-entities.ts --dry-run   (report only)
 *   npx tsx scripts/decode-html-entities.ts             (apply)
 *
 * QB's item export encodes punctuation as HTML entities, and both import paths
 * stored it raw — so product names read "Breathing Air System Inspection &#151;
 * Primary" and "PEC Safeland &amp; H2S". Those names ride onto invoices, the QB
 * push and Enverus payloads.
 *
 * Both doors are now closed at the source (the qbXML item parse in
 * qbxmlBuilder.ts and the CSV import in routes/products.ts), so this pass is
 * only for rows that predate the fix. It is idempotent: decoded text no longer
 * matches the entity pattern, so a second run finds nothing.
 *
 * ticket_line_items.description is included because product names are COPIED
 * onto ticket lines at the time the line is added — fixing only the catalog
 * would leave already-written tickets, and the invoices built from them, wrong.
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { decodeHtmlEntities } from '../src/utils/htmlEntities.js';

const DRY_RUN = process.argv.includes('--dry-run');

/** Matches a numeric or named entity — the same shape the decoder handles. */
const ENTITY_SQL = `&(#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);`;

async function fixProducts() {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(
    `SELECT id, name FROM products WHERE name ~ '${ENTITY_SQL}' ORDER BY part_number`,
  );
  console.log(`\nproducts.name — ${rows.length} row(s) with entities`);

  let changed = 0;
  for (const row of rows) {
    const decoded = decodeHtmlEntities(row.name);
    if (decoded === row.name) {
      // An entity we deliberately don't map (unknown name, unassigned CP1252
      // slot). Report it rather than pretending it was handled.
      console.log(`  UNMAPPED  ${row.name}`);
      continue;
    }
    if (changed < 15) console.log(`  ${row.name}\n       -> ${decoded}`);
    if (!DRY_RUN) {
      await prisma.product.update({ where: { id: row.id }, data: { name: decoded } });
    }
    changed++;
  }
  if (changed > 15) console.log(`  … and ${changed - 15} more`);
  return changed;
}

async function fixTicketLineItems() {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; description: string }>>(
    `SELECT id, description FROM ticket_line_items WHERE description ~ '${ENTITY_SQL}'`,
  );
  console.log(`\nticket_line_items.description — ${rows.length} row(s) with entities`);

  let changed = 0;
  for (const row of rows) {
    const decoded = decodeHtmlEntities(row.description);
    if (decoded === row.description) {
      console.log(`  UNMAPPED  ${row.description}`);
      continue;
    }
    console.log(`  ${row.description}\n       -> ${decoded}`);
    if (!DRY_RUN) {
      await prisma.ticketLineItem.update({ where: { id: row.id }, data: { description: decoded } });
    }
    changed++;
  }
  return changed;
}

async function fixInvoiceLineItems() {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; description: string }>>(
    `SELECT id, description FROM invoice_line_items WHERE description ~ '${ENTITY_SQL}'`,
  );
  console.log(`\ninvoice_line_items.description — ${rows.length} row(s) with entities`);

  let changed = 0;
  for (const row of rows) {
    const decoded = decodeHtmlEntities(row.description);
    if (decoded === row.description) {
      console.log(`  UNMAPPED  ${row.description}`);
      continue;
    }
    console.log(`  ${row.description}\n       -> ${decoded}`);
    if (!DRY_RUN) {
      await prisma.invoiceLineItem.update({ where: { id: row.id }, data: { description: decoded } });
    }
    changed++;
  }
  return changed;
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN — nothing will be written' : 'APPLYING changes');

  const products = await fixProducts();
  const ticketLines = await fixTicketLineItems();
  const invoiceLines = await fixInvoiceLineItems();

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}:`);
  console.log(`  products.name:                  ${products}`);
  console.log(`  ticket_line_items.description:  ${ticketLines}`);
  console.log(`  invoice_line_items.description: ${invoiceLines}`);
  if (DRY_RUN) console.log('\nRe-run without --dry-run to apply.');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
