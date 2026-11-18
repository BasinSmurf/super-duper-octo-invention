import { db } from './db'

const childRelations: Record<string, Record<string, string[]>> = {
  tickets: { ticketId: ['ticketLineItems', 'ticketAttachments', 'fitTestRecords', 'airSystemRecords', 'ihTestRecords', 'gasDetectionRecords', 'trainingRosterRecords', 'equipmentInspections', 'attachments', 'drafts'] },
  rentalAgreements: { rentalAgreementId: ['rentalAgreementItems', 'rentalDailyLogs'], linkedRentalAgreementId: ['tickets'] },
  shopWorkOrders: { workOrderId: ['shopWorkOrderItems', 'shopTransferEvents'] },
  shopWorkOrderItems: { shopItemId: ['equipmentInspections', 'attachments'] },
  equipmentInspections: { inspectionId: ['equipmentInspectionAttachments', 'attachments'] },
}

/** Commit the parent, local children and queued payloads together. The create
 * must stay queued until this commits so a tab crash can safely replay its ack.
 */
export async function remapEntityId(tableName: string, oldId: string, newId: string) {
  const relations = childRelations[tableName] || {}
  const tables = [...new Set([tableName, 'mutationQueue', ...Object.values(relations).flat()])].map(name => db.table(name))
  await db.transaction('rw', tables, async () => {
    const parent = db.table(tableName)
    const existing = await parent.get(oldId)
    if (existing) {
      await parent.put({ ...existing, id: newId })
      await parent.delete(oldId)
    }
    for (const [field, names] of Object.entries(relations)) {
      for (const name of names) {
        await db.table(name).filter(row => row[field] === oldId).modify({ [field]: newId })
      }
    }
    await db.mutationQueue.toCollection().modify(m => {
      if (m.table === tableName && m.entityId === oldId) m.entityId = newId
      for (const [field, names] of Object.entries(relations)) {
        if (names.includes(m.table) && m.payload[field] === oldId) {
          m.payload = { ...m.payload, [field]: newId }
        }
      }
    })
  })
}
