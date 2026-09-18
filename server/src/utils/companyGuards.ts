import { prisma } from '../index.js';
import { Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Block creating new work (tickets, rentals, shop work orders) against an
 * inactive customer. The customer picker already hides inactive companies, but
 * this is the server-side backstop for stale offline caches, direct API calls,
 * and customers deactivated after a tech selected them.
 *
 * Accepts an optional transaction client so callers inside a `prisma.$transaction`
 * (e.g. shop-work-order creation) share the same transaction; defaults to the
 * global client for plain route handlers.
 *
 * Throws 409 when the company is inactive, 404 when it does not exist. A missing
 * companyId is left to each caller's own required-field validation.
 */
export async function assertCompanyActive(
  companyId: string | undefined | null,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  if (!companyId) return;
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, isActive: true, name: true },
  });
  if (!company) throw new AppError(404, 'Customer not found');
  if (!company.isActive) {
    throw new AppError(
      409,
      `${company.name} is inactive — reactivate the customer to create new work.`,
    );
  }
}

/**
 * The single user-facing credit-hold message. Field staff and shop hands see
 * this verbatim, in the banner and in the API error, so the block always reads
 * the same wherever it lands.
 */
export const CREDIT_HOLD_MESSAGE =
  'Customer on credit hold. Please contact Accounts Receivable to resolve.';

/**
 * Block work against a customer AR has put on credit hold.
 *
 * Used on the two paths the hold governs: creating new tickets, and returning
 * equipment to the customer out of a shop work order. Shop-order INTAKE is
 * intentionally not gated — gear can still come in, it just can't go back out.
 *
 * Like assertCompanyActive, this is the server-side backstop; the wizard and
 * the shop WO page surface the same message up front so nobody gets here by
 * surprise. Throws 409 so the client can distinguish it from a validation
 * error. A missing companyId is left to each caller's required-field checks.
 */
export async function assertCompanyNotOnCreditHold(
  companyId: string | undefined | null,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  if (!companyId) return;
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, creditHold: true },
  });
  if (!company) throw new AppError(404, 'Customer not found');
  if (company.creditHold) throw new AppError(409, CREDIT_HOLD_MESSAGE);
}

/**
 * Credit-hold guard for shop work orders, resolving the customer from the WO.
 * Guards every path that hands equipment back: single-item -> returned,
 * bulk-return, and release/pickup.
 *
 * force-close is deliberately NOT guarded — it is the permission-gated,
 * reason-required supervisor override, i.e. the intended escape hatch when a
 * manager decides gear ships regardless of the hold.
 */
export async function assertShopReturnAllowed(
  workOrderId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  const wo = await db.shopWorkOrder.findUnique({
    where: { id: workOrderId },
    select: { companyId: true },
  });
  if (!wo) throw new AppError(404, 'Shop work order not found');
  await assertCompanyNotOnCreditHold(wo.companyId, db);
}
