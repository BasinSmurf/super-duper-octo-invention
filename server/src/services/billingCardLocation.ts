import type { PrismaClient } from '../db.js';

export const billingLocationSelect = {
  field: { select: { name: true } },
  pad: { select: { name: true } },
  well: { select: { wellName: true } },
  facility: { select: { name: true } },
} as const;

export function billingCardLocation(source: {
  locationDisplay?: string | null;
  fieldAreaName?: string | null;
  field?: { name: string } | null;
  pad?: { name: string } | null;
  well?: { wellName: string | null } | null;
  facility?: { name: string } | null;
}): string | null {
  return source.locationDisplay?.trim() || source.well?.wellName || source.pad?.name
    || source.facility?.name || source.field?.name || source.fieldAreaName || null;
}

export function shopBillingCardLocation(source: {
  sourceLocation?: { name: string } | null;
  intakeSite?: { name: string } | null;
}): string | null {
  return source.sourceLocation?.name || source.intakeSite?.name || null;
}

// Resolve the whole visible invoice page in batches, including legacy invoices
// whose source tickets are referenced only by their line items.
export async function invoiceCardLocations(prisma: Pick<PrismaClient, 'serviceTicket' | 'shopWorkOrder' | 'rentalAgreement'>, invoices: Array<{
  id: string;
  billingGroupId: string | null;
  shopWorkOrderId: string | null;
  rentalAgreementId: string | null;
  lineItems: Array<{ sourceTicketId: string | null }>;
}>): Promise<Map<string, string | null>> {
  const groupIds = invoices.flatMap(i => i.billingGroupId ? [i.billingGroupId] : []);
  const ticketIds = invoices.flatMap(i => i.lineItems.flatMap(li => li.sourceTicketId ? [li.sourceTicketId] : []));
  const shopIds = invoices.flatMap(i => i.shopWorkOrderId ? [i.shopWorkOrderId] : []);
  const rentalIds = invoices.flatMap(i => i.rentalAgreementId ? [i.rentalAgreementId] : []);
  const [tickets, shops, rentals] = await Promise.all([
    ticketIds.length || groupIds.length ? prisma.serviceTicket.findMany({
      where: { OR: [{ id: { in: ticketIds } }, { billingGroupId: { in: groupIds } }] },
      select: { id: true, billingGroupId: true, locationDisplay: true, fieldAreaName: true, ...billingLocationSelect },
      orderBy: { serviceDate: 'desc' },
    }) : [],
    shopIds.length ? prisma.shopWorkOrder.findMany({
      where: { id: { in: shopIds } },
      select: { id: true, sourceLocation: { select: { name: true } }, intakeSite: { select: { name: true } } },
    }) : [],
    rentalIds.length ? prisma.rentalAgreement.findMany({
      where: { id: { in: rentalIds } },
      select: { id: true, ...billingLocationSelect },
    }) : [],
  ]);
  return new Map(invoices.map(invoice => {
    const sourceIds = new Set(invoice.lineItems.flatMap(li => li.sourceTicketId ? [li.sourceTicketId] : []));
    const names = tickets.filter(t => sourceIds.size ? sourceIds.has(t.id) : (!!invoice.billingGroupId && t.billingGroupId === invoice.billingGroupId))
      .map(billingCardLocation).filter((name): name is string => !!name);
    const shop = shops.find(s => s.id === invoice.shopWorkOrderId);
    const rental = rentals.find(r => r.id === invoice.rentalAgreementId);
    const sourceName = shop ? shopBillingCardLocation(shop) : rental ? billingCardLocation(rental) : null;
    if (sourceName) names.unshift(sourceName);
    return [invoice.id, [...new Set(names)].join(', ') || null];
  }));
}
