import { prisma } from '../index.js';
import { Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { setBillingReadiness } from './billingReadiness.js';
import { getBilledShopWorkOrderIds, jsonObject, shopBillingExcluded, type ShopBillingDb } from './shopBillingQueue.js';

const LOCAL_INVOICE_STATES = new Set(['draft', 'approved', 'awaiting_signature', 'queued']);
export function invoiceWaiverBlocker(invoice: {
  status: string; qbSalesOrderTxnId: string | null; qbInvoiceTxnId: string | null;
}, transmitted: boolean, hasPayments: boolean): string | null {
  if (invoice.qbSalesOrderTxnId || invoice.qbInvoiceTxnId || transmitted) return 'Already sent to QuickBooks; review externally';
  if (hasPayments) return 'Has payment records; reconcile before waiving';
  if (invoice.status !== 'void' && !LOCAL_INVOICE_STATES.has(invoice.status)) return 'Already invoiced or paid; review externally';
  return null;
}

/** Same ready population as Billing, plus shop work already in an invoice or legacy RP queue. */
export async function previewShopBillingWaiver(db: ShopBillingDb = prisma) {
  const [handled, orders, tickets, invoices, sync, external] = await Promise.all([
    getBilledShopWorkOrderIds(db),
    db.shopWorkOrder.findMany({ where: { isInternal: false }, include: { company: { select: { name: true } }, payments: { select: { id: true } } }, orderBy: { workOrderNumber: 'asc' } }),
    db.serviceTicket.findMany({ where: { sourceType: 'shop_work_order' }, select: { id: true, status: true, customData: true, enverusReceiptId: true, enverusInvoiceId: true } }),
    db.invoice.findMany({ include: { lineItems: { select: { sourceTicketId: true } }, payments: { select: { id: true } } } }),
    db.qbSyncQueue.findMany({ where: { OR: [{ status: { in: ['sent', 'success'] } }, { sentAt: { not: null } }] }, select: { entityId: true } }),
    db.enverusSyncQueue.findMany({ select: { entityId: true } }),
  ]);
  const transmitted = new Set(sync.map(s => s.entityId));
  return orders.flatMap(wo => {
    if (shopBillingExcluded(wo)) return [];
    const relatedTickets = tickets.filter(t => jsonObject(t.customData).shopWorkOrderId === wo.id);
    const ticketIds = new Set(relatedTickets.map(t => t.id));
    const relatedInvoices = invoices.filter(i => i.shopWorkOrderId === wo.id || i.lineItems.some(l => l.sourceTicketId && ticketIds.has(l.sourceTicketId)));
    const activeInvoices = relatedInvoices.filter(i => i.status !== 'void');
    const inQueue = (wo.status === 'closed' && !handled.has(wo.id)) || activeInvoices.length > 0 || relatedTickets.some(t => ['billing_queue', 'awaiting_signature'].includes(t.status));
    if (!inQueue) return [];
    const blockers: string[] = [];
    if (wo.status !== 'closed') blockers.push('Shop work is not closed; complete shop work first');
    if (wo.payments.length) blockers.push('Workorder has payment records; reconcile before waiving');
    if (relatedTickets.some(t => t.enverusReceiptId || t.enverusInvoiceId || transmitted.has(t.id))) blockers.push('A source ticket has reached external billing; review externally');
    if (external.some(e => ticketIds.has(e.entityId) || relatedInvoices.some(i => i.id === e.entityId))) blockers.push('Has external billing queue history; review before waiving');
    for (const inv of relatedInvoices) {
      const blocker = invoiceWaiverBlocker(inv, transmitted.has(inv.id), inv.payments.length > 0);
      if (blocker) blockers.push(`${inv.invoiceNumber}: ${blocker}`);
      if (inv.enverusReceiptId) blockers.push(`${inv.invoiceNumber}: submitted to Enverus; review externally`);
      if (inv.status !== 'void' && inv.lineItems.some(l => l.sourceTicketId && !ticketIds.has(l.sourceTicketId))) {
        blockers.push(`${inv.invoiceNumber}: includes other work; split the invoice first`);
      }
    }
    return [{ id: wo.id, workOrderNumber: wo.workOrderNumber, companyName: wo.company.name,
      invoiceIds: activeInvoices.map(i => i.id), invoiceNumbers: activeInvoices.map(i => i.invoiceNumber),
      ticketIds: relatedTickets.filter(t => ['billing_queue', 'invoiced', 'awaiting_signature'].includes(t.status)).map(t => t.id),
      blockers: [...new Set(blockers)] }];
  });
}

export async function waiveShopBilling(ids: string[], reason: string, userId: string) {
  if (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) throw new AppError(400, 'Select 1–1000 distinct workorders');
  if (!reason.trim() || reason.length > 2000) throw new AppError(400, 'A reason of 1–2000 characters is required');
  return prisma.$transaction(async tx => {
    // Rare administrative bulk operation: prevent invoices/queue jobs/payments
    // changing between the fresh preview and the atomic cancellation.
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await tx.$executeRaw`LOCK TABLE shop_work_orders, service_tickets, invoices, invoice_line_items, qb_sync_queue, signature_requests, payments, enverus_sync_queue IN EXCLUSIVE MODE`;
    const preview = await previewShopBillingWaiver(tx);
    const selected = ids.map(id => preview.find(w => w.id === id));
    if (selected.some(w => !w || w.blockers.length)) throw new AppError(409, 'Billing changed or a workorder is blocked. Refresh the preview. Nothing was changed.');
    if (selected.some(w => w!.ticketIds.length)) {
      await tx.billingReasonCode.upsert({ where: { code: 'SHOP_BILLING_WAIVED' }, update: {},
        create: { code: 'SHOP_BILLING_WAIVED', phase: 'pre_acceptance', label: 'Shop work closed without billing', resultingAction: 'not_billable' } });
    }
    const now = new Date();
    for (const row of selected) {
      const wo = row!;
      const existing = await tx.shopWorkOrder.findUniqueOrThrow({ where: { id: wo.id } });
      const waiver = { reason: reason.trim(), waivedAt: now.toISOString(), waivedById: userId };
      await tx.shopWorkOrder.update({ where: { id: wo.id }, data: {
        customData: { ...jsonObject(existing.customData), billingWaiver: waiver } as Prisma.InputJsonValue,
      } });
      for (const invoiceId of wo.invoiceIds) {
        const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
        await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'void',
          customData: { ...jsonObject(invoice.customData), billingWaiver: waiver } as Prisma.InputJsonValue,
          internalNotes: [invoice.internalNotes, `Billing waived: ${reason.trim()}`].filter(Boolean).join('\n\n'),
        } });
      }
      await tx.qbSyncQueue.updateMany({ where: { entityId: { in: [...wo.invoiceIds, ...wo.ticketIds] }, status: { in: ['pending', 'error'] } }, data: { status: 'skipped', errorMessage: `Billing waived: ${reason.trim()}`, completedAt: now } });
      await tx.serviceTicket.updateMany({ where: { id: { in: wo.ticketIds } }, data: { status: 'closed' } });
      for (const ticketId of wo.ticketIds) {
        await setBillingReadiness(ticketId, { next: 'not_billable', actorUserId: userId, reasonCode: 'SHOP_BILLING_WAIVED' }, tx);
        await tx.auditLog.create({ data: { userId, entityType: 'ServiceTicket', entityId: ticketId, action: 'status_change', changes: { to: 'closed', billingReadiness: 'not_billable', billingWaiver: waiver, shopWorkOrderId: wo.id } } });
      }
      await tx.signatureRequest.updateMany({ where: { status: 'PENDING', OR: [{ invoiceId: { in: wo.invoiceIds } }, { ticketId: { in: wo.ticketIds } }] }, data: { status: 'VOIDED', resolvedAt: now, resolvedById: userId, notes: `Billing waived: ${reason.trim()}` } });
      await tx.auditLog.create({ data: { userId, entityType: 'ShopWorkOrder', entityId: wo.id, action: 'status_change', changes: { billingWaiver: waiver, voidedInvoiceIds: wo.invoiceIds, closedTicketIds: wo.ticketIds } } });
      for (const invoiceId of wo.invoiceIds) await tx.auditLog.create({ data: { userId, entityType: 'invoice', entityId: invoiceId, action: 'status_change', changes: { to: 'void', billingWaiver: waiver, shopWorkOrderId: wo.id } } });
    }
    return { waived: selected.length, voidedInvoices: selected.reduce((sum, w) => sum + w!.invoiceIds.length, 0) };
  }, { timeout: 60000 });
}

/** Recheck at invoice creation, under the same WO lock as a waiver. */
export async function assertShopBillingAllowed(tx: ShopBillingDb, ids: string[]) {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM shop_work_orders WHERE id IN (${Prisma.join(unique)}) ORDER BY id FOR UPDATE`);
  const orders = await tx.shopWorkOrder.findMany({ where: { id: { in: unique } } });
  if (orders.length !== unique.length || orders.some(shopBillingExcluded)) throw new AppError(409, 'A source workorder is internal, voided, or closed without billing');
}
