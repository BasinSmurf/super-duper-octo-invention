import type { prisma as database } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { invoiceApprovalProfile, profileForBillingWork } from './billingApprovalGroups.js';

type Database = Pick<typeof database, 'customerBillingProfile' | 'serviceTicket'>;
export interface InvoiceProfileSource {
  companyId: string;
  billingProfileId?: string | null;
  division?: string | null;
  invoiceDate?: Date;
  lineItems?: { sourceTicketId?: string | null }[];
}

/** Bound profiles survive batching/retries; legacy invoices resolve from their source tickets. */
export async function resolveInvoiceBillingProfile(db: Database, invoice: InvoiceProfileSource) {
  const profiles = await db.customerBillingProfile.findMany({ where: { companyId: invoice.companyId, isActive: true } });
  if (invoice.billingProfileId) {
    const bound = profiles.find(profile => profile.id === invoice.billingProfileId);
    if (!bound) throw new AppError(400, 'The invoice billing profile is no longer active for this customer');
    return bound;
  }
  const ids = [...new Set((invoice.lineItems || []).map(line => line.sourceTicketId).filter((id): id is string => !!id))];
  if (ids.length) {
    const tickets = await db.serviceTicket.findMany({ where: { id: { in: ids } }, select: {
      billingProfileId: true, ticketType: true, serviceSubtype: true, division: true, serviceDate: true, customData: true,
      ihTestRecords: { select: { testType: true } },
    } });
    if (tickets.length !== ids.length) throw new AppError(400, 'Cannot resolve all source tickets for this invoice');
    return invoiceApprovalProfile(profiles, tickets);
  }
  return profileForBillingWork(profiles, { division: invoice.division, serviceDate: invoice.invoiceDate });
}
