import { prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { assertCompanyActive, assertCompanyNotOnCreditHold } from '../utils/companyGuards.js';
import { selectBillingProfile } from './billingProfileSelector.js';
import { computeBillingGroupKey } from '../utils/billingGroupKey.js';

/** Apply the same customer correction rules to HTTP edits and offline edits. */
export async function prepareTicketCustomerChange(existing: any, data: any): Promise<void> {
  if (!data.companyId || data.companyId === existing.companyId) return;
  if (!['draft', 'dispatched', 'in_progress'].includes(existing.status)) {
    throw new AppError(409, 'Return the ticket to work before changing its customer');
  }
  await assertCompanyActive(data.companyId);
  await assertCompanyNotOnCreditHold(data.companyId);
  const rentalId = data.linkedRentalAgreementId === undefined ? existing.linkedRentalAgreementId : data.linkedRentalAgreementId;
  if (rentalId) {
    const rental = await prisma.rentalAgreement.findUnique({ where: { id: rentalId }, select: { companyId: true } });
    if (!rental || rental.companyId !== data.companyId) {
      throw new AppError(409, 'Rental agreement belongs to a different customer than this ticket');
    }
  }
  // Never carry another customer's billing profile or contact into invoicing.
  const profiles = await prisma.customerBillingProfile.findMany({
    where: { companyId: data.companyId, isActive: true }, orderBy: { effectiveFrom: 'desc' },
  });
  data.billingProfileId = selectBillingProfile(profiles, {
    ticketType: data.ticketType ?? existing.ticketType,
    division: data.division ?? existing.division,
    serviceDate: new Date(data.serviceDate ?? existing.serviceDate),
  })?.id ?? null;
  data.customerContactId = null;
  data.billingGroupKey = computeBillingGroupKey({ ...existing, ...data });
}
