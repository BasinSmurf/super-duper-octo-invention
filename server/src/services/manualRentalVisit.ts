import { rentalVisitEquipment } from './rentalVisitEquipment.js';
import { returnRentalItem } from './rentalLifecycle.js';
import { prisma } from '../db.js';
import { Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';
import { generateTicketNumber } from '../utils/ticketNumber.js';
import { validateLineInput } from './ticketWritePolicy.js';
import { numberValue } from './writeValidation.js';
import { runAndCacheReviewSignal } from './ticketReviewRules.js';
import { applyManualEquipmentVisit } from './manualRentalEquipment.js';
import { rentalDate, rentalToday } from './rentalLifecycle.js';
import { appendRentalEventLog } from './rentalEventLog.js';

/** One atomic, retry-safe operation shared by online forms and the offline outbox. */
export async function saveManualRentalVisit(rentalId: string, body: any, userId: string, ipAddress?: string) {
    const { requestId, workType, selections, inspection, reason = '', lineItems = [] } = body;
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)
      || !['rental_swap', 'rental_return'].includes(workType) || typeof reason !== 'string' || reason.length > 10000
      || !Array.isArray(lineItems) || lineItems.length > 100) throw new AppError(400, 'Invalid equipment visit');
    const serviceDate = rentalDate(body.serviceDate, 'serviceDate');
    if (serviceDate > rentalToday()) throw new AppError(400, 'Visit date cannot be in the future');
    const ticketNumber = await generateTicketNumber('field_service');
    const ticket = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM rental_agreements WHERE id = ${rentalId} FOR UPDATE`;
      const prior = await tx.serviceTicket.findUnique({ where: { id: requestId } });
      if (prior) {
        if (prior.linkedRentalAgreementId !== rentalId || prior.createdById !== userId
          || (prior.customData as any)?.workType !== workType) throw new AppError(409, 'Request ID already used');
        return prior;
      }
      const rental = await tx.rentalAgreement.findUnique({ where: { id: rentalId }, include: { items: { include: { product: true, serializedEquipment: true } } } });
      if (!rental) throw new AppError(404, 'Rental agreement not found');
      if (rental.status !== 'active') throw new AppError(409, 'Rental agreement is no longer active');
      if (serviceDate < rental.startDate) throw new AppError(400, 'Visit date cannot precede the rental start');
      const inventoryIds = new Set((rental.items || []).map(item => item.id));
      const visit = applyManualEquipmentVisit({ ...(rental.composition as any || {}), manualEquipment: rentalVisitEquipment(rental) }, {
        workType, selections, serviceDate: serviceDate.toISOString().slice(0, 10), requestId, inspection, userId: userId,
      });
      // Inventory ownership changes remain under the rental transaction and compare-and-set guards.
      for (const record of visit.records.filter(row => inventoryIds.has(row.itemId))) {
        const item = rental.items.find(row => row.id === record.itemId)!;
        if (workType === 'rental_return') {
          await returnRentalItem(tx, rentalId, item.id, { returnedDate: serviceDate.toISOString() });
          await tx.rentalAgreementItem.update({ where: { id: item.id }, data: { deployInspection: { ...(item.deployInspection as object || {}), returnInspectionId: requestId } } });
          if (record.inspection?.overallCondition !== 'good' || record.inspection?.physicalDamage || record.inspection?.calibrationCurrent === false) {
            await tx.serializedEquipment.updateMany({ where: { id: item.serializedEquipmentId, currentRentalId: null, status: 'available' }, data: { status: 'repair' } });
          }
        } else {
          const replacement = await tx.serializedEquipment.findFirst({ where: { serialNumber: record.after.serial, productId: item.productId } });
          if (!replacement || replacement.id === item.serializedEquipmentId) throw new AppError(409, 'Choose an available replacement serial for the same catalog product');
          const claimed = await tx.serializedEquipment.updateMany({ where: { id: replacement.id, status: 'available', currentRentalId: null }, data: { status: 'rented', currentRentalId: rentalId, currentCustomerId: rental.companyId } });
          if (claimed.count !== 1) throw new AppError(409, 'Replacement equipment is no longer available');
          const released = await tx.serializedEquipment.updateMany({ where: { id: item.serializedEquipmentId, currentRentalId: rentalId, status: { in: ['rented', 'deployed'] } }, data: { status: 'available', currentRentalId: null, currentCustomerId: null } });
          if (released.count !== 1) throw new AppError(409, 'Outgoing equipment is no longer deployed on this rental');
          const changed = await tx.rentalAgreementItem.updateMany({ where: { id: item.id, status: 'deployed', serializedEquipmentId: item.serializedEquipmentId }, data: {
            serializedEquipmentId: replacement.id, deployInspection: { ...(item.deployInspection as object || {}), testDate: record.after.testDate, lastSwapDate: serviceDate.toISOString().slice(0, 10) },
          } });
          if (changed.count !== 1) throw new AppError(409, 'Rental equipment changed; reload before swapping');
        }
      }
      // Keep inventory rows out of the manual list, so billing never sees duplicate equipment.
      visit.composition.manualEquipment = visit.composition.manualEquipment.filter((row: { id: string }) => !inventoryIds.has(row.id));
      if (workType === 'rental_return') {
        const invoice = await tx.invoice.findFirst({ where: { rentalAgreementId: rentalId, status: { not: 'void' },
          periodStart: { lte: rentalToday() }, periodEnd: { gte: new Date(+serviceDate + 86400000) } } });
        if (invoice) throw new AppError(409, `Return changes billed history on invoice ${invoice.invoiceNumber}; correct it first`);
      }
      const billingLines = [];
      for (const line of lineItems) {
        if (!line || typeof line !== 'object' || line.rate == null) throw new AppError(400, 'Enter a rate on each billing line (zero is allowed)');
        billingLines.push(await validateLineInput({ lineType: line.lineType, productId: line.productId || undefined,
          partNumber: line.partNumber, description: line.description, quantity: line.quantity, rate: line.rate,
          unitOfMeasure: line.unitOfMeasure, notes: line.notes,
          ...(line.priceLevelName ? { customData: { priceLevel: { name: line.priceLevelName,
            listRate: line.listRate ?? null, contractRate: line.contractRate ?? line.rate } } } : {}),
        }));
      }
      const subtotal = billingLines.reduce((sum, line) => sum.add(line.total), new Prisma.Decimal(0));
      numberValue(subtotal.toNumber(), 'ticket total');
      const recordOnly = subtotal.isZero();
      const description = `Equipment ${workType === 'rental_swap' ? 'swap' : 'return'}${reason.trim() ? ` — ${reason.trim()}` : ''}\n${visit.records.map(row =>
        `${row.before.type}: ${row.before.serial}${workType === 'rental_swap' ? ` → ${row.after.type}: ${row.after.serial} (test date ${row.after.testDate})` : ` (test date ${row.before.testDate})`}`).join('\n')}`;
      const closes = workType === 'rental_return' && visit.allReturned
        && !await tx.rentalAgreementItem.findFirst({ where: { rentalAgreementId: rentalId, status: 'deployed' } });
      if (closes && visit.composition.manualEquipment.some((row: { returnedAt?: string }) => (row.returnedAt || '') > serviceDate.toISOString().slice(0, 10))) {
        throw new AppError(400, 'Final return date cannot precede an earlier recorded return');
      }
      await tx.rentalAgreement.update({ where: { id: rentalId }, data: {
        composition: visit.composition, ...(closes ? { status: 'completed', endDate: serviceDate } : {}),
      } });
      const created = await tx.serviceTicket.create({ data: {
        id: requestId, ticketNumber, ticketType: 'field_service', serviceSubtype: 'general', division: 'D4',
        status: recordOnly ? 'closed' : 'supervisor_review', companyId: rental.companyId, fieldId: rental.fieldId,
        padId: rental.padId, wellId: rental.wellId, facilityId: rental.facilityId, linkedRentalAgreementId: rentalId,
        serviceDate, completedAt: new Date(), assignedTechId: userId, createdById: userId,
        poNumber: rental.poNumber, afeNumber: rental.afeNumber, workDescription: description, subtotal, total: subtotal,
        lineItems: { create: billingLines.map((line, index) => ({ ...line, lineNumber: index + 1, sortOrder: index,
          notes: line.notes?.trim() || (line.lineType === 'labor' ? description : undefined) })) },
        customData: { workType, recordOnly, equipmentChanges: visit.records, reason: reason.trim(),
          ...(workType === 'rental_return' ? { inspection: { id: requestId, itemIds: visit.records.map(row => row.itemId),
            inspectedBy: userId, inspectedAt: new Date().toISOString(), serviceDate: serviceDate.toISOString().slice(0, 10), data: inspection || null, results: visit.records.map(row => ({ itemId: row.itemId, data: row.inspection })) } } : {}) },
      } });
      await appendRentalEventLog(tx, created);
      await tx.auditLog.create({ data: { userId: userId, entityType: 'rental_agreement', entityId: rentalId,
        action: 'update', changes: { ticketId: created.id, equipmentChanges: visit.records }, ipAddress: ipAddress } });
      return created;
    }, { maxWait: 10000, timeout: 30000 });
    if (ticket.status === 'supervisor_review') {
      try { await runAndCacheReviewSignal(ticket.id); } catch (err) { console.error('[rentals/equipment-visit] Review signal failed', err); }
    }
    return ticket;
}
