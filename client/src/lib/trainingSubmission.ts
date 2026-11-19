import { db } from './db'

/** Publish a complete local save before review, including field-to-shop handoffs. */
export async function persistTicketBatch(ticketId: string, complete: boolean, now: string, save: () => Promise<void>) {
  await db.transaction('rw', [db.tickets, db.ticketLineItems, db.ticketAttachments, db.trainingRosterRecords, db.equipmentInspections, db.shopWorkOrders, db.mutationQueue], async () => {
    // A correction before sync replaces the old submission barrier.
    const previous = await db.mutationQueue.where('entityId').equals(ticketId).toArray()
    for (const mutation of previous) {
      if (mutation.table === 'tickets' && mutation.dependsOn) await db.mutationQueue.delete(mutation.queueId!)
    }
    await save()
    if (!complete) return
    const edits = (await db.mutationQueue.toArray()).filter(m => m.status !== 'done'
      && ((m.table === 'tickets' && m.entityId === ticketId) || m.payload.ticketId === ticketId
        || (m.table === 'shopWorkOrders' && Array.isArray(m.payload.items)
          && m.payload.items.some((item: any) => item.customData?.fieldInspectionRecord?.sourceTicketOfflineId === ticketId))))
    await db.mutationQueue.add({
      table: 'tickets', action: 'update', entityId: ticketId,
      payload: { status: 'supervisor_review' }, dependsOn: edits.map(m => m.queueId!),
      createdAt: now, status: 'pending', retryCount: 0,
    })
  })
}
