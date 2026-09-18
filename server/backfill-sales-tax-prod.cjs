/**
 * Backfill ND sales tax onto existing invoices — PROD container edition.
 *
 * The prod image prunes devDeps and ships only compiled `dist/` (no `src/`,
 * no `scripts/`, no tsx-resolvable TS), so the tsx script in scripts/ can't
 * run there. This is a CommonJS runner that require()s the already-compiled
 * dist modules, so it works in the live API container with plain `node` — no
 * rebuild needed. (For DEV, use scripts/backfill-invoice-sales-tax.ts via tsx.)
 *
 * Deploy + run (on the prod host, after `git pull` + rebuild + up):
 *   docker compose cp server/backfill-sales-tax-prod.cjs servicepro-api:/app/
 *   docker compose exec servicepro-api node /app/backfill-sales-tax-prod.cjs --dry-run
 *   docker compose exec servicepro-api node /app/backfill-sales-tax-prod.cjs
 *
 * Scope: only invoices still ours to change — draft / approved / queued.
 * Anything already in QB or finalized (invoiced/sent/paid/void) is left alone.
 */

const { prisma } = require('./dist/db.js');
const {
  resolveJurisdictionForCounty,
  getJurisdictionRate,
  countyFromTicketLocations,
  computeTaxAmount,
} = require('./dist/services/salesTax.js');

const DRY_RUN = process.argv.includes('--dry-run');
const BACKFILL_STATUSES = ['draft', 'approved', 'queued'];

async function main() {
  const invoices = await prisma.invoice.findMany({
    where: { status: { in: BACKFILL_STATUSES } },
    include: {
      company: { select: { taxExempt: true } },
      lineItems: { include: { product: { select: { isTaxable: true } } } },
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

    let county = null;
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

    // Shop WOs use the intake shop's configured rate; else location county.
    let jurisdiction = null;
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
          .filter(lu => lu.isTaxable !== inv.lineItems.find(li => li.id === lu.id).isTaxable)
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

main().catch(err => { console.error(err); process.exit(1); });
