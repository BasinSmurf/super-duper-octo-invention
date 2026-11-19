import { db } from './db'
import type { LineItem } from '@/components/LineItemEditor'

/** Queue the visit on the job, after its equipment mutations, like a Daily. */
export async function queueRentalEventTicket(input: {
  assignedTicketId?: string; manualEquipment?: import('./db-types').ManualRentalEquipment[]
  id: string; rental: { id: string; companyId: string; fieldId?: string | null; padId?: string | null; wellId?: string | null; facilityId?: string | null; poNumber?: string | null; afeNumber?: string | null }
  workType: 'rental_deploy' | 'rental_return'; serviceDate: string; userId?: string; description: string; lines: LineItem[]
}) {
  if (input.lines.some(line => line.rate == null)) throw new Error('Enter a rate on each billing line (zero is allowed).')
  const now = new Date().toISOString()
  const payload = {
    ticketType: 'field_service', serviceSubtype: 'general', division: 'D4' as const,
    status: 'supervisor_review', companyId: input.rental.companyId,
    fieldId: input.rental.fieldId, padId: input.rental.padId, wellId: input.rental.wellId, facilityId: input.rental.facilityId,
    poNumber: input.rental.poNumber, afeNumber: input.rental.afeNumber,
    linkedRentalAgreementId: input.rental.id, serviceDate: input.serviceDate,
    assignedTechId: input.userId, workDescription: input.description,
    customData: { workType: input.workType, ...(input.manualEquipment ? { manualEquipment: input.manualEquipment } : {}) }, offlineId: input.id,
  }
  await db.transaction('rw', [db.tickets, db.ticketLineItems, db.mutationQueue], async () => {
    // A retry of the visit must not enqueue its ticket/charges a second time.
    const existing = await db.tickets.get(input.id)
    if (existing && !['draft', 'dispatched', 'in_progress'].includes(existing.status)) return
    await db.tickets.put({ ...existing, ...payload, customData: { ...existing?.customData, ...payload.customData }, id: input.id, offlineCreated: existing?.offlineCreated ?? true, createdAt: existing?.createdAt || now, updatedAt: now, _offlineStatus: 'pending' })
    // Keep the server visit in progress until its lines land, even when a large
    // equipment outbox spans several sync batches. Otherwise an empty parent
    // can be closed as record-only before the following batch brings charges.
    await db.mutationQueue.add({ table: 'tickets', action: existing || input.assignedTicketId ? 'update' : 'create', entityId: input.id, offlineId: input.id, payload: { ...payload, status: 'in_progress' }, createdAt: now, status: 'pending', retryCount: 0 })
    for (const [index, line] of input.lines.entries()) {
      const linePayload = {
        ticketId: input.id, lineNumber: index + 1, sortOrder: index, lineType: line.lineType,
        productId: line.productId, partNumber: line.partNumber, description: line.description,
        quantity: line.quantity, rate: line.rate, total: line.quantity * line.rate!, unitOfMeasure: line.unitOfMeasure,
        notes: line.notes?.trim() || (line.lineType === 'labor' ? input.description : undefined),
        customData: line.priceLevelName ? { priceLevel: { name: line.priceLevelName, listRate: line.listRate ?? null, contractRate: line.contractRate ?? line.rate } } : undefined,
      }
      await db.ticketLineItems.put({ ...linePayload, id: line.id, updatedAt: now, _offlineStatus: 'pending' })
      await db.mutationQueue.add({ table: 'ticketLineItems', action: 'create', entityId: line.id, payload: linePayload, createdAt: now, status: 'pending', retryCount: 0 })
    }
    await db.mutationQueue.add({ table: 'tickets', action: 'update', entityId: input.id, payload: { status: 'supervisor_review' }, createdAt: now, status: 'pending', retryCount: 0 })
  })
}
