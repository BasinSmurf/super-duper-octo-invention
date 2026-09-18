import { db } from './db'
import { api } from './api'

// Dexie child tables that hang off a ticket by `ticketId`. Kept in one place so
// discardDraft cleans every dependent record a draft might have accumulated.
const TICKET_CHILD_TABLES = [
  'ticketLineItems',
  'ticketAttachments',
  'fitTestRecords',
  'airSystemRecords',
  'ihTestRecords',
  'trainingRosterRecords',
  'gasDetectionRecords',
  'equipmentInspections',
] as const

const ABANDONED_WIZARD_DRAFT_TTL_MS = 48 * 60 * 60 * 1000

/**
 * Unsaved wizard drafts are local scratch, not assigned work. If they have not
 * changed for 48h, drop them so "My Jobs" does not keep showing abandoned
 * starts forever. Edit-session drafts are excluded because their ticket row is
 * the durable thing the user is working on.
 */
export async function pruneAbandonedWizardDrafts(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - ABANDONED_WIZARD_DRAFT_TTL_MS).toISOString()
  const ids = await db.drafts
    .filter(d => !d.id.startsWith('edit-') && !!d.updatedAt && d.updatedAt < cutoff)
    .primaryKeys()

  if (ids.length === 0) return 0
  await db.drafts.bulkDelete(ids as string[])
  return ids.length
}

/**
 * #5 Kill a draft ticket ("ope, not that one") — offline-aware.
 *
 * The hazard: if we delete the local rows but leave a queued *create* mutation,
 * the next sync push recreates the ticket on the server, and the pull's
 * orphan-prune deliberately skips `_offlineStatus: 'pending'` records — so the
 * discarded draft resurrects. We therefore branch on whether the server has
 * ever seen this ticket:
 *
 *  - Never synced (a pending create is still queued): purge the create + child
 *    mutations and delete local rows. The server is never contacted.
 *  - Already synced (or its create is mid-upload): delete local rows for
 *    instant feedback, then remove it server-side — directly when online, or via
 *    a queued delete (whose entityId the sync engine remaps if the create is
 *    still in flight) when offline.
 */
export async function discardDraft(ticketId: string): Promise<void> {
  const queued = await db.mutationQueue
    .filter(m => m.entityId === ticketId || (m.payload as Record<string, unknown> | undefined)?.ticketId === ticketId)
    .toArray()
  const ownCreate = queued.find(m => m.table === 'tickets' && m.action === 'create' && m.entityId === ticketId)
  // 'uploading' means a push is in flight — treat as "the server may already
  // have it" and fall through to the server-side removal path.
  const neverSynced = !!ownCreate && ownCreate.status !== 'uploading'

  const childTables = TICKET_CHILD_TABLES.map(t => (db as unknown as Record<string, any>)[t])
  await db.transaction('rw', [db.tickets, db.mutationQueue, ...childTables], async () => {
    for (const t of TICKET_CHILD_TABLES) {
      await (db as unknown as Record<string, any>)[t].where('ticketId').equals(ticketId).delete()
    }
    await db.tickets.delete(ticketId)

    if (neverSynced) {
      const ids = queued.map(m => m.queueId).filter((v): v is number => v != null)
      if (ids.length) await db.mutationQueue.bulkDelete(ids)
    }
  })

  if (neverSynced) return // server never saw it — done

  // Synced or mid-upload: remove it on the server.
  try {
    await api.post(`/tickets/${ticketId}/discard-draft`, {})
  } catch {
    const now = new Date().toISOString()
    await db.mutationQueue.add({
      table: 'tickets',
      action: 'delete',
      entityId: ticketId,
      payload: {},
      createdAt: now,
      status: 'pending',
      retryCount: 0,
    })
  }
}
