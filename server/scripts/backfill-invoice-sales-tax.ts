/**
 * Backfill ND sales tax onto existing invoices.
 *
 * Usage: npx tsx scripts/backfill-invoice-sales-tax.ts [--dry-run]
 *
 * Scope: only invoices still ours to change — status draft / approved / queued.
 * Invoices already pushed to QB or finalized (invoiced/sent/paid/void) are left
 * alone; changing a number the customer/QB already has would be wrong.
 *
 * For each candidate it:
 *   1. Resolves the destination county from the invoice's source location
 *      (billing_group → tickets → well/pad/field; rental_agreement → location;
 *       shop_work_order → no county → ND state rate).
 *   2. Sets each line's isTaxable from the linked product's QB tax flag
 *      (product.isTaxable), preserving any line already flagged taxable.
 *      Tax-exempt customers force every line non-taxable.
 *   3. Snapshots the jurisdiction + rate and recomputes taxAmount + total.
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';
import {
  resolveJurisdictionForCounty,
  getJurisdictionRate,
  countyFromTicketLocations,
  computeTaxAmount,
} from '../src/services/salesTax.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BACKFILL_STATUSES = ['draft', 'approved', 'queued'] as const;

async function main() {
  const invoices = await prisma.invoice.findMany({
    where: { status: { in: BACKFILL_STATUSES as any } },
    include: {
      company: { select: { taxExempt: true } },
      lineItems: {
        include: { product: { select: { isTaxable: true } } },
      },
      billingGroup: {
        include: {
          tickets: {
            select: {
              well: { select: { county: true } },
              pad: { select: { county: true } },
              field: { select: { county: true } },
              facility: { select: { county: true } },
            },
          },
        },
      },
    },
  });

  console.log(`Found ${invoices.length} candidate invoice(s) in [${BACKFILL_STATUSES.join(', ')}].`);
  let updated = 0;
  let withTax = 0;

  for (const inv of invoices) {
    const exempt = inv.company?.taxExempt ?? false;

    // Resolve destination county.
    let county: string | null = null;
    if (inv.sourceType === 'billing_group' && inv.billingGroup) {
      county = inv.billingGroup.tickets.map(countyFromTicketLocations).find(Boolean) ?? null;
    } else if (inv.sourceType === 'rental_agreement' && inv.rentalAgreementId) {
      const rental = await prisma.rentalAgreement.findUnique({
        where: { id: inv.rentalAgreementId },
        include: {
          well: { select: { county: true } },
          pad: { select: { county: true } },
          field: { select: { county: true } },
          facility: { select: { county: true } },
        },
      });
      county = rental ? countyFromTicketLocations(rental) : null;
    }

    // Resolve jurisdiction: shop WOs use the intake shop's configured rate;
    // everything else uses the location county (ND state fallback).
    let jurisdiction: { id: string; rate: number } | null = null;
    if (!exempt) {
      if (inv.sourceType === 'shop_work_order' && inv.shopWorkOrderId) {
        const wo = await prisma.shopWorkOrder.findUnique({
          where: { id: inv.shopWorkOrderId },
          select: { intakeSite: { select: { salesTaxJurisdictionId: true } } },
        });
        jurisdiction = (await getJurisdictionRate(wo?.intakeSite?.salesTaxJurisdictionId))
          ?? (await resolveJurisdictionForCounty(null));
      } else {
        jurisdiction = await resolveJurisdictionForCounty(county);
      }
    }
    const taxRate = jurisdiction?.rate ?? 0;

    // Re-derive per-line taxability: product QB flag, never downgrading a line
    // already marked taxable (e.g. shop-WO parts).
    const lineUpdates = inv.lineItems.map(li => ({
      id: li.id,
      isTaxable: exempt ? false : (li.isTaxable || (li.product?.isTaxable ?? false)),
      amount: Number(li.amount),
    }));

    const taxAmount = computeTaxAmount(lineUpdates, taxRate);
    const subtotal = Number(inv.subtotal);
    const total = subtotal + taxAmount;

    if (taxAmount > 0) withTax++;

    console.log(
      `  ${inv.invoiceNumber} [${inv.sourceType}] county=${county ?? '—'} ` +
      `→ ${jurisdiction?.id ?? 'none'} @ ${(taxRate * 100).toFixed(2)}% ` +
      `tax=$${taxAmount.toFixed(2)}${exempt ? ' (EXEMPT)' : ''}`,
    );

    if (!DRY_RUN) {
      await prisma.$transaction([
        ...lineUpdates
          .filter(lu => lu.isTaxable !== inv.lineItems.find(li => li.id === lu.id)!.isTaxable)
          .map(lu => prisma.invoiceLineItem.update({ where: { id: lu.id }, data: { isTaxable: lu.isTaxable } })),
        prisma.invoice.update({
          where: { id: inv.id },
          data: { taxJurisdictionId: jurisdiction?.id ?? null, taxRate, taxAmount, total },
        }),
      ]);
      updated++;
    }
  }

  console.log(
    `\n${DRY_RUN ? '[dry-run] would update' : 'Updated'} ${DRY_RUN ? invoices.length : updated} invoice(s); ` +
    `${withTax} carry non-zero tax.`,
  );
  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
