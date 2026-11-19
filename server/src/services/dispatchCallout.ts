import { prisma } from '../db.js';
import { Prisma, type UserRole } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { allowedFields, numberValue } from './writeValidation.js';
import { ticketFields, validateTicketInput, validateLineInput } from './ticketWritePolicy.js';
import { canTransition } from './ticketStateMachine.js';
import { assertCompanyActive, assertCompanyNotOnCreditHold } from '../utils/companyGuards.js';
import { generateTicketNumber } from '../utils/ticketNumber.js';
import { buildLocationDisplay } from '../utils/locationDisplay.js';
import { flatOverridesFromPayload } from './billingRefs.js';
import { computeBillingGroupKey } from '../utils/billingGroupKey.js';
import { defaultDivisionForWork } from '../utils/qbClass.js';
import { selectBillingProfile } from './billingProfileSelector.js';
import { emitEvent } from './eventBus.js';

/** Create the prepared ticket and its charges atomically, without recording field results. */
export async function dispatchCallout(body: any, actor: { userId: string; role: string }) {
  if (!canTransition('draft', 'dispatched', actor.role as UserRole)) throw new AppError(403, 'Dispatch is not permitted');
  const { requestId, ticket: input, lineItems = [] } = body;
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId) || !input || typeof input !== 'object'
    || !Array.isArray(lineItems) || lineItems.length > 100) throw new AppError(400, 'Invalid dispatch preparation');
  const prior = await prisma.serviceTicket.findUnique({ where: { id: requestId } });
  if (prior) {
    if (prior.createdById !== actor.userId || !(prior.customData as any)?.dispatchPrepared) throw new AppError(409, 'Request ID already used');
    return prior;
  }
  allowedFields(input, ticketFields);
  await validateTicketInput(input, true);
  const notificationDivision = input.customData?.dispatchNotificationDivision;
  if (notificationDivision != null && notificationDivision !== 'D3' && notificationDivision !== 'D4') {
    throw new AppError(400, 'Choose D3 or D4 for field dispatch notifications');
  }
  if (!input.assignedTechId || !input.serviceDate || !input.division) throw new AppError(400, 'Assigned user, service date, and division are required');
  const tech = await prisma.user.findUnique({ where: { id: input.assignedTechId }, select: { id: true, isActive: true } });
  if (!tech?.isActive) throw new AppError(400, 'Choose an active assigned user');
  await assertCompanyActive(input.companyId);
  await assertCompanyNotOnCreditHold(input.companyId);
  const lines: Awaited<ReturnType<typeof validateLineInput>>[] = [];
  for (const line of lineItems) {
    if (!line || typeof line !== 'object' || line.rate == null) throw new AppError(400, 'Enter a rate on each prefilled charge');
    lines.push(await validateLineInput({ lineType: line.lineType, productId: line.productId || undefined,
      partNumber: line.partNumber, description: line.description, quantity: line.quantity, rate: line.rate,
      unitOfMeasure: line.unitOfMeasure, notes: line.notes,
      ...(line.priceLevelName ? { customData: { priceLevel: { name: line.priceLevelName,
        listRate: line.listRate ?? null, contractRate: line.contractRate ?? line.rate } } } : {}),
    }));
  }
  const subtotal = lines.reduce((sum, line) => sum.add(line.total), new Prisma.Decimal(0));
  numberValue(subtotal.toNumber(), 'ticket total');
  const serviceDate = new Date(input.serviceDate);
  const billingProfile = input.billingProfileId ? null : selectBillingProfile(await prisma.customerBillingProfile.findMany({
    where: { companyId: input.companyId, isActive: true },
  }), { ticketType: input.ticketType, division: input.division, serviceDate });
  const locationDisplay = await buildLocationDisplay(input) || input.locationDisplay;
  const ticketNumber = await generateTicketNumber(input.ticketType, input.serviceSubtype);
  // IDs in the snapshot must be the IDs saved to the ledger so tech edits update those same lines.
  const lineIds = lineItems.map((line: any) => typeof line.id === 'string' && /^[0-9a-f-]{36}$/i.test(line.id) ? line.id : undefined);
  const customData = { ...input.customData, dispatchPrepared: true };
  let created;
  try {
    created = await prisma.$transaction(async tx => {
      const ticket = await tx.serviceTicket.create({ data: {
        ...input, ...flatOverridesFromPayload(input), id: requestId, offlineId: requestId, ticketNumber,
        status: 'dispatched', serviceDate, division: input.division || defaultDivisionForWork(input), locationDisplay,
        arrivalTime: undefined, departureTime: undefined, customerRepSignature: undefined, techSignature: undefined,
        billingProfileId: input.billingProfileId || billingProfile?.id, billingGroupKey: computeBillingGroupKey({ ...input, serviceDate }) || undefined,
        assignedTechId: input.assignedTechId, createdById: actor.userId, dispatchedById: actor.userId, dispatchedAt: new Date(),
        customData, subtotal, total: subtotal,
        lineItems: { create: lines.map((line, index) => ({ ...line, id: lineIds[index], lineNumber: index + 1, sortOrder: index })) },
      } });
      await tx.auditLog.create({ data: { userId: actor.userId, entityType: 'service_ticket', entityId: ticket.id,
        action: 'create', changes: { status: 'dispatched', assignedTechId: input.assignedTechId, dispatchPrepared: true } } });
      return ticket;
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    const saved = await prisma.serviceTicket.findUnique({ where: { id: requestId } });
    if (!saved || saved.createdById !== actor.userId || !(saved.customData as any)?.dispatchPrepared) throw err;
    return saved;
  }
  void emitEvent('ticket.transitioned', { ticketId: created.id, fromStatus: 'draft', toStatus: 'dispatched', actorUserId: actor.userId });
  return created;
}
