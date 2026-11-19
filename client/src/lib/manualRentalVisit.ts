import { api, ApiError } from './api'
import { db } from './db'
import type { ManualRentalEquipment, OfflineRentalAgreement } from './db-types'
import type { LineItem } from '@/components/LineItemEditor'
import type { InspectionData } from '@/components/RentalInspectionEditor'

export interface ManualRentalVisit {
  requestId: string
  workType: 'rental_swap' | 'rental_return'
  serviceDate: string
  reason?: string
  selections: { itemId: string; inspection?: InspectionData; expected?: ManualRentalEquipment; replacement?: Pick<ManualRentalEquipment, 'serial' | 'type' | 'testDate'> }[]
  inspection?: InspectionData
  lineItems: LineItem[]
}

/** Keep a whole batch together when the connection drops during a field visit. */
type VisitRental = OfflineRentalAgreement & { facilityId?: string | null; items?: { status: string }[] }
export async function saveManualRentalVisit(rental: VisitRental, visit: ManualRentalVisit, userId?: string, userRole?: string): Promise<{ id: string }> {
  try { return await api.post<{ id: string }>(`/rentals/${rental.id}/equipment-visit`, visit) }
  catch (err) { if (err instanceof ApiError || !(err instanceof TypeError)) throw err }
  if (userRole && !['field_tech', 'field_super', 'dispatch'].includes(userRole)) throw new Error('Connect to the server to save this equipment visit. This account does not run offline sync.')
  if (visit.lineItems.some(line => line.rate == null)) throw new Error('Enter a rate on each billing line (zero is allowed).')
  const now = new Date().toISOString()
  await db.transaction('rw', [db.rentalAgreements, db.tickets, db.ticketLineItems, db.mutationQueue], async () => {
    if (await db.tickets.get(visit.requestId)) return
    const cached = await db.rentalAgreements.get(rental.id)
    const saved: VisitRental = cached?._offlineStatus === 'pending' ? cached : rental
    const manualRows = saved.composition?.manualEquipment || []
    const rows = saved.visitEquipment || manualRows
    const changes = visit.selections.map(selection => {
      const before = rows.find(row => row.id === selection.itemId)
      if (!before || before.status === 'returned') throw new Error('Equipment changed; reconnect and reload the rental')
      const after: ManualRentalEquipment = visit.workType === 'rental_swap'
        ? { ...before, ...selection.replacement, lastSwapDate: visit.serviceDate }
        : { ...before, status: 'returned', returnedAt: visit.serviceDate, returnInspectionId: visit.requestId }
      return { itemId: before.id, before, after, inspection: selection.inspection || visit.inspection }
    })
    const equipment = rows.map(row => changes.find(change => change.itemId === row.id)?.after || row)
    const closes = visit.workType === 'rental_return' && equipment.every(row => row.status === 'returned') && (!!saved.visitEquipment || !saved.items?.some(row => row.status === 'deployed'))
    await db.rentalAgreements.put({ ...saved, visitEquipment: equipment, composition: { ...saved.composition!, manualEquipment: equipment.filter(row => manualRows.some(original => original.id === row.id)) },
      ...(closes ? { status: 'completed', endDate: visit.serviceDate } : {}), updatedAt: now, _offlineStatus: 'pending' })
    const description = `Equipment ${visit.workType === 'rental_swap' ? 'swap' : 'return'}\n` + changes.map(change =>
      `${change.before.type}: ${change.before.serial}${visit.workType === 'rental_swap' ? ` → ${change.after.type}: ${change.after.serial}` : ''}`).join('\n')
    await db.tickets.put({ id: visit.requestId, ticketType: 'field_service', serviceSubtype: 'general', division: 'D4',
      status: 'supervisor_review', companyId: saved.companyId, fieldId: saved.fieldId, padId: saved.padId, wellId: saved.wellId,
      facilityId: saved.facilityId, linkedRentalAgreementId: saved.id, assignedTechId: userId, serviceDate: visit.serviceDate,
      poNumber: saved.poNumber, afeNumber: saved.afeNumber, workDescription: description,
      customData: { workType: visit.workType, equipmentChanges: changes, ...(visit.workType === 'rental_return' ? { inspection: {
        id: visit.requestId, itemIds: changes.map(change => change.itemId), inspectedBy: userId, inspectedAt: now, data: visit.inspection || null, results: changes.map(change => ({ itemId: change.itemId, data: change.inspection })),
      } } : {}) }, offlineCreated: true, createdAt: now, updatedAt: now, _offlineStatus: 'pending' })
    for (const [index, line] of visit.lineItems.entries()) await db.ticketLineItems.put({ ...line, ticketId: visit.requestId,
      lineNumber: index + 1, sortOrder: index, total: line.quantity * line.rate!, updatedAt: now, _offlineStatus: 'pending' })
    // The server applies gear, inspection, charges, and closure in one transaction.
    await db.mutationQueue.add({ table: 'rentalAgreements', action: 'update', entityId: saved.id,
      payload: { equipmentVisit: visit }, createdAt: now, status: 'pending', retryCount: 0 })
  })
  return { id: visit.requestId }
}
