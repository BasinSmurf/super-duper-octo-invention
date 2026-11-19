import { api } from './api'
import { db } from './db'
import type { MutationQueueEntry } from './db-types'

export async function pendingShopIntake(orderId: string): Promise<MutationQueueEntry | undefined> {
  return db.mutationQueue.filter(m => m.table === 'shopWorkOrders' && m.action === 'create' && m.entityId === orderId).first()
}

/** Replay only this intake, with its original ID, without starting field sync. */
export async function retryShopIntake(orderId: string): Promise<void> {
  const mutation = await pendingShopIntake(orderId)
  if (!mutation || mutation.queueId == null) throw new Error('The saved intake could not be found on this device. Keep this page open and contact support.')
  try {
    const response = await api.post<{ results: Array<{ queueId: number; status: string; serverId?: string; error?: string }> }>('/sync/push', {
      mutations: [mutation],
    })
    const result = response.results.find(r => r.queueId === mutation.queueId)
    if (result?.status !== 'ok' || result.serverId !== orderId) throw new Error(result?.error || 'The server did not confirm this intake. Your saved equipment has been kept.')
    // Verify it can be read before clearing the only local copy of its items.
    const saved = await api.get<{ id: string; workOrderNumber: string; status: string; items: any[] }>(`/shop-orders/${orderId}`)
    if (saved.id !== orderId || !saved.workOrderNumber || !Array.isArray(saved.items) || saved.items.length === 0) throw new Error('Could not verify the saved job and equipment. Your local intake has been kept.')
    await db.transaction('rw', [db.shopWorkOrders, db.shopWorkOrderItems, db.mutationQueue], async () => {
      const items = saved.items.flatMap(({ childComponents, ...item }) => [item, ...(childComponents || [])])
      await db.shopWorkOrderItems.bulkPut(items.map(item => ({
        ...item, estimatedCost: item.estimatedCost == null ? null : Number(item.estimatedCost), _offlineStatus: 'synced' as const,
      })))
      await db.shopWorkOrders.update(orderId, { workOrderNumber: saved.workOrderNumber, status: saved.status, _offlineStatus: 'synced' })
      await db.mutationQueue.delete(mutation.queueId!)
    })
  } catch (error) {
    await db.mutationQueue.update(mutation.queueId, { errorMessage: error instanceof Error ? error.message : 'Intake retry failed' })
    throw error
  }
}
