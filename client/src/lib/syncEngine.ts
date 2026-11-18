/**
 * Sync Engine — orchestrates offline-first data flow:
 *
 * 1. HYDRATE:  On first login (no syncMeta), pull all reference tables in bulk.
 * 2. DELTA:    On subsequent runs, pull only records updated since last sync.
 * 3. PUSH:     Drain the mutation queue — send pending writes to the server.
 *
 * The engine is designed to be called from a React context provider and
 * exposes event callbacks for UI feedback.
 */

import { db } from './db'
import { remapEntityId } from './syncIdentity'
import { markAttachmentSynced } from './attachments'
import { api, ApiError } from './api'
import { pruneAbandonedWizardDrafts } from './draftActions'
import type { SyncMeta } from './db-types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tables we sync DOWN from the server (read-only reference data + tickets) */
const REFERENCE_TABLES = ['companies', 'fields', 'pads', 'wells', 'products', 'courses', 'priceLevels', 'equipment'] as const
const WRITABLE_TABLES_LIST = ['tickets', 'rentalAgreements', 'rentalAgreementItems', 'rentalDailyLogs', 'shopWorkOrders', 'shopWorkOrderItems', 'equipmentInspections', 'shopTransferEvents'] as const
// Tables the server sends allIds for (writable tables, plus reference tables
// that can be hard-deleted server-side, e.g. a pad removed in DMR cleanup) —
// see PRUNABLE_TABLES in server/src/routes/sync.ts. Without this, a pad
// deleted on the server stays cached on the device forever (a hard refresh
// doesn't clear IndexedDB), still showing up in the location picker.
// priceLevels is prunable for the same reason pads are: a contract pricebook
// retired in QuickBooks has to stop pricing lines on the device, and nothing
// else ever clears IndexedDB.
const PRUNABLE_TABLES = new Set<string>([...WRITABLE_TABLES_LIST, 'pads', 'priceLevels', 'products'])
const ALL_SYNC_TABLES = [...REFERENCE_TABLES, ...WRITABLE_TABLES_LIST] as const
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline'

export interface SyncState {
  status: SyncStatus
  lastSyncedAt: string | null
  /** Per-table counts from last sync (for UI) */
  tableCounts: Record<string, number>
  error: string | null
  /** Number of mutations waiting to be pushed */
  pendingMutations: number
  /**
   * Soft warnings from the last push: the mutation COMMITTED (so it left the
   * queue and must never be retried), but something about it needs a human.
   * Distinct from `error`, which means the opposite — still queued, will be
   * retried. A warning that read as an error would nag forever on a mutation
   * that has already landed.
   *
   * Today's only source is a field-inspection work order whose "return to
   * shop" pick didn't resolve to a site, so the gear was never marked in
   * transit. The durable copy lives server-side (Ops Dashboard); this is the
   * fast path back to the tech who actually knows where the gear went.
   */
  pushWarnings: string[]
}

export interface SyncCallbacks {
  onStateChange: (state: SyncState) => void
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _state: SyncState = {
  status: 'idle',
  lastSyncedAt: null,
  tableCounts: {},
  error: null,
  pendingMutations: 0,
  pushWarnings: [],
}

let _callbacks: SyncCallbacks | null = null
let _syncTimer: ReturnType<typeof setInterval> | null = null
let _isSyncing = false

function setState(patch: Partial<SyncState>) {
  _state = { ..._state, ...patch }
  _callbacks?.onStateChange(_state)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Initialize the sync engine with callbacks. Call once on app mount. */
export function initSync(callbacks: SyncCallbacks) {
  _callbacks = callbacks
  // Emit initial state
  updatePendingCount()
}

/** Stop the periodic sync timer. */
export function stopSync() {
  if (_syncTimer) {
    clearInterval(_syncTimer)
    _syncTimer = null
  }
}

/** Start the periodic sync loop (every `intervalMs`). Fires immediately too. */
export function startPeriodicSync(intervalMs = 60_000) {
  stopSync()
  // Run immediately
  runFullSync()
  // Then periodically
  _syncTimer = setInterval(() => runFullSync(), intervalMs)
}

/** One-shot: run a full sync cycle (push + pull). */
export async function runFullSync(): Promise<void> {
  if (_isSyncing) return
  _isSyncing = true

  try {
    setState({ status: 'syncing', error: null })

    // 1. Push first — get local changes to server before pulling
    await repairStaleProductReferences()
    await pushMutations()

    // 2. Pull — delta sync reference + writable tables
    await pullAll()

    // 3. Prune — drop stale transactional records to keep the device lean.
    //    Never fails the sync cycle (best-effort hygiene).
    try {
      await pruneOldData()
    } catch (err) {
      console.warn('[sync] prune skipped:', err instanceof Error ? err.message : err)
    }

    // 4. Update pending count
    await updatePendingCount()

    const now = new Date().toISOString()
    if (_state.pendingMutations > 0) {
      setState({ status: 'error', error: `${_state.pendingMutations} uploads still pending. Open the upload queue for details.` })
    } else {
      setState({ status: 'idle', lastSyncedAt: now, error: null })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (err instanceof ApiError && err.status === 401) {
      // Auth expired — let the API interceptor handle redirect
      setState({ status: 'error', error: 'Session expired' })
    } else if (isNetworkError(err)) {
      setState({ status: 'offline', error: 'No connection' })
    } else {
      setState({ status: 'error', error: message.slice(0, 120) })
    }
  } finally {
    _isSyncing = false
  }
}

/** Force a fresh hydrate (wipes syncMeta so next pull fetches everything). */
export async function forceFullHydrate(): Promise<void> {
  await db.syncMeta.clear()
  return runFullSync()
}

/**
 * Nuclear option: wipe ALL offline data and re-sync from server.
 * Clears every Dexie table (reference + writable + local) then pulls fresh.
 */
export async function nukeAndResync(): Promise<void> {
  console.log('[sync] ☢️ Nuking all offline data...')
  // Clear every table in the database
  const tableNames = db.tables.map(t => t.name)
  for (const name of tableNames) {
    await (db as any)[name].clear()
  }
  console.log(`[sync] Cleared ${tableNames.length} tables: ${tableNames.join(', ')}`)
  // Pull everything fresh from server
  console.log('[sync] Re-syncing from server...')
  await runFullSync()
  console.log('[sync] ☢️ Nuke & resync complete')
}

/** Reset all stuck mutations (error or stuck uploading) so they get retried. */
export async function resetStuckMutations(): Promise<number> {
  const stuck = await db.mutationQueue
    .where('status')
    .anyOf(['error', 'uploading'])
    .toArray()

  if (stuck.length === 0) return 0

  console.log(`[sync] Resetting ${stuck.length} stuck mutations:`, stuck.map(m => ({
    queueId: m.queueId, table: m.table, status: m.status,
  })))

  await db.mutationQueue.bulkUpdate(
    stuck.map(m => ({
      key: m.queueId!,
      changes: { status: 'pending' as const, retryCount: 0 },
    }))
  )

  return stuck.length
}

// ---------------------------------------------------------------------------
// PULL — delta sync
// ---------------------------------------------------------------------------

async function pullAll() {
  // Gather watermarks for each table
  const metas = await db.syncMeta.toArray()
  const metaMap = new Map(metas.map(m => [m.table, m]))

  // Build since param — use the oldest watermark if any exist
  // If ANY table has never been synced, do a full hydrate for all
  const needsFullHydrate = ALL_SYNC_TABLES.some(t => !metaMap.has(t))

  const since = needsFullHydrate
    ? undefined
    : oldestWatermark(metas)

  const tablesParam = ALL_SYNC_TABLES.join(',')
  const url = since
    ? `/sync/pull?tables=${tablesParam}&since=${encodeURIComponent(since)}`
    : `/sync/pull?tables=${tablesParam}`

  const response = await api.get<{
    serverNow: string
    tables: Record<string, { data: unknown[]; count: number; allIds?: string[] }>
  }>(url)

  const { serverNow, tables } = response
  const counts: Record<string, number> = {}

  // Repair old-client local children too, even when their parent create was
  // acknowledged before this release. Server pull retains the offline identity.
  for (const row of tables.tickets?.data ?? []) {
    const ticket = row as { id: string; offlineId?: string | null }
    if (ticket.offlineId && ticket.offlineId !== ticket.id) {
      await remapEntityId('tickets', ticket.offlineId, ticket.id)
    }
  }

  // Build the protected-id set from the outbox BEFORE opening the write
  // transaction (Dexie won't let us read mutationQueue from inside a tx scoped
  // to other tables). Any id referenced by a queued mutation — the record
  // itself or a child whose payload points back at it — must survive the
  // orphan prune below, even if the server's scoped `allIds` no longer lists
  // it. Without this, a ticket edited offline (then aged out of the tech's
  // sync window, reassigned, or deleted server-side) gets pruned out from
  // under its own unsynced mutation, losing the edit and orphaning the
  // mutation to retry forever. ids are uuids, so a single cross-table set is
  // safe (no collisions).
  const queuedForProtect = await db.mutationQueue.toArray()
  const protectedIds = new Set<string>()
  for (const m of queuedForProtect) {
    protectedIds.add(m.entityId)
    const p = m.payload as Record<string, unknown>
    const equipmentVisit = p?.equipmentVisit as { requestId?: string } | undefined
    if (equipmentVisit?.requestId) protectedIds.add(equipmentVisit.requestId)
    for (const k of ['ticketId', 'workOrderId', 'rentalAgreementId', 'shopItemId', 'inspectionId'] as const) {
      if (typeof p?.[k] === 'string') protectedIds.add(p[k] as string)
    }
  }

  // Write each table's data into Dexie
  await db.transaction('rw', [...ALL_SYNC_TABLES.map(t => db.table(t)), db.syncMeta], async () => {
    for (const tableName of ALL_SYNC_TABLES) {
      const tableData = tables[tableName]
      if (!tableData) continue

      const { data, count, allIds } = tableData
      counts[tableName] = count

      const dexieTable = db.table(tableName)

      if (needsFullHydrate) {
        // An initial/recovery hydrate must not erase a failed offline create
        // or the local draft the queued mutation is protecting.
        const unsynced = await dexieTable.filter((row: any) =>
          protectedIds.has(row.id) || row._offlineStatus === 'pending',
        ).toArray()
        await dexieTable.clear()
        if (data.length > 0) await dexieTable.bulkPut(data as any[])
        if (unsynced.length > 0) await dexieTable.bulkPut(unsynced)
      } else {
        // Delta — merge: put (upsert) each record
        if (data.length > 0) await dexieTable.bulkPut(data as any[])

        // Prune orphaned records for prunable tables (writable tables, plus
        // pads — see PRUNABLE_TABLES above).
        // Server sends allIds — any local record NOT in that set should be
        // removed UNLESS it still has unsynced work: a pending offline create,
        // or any queued mutation referencing it (protectedIds). Pruning a
        // record with a queued mutation would lose the edit and leave the
        // mutation retrying against a record that no longer exists locally.
        if (allIds && PRUNABLE_TABLES.has(tableName)) {
          const serverIdSet = new Set(allIds)
          const localRecords = await dexieTable.toArray()
          const orphanIds = localRecords
            .filter((r: any) => !serverIdSet.has(r.id) && r._offlineStatus !== 'pending' && !protectedIds.has(r.id))
            .map((r: any) => r.id)
          if (orphanIds.length > 0) {
            console.log(`[sync] Pruning ${orphanIds.length} orphaned ${tableName} records`)
            await dexieTable.bulkDelete(orphanIds)
          }
        }
      }

      // Update watermark
      await db.syncMeta.put({
        table: tableName,
        lastSyncedAt: serverNow,
        lastSyncedCount: count,
      } satisfies SyncMeta)
    }
  })

  setState({ tableCounts: counts })
}

function oldestWatermark(metas: SyncMeta[]): string | undefined {
  if (metas.length === 0) return undefined
  let oldest = metas[0].lastSyncedAt
  for (const m of metas) {
    if (m.lastSyncedAt < oldest) oldest = m.lastSyncedAt
  }
  return oldest
}

// ---------------------------------------------------------------------------
// PRUNE — 30-day rolling cache (offline DB hygiene)
// ---------------------------------------------------------------------------

/** Keep only the last N days of transactional records on the device. Older
 *  synced records are dropped locally — they live on the server and re-hydrate
 *  on demand. Reference data (companies/products/equipment/fields/pads/wells)
 *  is never pruned; it's needed for offline lookups regardless of age. */
const RETENTION_DAYS = 30
/** Pruning is hygiene, not correctness — run it at most this often, not every
 *  60s sync tick. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
let _lastPrunedAt = 0

/**
 * Drop synced transactional records older than RETENTION_DAYS.
 *
 * A parent record is pruned ONLY when every one of these holds:
 *   • it's older than the cutoff (by updatedAt AND, for tickets, serviceDate),
 *   • `_offlineStatus === 'synced'` (never touch local pending/error edits),
 *   • nothing in the mutation queue still references it — neither the record
 *     itself nor any child whose payload points back at it.
 * Children are pruned together with their parent so nothing is left orphaned.
 */
async function pruneOldData(): Promise<void> {
  const now = Date.now()
  if (now - _lastPrunedAt < PRUNE_INTERVAL_MS) return
  _lastPrunedAt = now

  const prunedDrafts = await pruneAbandonedWizardDrafts(now)
  if (prunedDrafts > 0) {
    console.log(`[sync] Pruned ${prunedDrafts} abandoned wizard draft(s) older than 48h`)
  }

  const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Build the protected-parent sets from the outbox. A queued child mutation
  // carries its parent id in the payload (ticketId / workOrderId /
  // rentalAgreementId), so referencing a parent protects the whole subtree.
  const queued = await db.mutationQueue.toArray()
  const protectedTickets = new Set<string>()
  const protectedWorkOrders = new Set<string>()
  const protectedRentals = new Set<string>()
  for (const m of queued) {
    const p = m.payload as Record<string, unknown>
    if (m.table === 'tickets') protectedTickets.add(m.entityId)
    const equipmentVisit = p?.equipmentVisit as { requestId?: string } | undefined
    if (equipmentVisit?.requestId) protectedTickets.add(equipmentVisit.requestId)
    if (typeof p?.ticketId === 'string') protectedTickets.add(p.ticketId)
    if (m.table === 'shopWorkOrders') protectedWorkOrders.add(m.entityId)
    if (typeof p?.workOrderId === 'string') protectedWorkOrders.add(p.workOrderId)
    if (m.table === 'rentalAgreements') protectedRentals.add(m.entityId)
    if (typeof p?.rentalAgreementId === 'string') protectedRentals.add(p.rentalAgreementId)
  }

  /** Delete every row in `child` whose `fk` is in `parentIds`. */
  async function deleteChildrenBy(child: any, fk: string, parentIds: string[]) {
    if (parentIds.length === 0) return
    const keys = await child.where(fk).anyOf(parentIds).primaryKeys()
    if (keys.length) await child.bulkDelete(keys)
  }

  // --- Tickets + all child records ---
  const oldTickets = await db.tickets
    .filter(t =>
      t._offlineStatus === 'synced' &&
      !protectedTickets.has(t.id) &&
      t.updatedAt < cutoff &&
      (t.serviceDate ?? t.updatedAt) < cutoff,
    )
    .primaryKeys()
  if (oldTickets.length > 0) {
    const ids = oldTickets as string[]
    await db.transaction('rw', [
      db.tickets, db.ticketLineItems, db.ticketAttachments, db.fitTestRecords,
      db.airSystemRecords, db.ihTestRecords, db.gasDetectionRecords,
      db.trainingRosterRecords, db.equipmentInspections,
    ], async () => {
      await db.tickets.bulkDelete(ids)
      await deleteChildrenBy(db.ticketLineItems, 'ticketId', ids)
      await deleteChildrenBy(db.ticketAttachments, 'ticketId', ids)
      await deleteChildrenBy(db.fitTestRecords, 'ticketId', ids)
      await deleteChildrenBy(db.airSystemRecords, 'ticketId', ids)
      await deleteChildrenBy(db.ihTestRecords, 'ticketId', ids)
      await deleteChildrenBy(db.gasDetectionRecords, 'ticketId', ids)
      await deleteChildrenBy(db.trainingRosterRecords, 'ticketId', ids)
      await deleteChildrenBy(db.equipmentInspections, 'ticketId', ids)
    })
    console.log(`[sync] Pruned ${ids.length} ticket(s) older than ${RETENTION_DAYS}d (+ children)`)
  }

  // --- Closed/complete shop work orders + items + transfer events ---
  const oldWOs = await db.shopWorkOrders
    .filter(w =>
      w._offlineStatus === 'synced' &&
      !protectedWorkOrders.has(w.id) &&
      (w.status === 'closed' || w.status === 'complete') &&
      w.updatedAt < cutoff,
    )
    .primaryKeys()
  if (oldWOs.length > 0) {
    const ids = oldWOs as string[]
    await db.transaction('rw', [db.shopWorkOrders, db.shopWorkOrderItems, db.shopTransferEvents], async () => {
      await db.shopWorkOrders.bulkDelete(ids)
      await deleteChildrenBy(db.shopWorkOrderItems, 'workOrderId', ids)
      await deleteChildrenBy(db.shopTransferEvents, 'workOrderId', ids)
    })
    console.log(`[sync] Pruned ${ids.length} closed shop WO(s) older than ${RETENTION_DAYS}d (+ items)`)
  }

  // --- Completed/cancelled rental agreements + items + daily logs ---
  const oldRentals = await db.rentalAgreements
    .filter(r =>
      r._offlineStatus === 'synced' &&
      !protectedRentals.has(r.id) &&
      (r.status === 'completed' || r.status === 'cancelled') &&
      r.updatedAt < cutoff,
    )
    .primaryKeys()
  if (oldRentals.length > 0) {
    const ids = oldRentals as string[]
    await db.transaction('rw', [db.rentalAgreements, db.rentalAgreementItems, db.rentalDailyLogs], async () => {
      await db.rentalAgreements.bulkDelete(ids)
      await deleteChildrenBy(db.rentalAgreementItems, 'rentalAgreementId', ids)
      await deleteChildrenBy(db.rentalDailyLogs, 'rentalAgreementId', ids)
    })
    console.log(`[sync] Pruned ${ids.length} completed rental(s) older than ${RETENTION_DAYS}d (+ logs)`)
  }
}

// ---------------------------------------------------------------------------
// PUSH — drain mutation queue
// ---------------------------------------------------------------------------

const MAX_BATCH = 20
const MAX_RETRIES = 5

/** Recover catalog IDs replaced by a database refresh without changing the quoted line. */
async function repairStaleProductReferences() {
  const failed = await db.mutationQueue.filter(m =>
    m.table === 'ticketLineItems' && m.action !== 'delete' && m.status === 'error' &&
    /\bInvalid productId\b/.test(m.errorMessage ?? ''),
  ).toArray()
  if (!failed.length) return

  const response = await api.get<{
    tables: { products?: { data: Array<{ id: string; partNumber: string }> } }
  }>('/sync/pull?tables=products')
  const products = response.tables.products?.data
  if (!products) return
  const byPart = new Map(products.map(p => [p.partNumber, p.id]))
  for (const mutation of failed) {
    const oldId = mutation.payload.productId
    if (typeof oldId !== 'string' || !oldId) continue
    const cached = await db.products.get(oldId)
    const partNumber = mutation.payload.partNumber || cached?.partNumber
    if (typeof partNumber !== 'string' || !partNumber) continue
    // Conflicting identities require a person to choose the product.
    if (cached?.partNumber && cached.partNumber !== partNumber) continue
    const productId = byPart.get(partNumber)
    if (!productId || productId === oldId) continue
    await db.transaction('rw', [db.mutationQueue, db.ticketLineItems], async () => {
      await db.mutationQueue.update(mutation.queueId!, {
        payload: { ...mutation.payload, productId },
        status: 'pending', retryCount: 0, errorMessage: undefined,
      })
      await db.ticketLineItems.update(mutation.entityId, { productId })
    })
  }
}

async function pushMutations() {
  // Grab pending mutations, ordered by creation time
  // Also pick up 'uploading' in case a previous sync was interrupted mid-push
  const pending = await db.mutationQueue
    .where('status')
    .anyOf(['pending', 'error', 'uploading'])
    .filter(m => (m.retryCount || 0) < MAX_RETRIES)
    .sortBy('createdAt')

  if (pending.length === 0) return

  // Track ID remaps so child mutations (line items, fit test records) can
  // reference the server-assigned ticket ID instead of the offline ID
  const idRemaps = new Map<string, string>()

  // Soft warnings the server attached to mutations it ACCEPTED. Accumulated
  // across batches and published once at the end, so a warning survives the
  // queue delete that immediately follows it.
  const pushWarnings: string[] = []

  // A submission barrier must run after its edits have been acknowledged,
  // including edits in another batch or exhausted-error entries. Never send a
  // barrier in the same request as dependencies whose outcome is still unknown.
  let remaining = [...pending]
  while (remaining.length) {
    const queuedIds = new Set((await db.mutationQueue.toArray()).map(m => m.queueId))
    const batch = remaining.filter(m => !(m.dependsOn ?? []).some(id => queuedIds.has(id))).slice(0, MAX_BATCH)
    if (!batch.length) break
    const sentIds = new Set(batch.map(m => m.queueId))
    remaining = remaining.filter(m => !sentIds.has(m.queueId))

    // Mark as uploading
    await db.mutationQueue.bulkUpdate(
      batch.map(m => ({
        key: m.queueId!,
        changes: { status: 'uploading' as const },
      }))
    )

    try {
      // Before sending, remap IDs so records reference the server-assigned
      // ticket ID instead of the offline ID.  This covers two cases:
      //  1. Child records (line items, fit tests) whose payload.ticketId
      //     points at an offline ticket ID that was created earlier in this
      //     sync cycle.
      //  2. Update/delete mutations whose entityId references a ticket that
      //     was created earlier in the same batch (e.g. editing an offline-
      //     created ticket before it syncs).
      const mutationsToSend = batch.map(m => {
        let payload = m.payload
        let entityId = m.entityId

        // Remap entityId for update/delete of a recently-created entity
        if (m.action !== 'create' && idRemaps.has(m.entityId)) {
          entityId = idRemaps.get(m.entityId)!
        }

        // Remap ticketId in child record payloads
        if (m.table !== 'tickets' && payload.ticketId && idRemaps.has(payload.ticketId as string)) {
          payload = { ...payload, ticketId: idRemaps.get(payload.ticketId as string) }
        }

        // Remap rentalAgreementId in rental item + daily log payloads
        if ((m.table === 'rentalAgreementItems' || m.table === 'rentalDailyLogs') && payload.rentalAgreementId && idRemaps.has(payload.rentalAgreementId as string)) {
          payload = { ...payload, rentalAgreementId: idRemaps.get(payload.rentalAgreementId as string) }
        }

        // Remap workOrderId in shop work order item payloads
        if (m.table === 'shopWorkOrderItems' && payload.workOrderId && idRemaps.has(payload.workOrderId as string)) {
          payload = { ...payload, workOrderId: idRemaps.get(payload.workOrderId as string) }
        }

        // Remap workOrderId in shop transfer event payloads (Wave 2)
        if (m.table === 'shopTransferEvents' && payload.workOrderId && idRemaps.has(payload.workOrderId as string)) {
          payload = { ...payload, workOrderId: idRemaps.get(payload.workOrderId as string) }
        }

        // Remap parent IDs in equipment inspection payloads (Wave 1)
        // Polymorphic: parent is either a shopWorkOrderItem or a serviceTicket
        if (m.table === 'equipmentInspections') {
          if (payload.shopItemId && idRemaps.has(payload.shopItemId as string)) {
            payload = { ...payload, shopItemId: idRemaps.get(payload.shopItemId as string) }
          }
          if (payload.ticketId && idRemaps.has(payload.ticketId as string)) {
            payload = { ...payload, ticketId: idRemaps.get(payload.ticketId as string) }
          }
        }

        return {
          queueId: m.queueId,
          table: m.table,
          action: m.action,
          entityId,
          offlineId: m.offlineId,
          payload,
        }
      })

      const response = await api.post<{
        results: Array<{
          queueId: number
          status: 'ok' | 'error'
          serverId?: string
          ticketId?: string
          error?: string
          warnings?: string[]
        }>
      }>('/sync/push', { mutations: mutationsToSend })

      // Track which mutations we successfully processed
      const processedQueueIds = new Set<number>()

      // Process results — use == instead of === to handle potential
      // string/number type mismatch from JSON round-trip
      for (const result of response.results) {
        // eslint-disable-next-line eqeqeq
        const mut = batch.find(m => m.queueId == result.queueId)
        if (!mut) {
          console.warn('[sync] No batch match for result queueId:', result.queueId, typeof result.queueId)
          continue
        }

        processedQueueIds.add(mut.queueId!)

        if (result.status === 'ok') {
          // Committed but not clean: the server honored the mutation and told
          // us something about it needs looking at. Collected BEFORE the queue
          // delete below, because after that there is no record on this device
          // that the mutation ever existed.
          if (result.warnings?.length) {
            for (const w of result.warnings) {
              console.warn(`[sync] Mutation warning: table=${mut.table} queueId=${mut.queueId}`, w)
              pushWarnings.push(w)
            }
          }

          // Track ID remap so child records in later batches can use server ID
          if (result.serverId && result.serverId !== mut.entityId) {
            idRemaps.set(mut.entityId, result.serverId)
            await remapEntityId(mut.table, mut.entityId, result.serverId)
          }
          if (result.ticketId && typeof mut.payload.ticketId === 'string' && result.ticketId !== mut.payload.ticketId) {
            idRemaps.set(mut.payload.ticketId, result.ticketId)
            await remapEntityId('tickets', mut.payload.ticketId, result.ticketId)
          }

          // Acknowledge only after the durable remap. If remapping fails or the
          // browser closes, the create can be replayed instead of losing its ID.
          await db.mutationQueue.delete(mut.queueId!)

          // Mark local record as synced
          try {
            const localTable = db.table(mut.table)
            const recordId = result.serverId || mut.entityId
            await localTable.update(recordId, { _offlineStatus: 'synced' })
          } catch {
            // Record may have been deleted or doesn't exist locally — that's fine
          }

          // Hop 1 of the attachment pipeline closes HERE and nowhere else.
          // The server has acknowledged the bytes, so the device's copy is
          // finally redundant and gets dropped. Note this is the SP server's
          // ack, not the object store's — the server holds it from here, and
          // its own upload to B2 is a separate hop the device is not waiting on.
          if (mut.table === 'attachments' && mut.action === 'create') {
            const recordId = result.serverId || mut.entityId
            await markAttachmentSynced(recordId).catch(() => {
              // Failing to free the local copy just costs device storage; the
              // next capture screen will show it as pending. Never fatal.
            })
          }
        } else if (
          mut.action !== 'create' &&
          isRecordNotFoundError(result.error) &&
          !pending.some(m => m.action === 'create' && m.entityId === mut.entityId)
        ) {
          // Terminal error: an update/delete against a record the server no
          // longer has, with no queued create that would bring it back. This
          // can never succeed — retrying it is the infinite-loop nag field
          // techs reported (resetStuckMutations() would otherwise revive it on
          // every focus/online). Drop it so the queue clears and the now-
          // unprotected local ghost gets pruned on the next pull.
          console.warn(`[sync] Dropping doomed ${mut.action} (record gone server-side): table=${mut.table} queueId=${mut.queueId} entityId=${mut.entityId}`, result.error)
          await db.mutationQueue.delete(mut.queueId!)
        } else {
          // Error — mark for retry
          console.warn(`[sync] Mutation error: table=${mut.table} queueId=${mut.queueId}`, result.error)
          await db.mutationQueue.update(mut.queueId!, {
            status: 'error' as const,
            retryCount: (mut.retryCount || 0) + 1,
            errorMessage: result.error || 'Unknown server error',
          })
        }
      }

      // Safety net: if any mutations in this batch weren't matched in the
      // results (e.g. server returned fewer results than expected), revert
      // them to pending so they get retried on the next sync cycle.
      const unmatched = batch.filter(m => !processedQueueIds.has(m.queueId!))
      if (unmatched.length > 0) {
        console.warn('[sync] Unmatched mutations after push, reverting to pending:', unmatched.map(m => m.queueId))
        await db.mutationQueue.bulkUpdate(
          unmatched.map(m => ({
            key: m.queueId!,
            changes: { status: 'pending' as const },
          }))
        )
      }

      // Update pending count immediately after each batch so UI reflects progress
      await updatePendingCount()
    } catch (err) {
      // Network error — revert batch to pending
      await db.mutationQueue.bulkUpdate(
        batch.map(m => ({
          key: m.queueId!,
          changes: { status: 'pending' as const },
        }))
      )
      throw err // Propagate to abort the sync cycle
    }
  }

  // Replace rather than append: these describe the push that just happened.
  // A quiet cycle returns above (no pending mutations, no push), so a warning
  // survives until the device actually pushes again rather than being wiped
  // 60 seconds later — but it IS transient by design. The authoritative,
  // durable copy is server-side on the work order and counted on the Ops
  // Dashboard; this is only the fast path back to the tech holding the gear.
  // Only assigned when something changes, to avoid needless state churn.
  if (pushWarnings.length > 0 || _state.pushWarnings.length > 0) {
    setState({ pushWarnings })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updatePendingCount() {
  const all = await db.mutationQueue
    .where('status')
    .anyOf(['pending', 'error', 'uploading'])
    .toArray()
  // Only count mutations that haven't exhausted retries
  const actionable = all.filter(m => (m.retryCount || 0) < MAX_RETRIES)
  const dead = all.length - actionable.length
  if (dead > 0) {
    console.warn(`[sync] ${dead} mutations have exhausted retries (${MAX_RETRIES}+) and are stuck`)
  }
  setState({ pendingMutations: all.length })
}

/**
 * True when a server-side mutation error means the target record does not
 * exist (Prisma P2025). The server forwards the raw Prisma message, so we
 * match on its stable phrasing. Used to drop doomed update/delete mutations
 * instead of retrying them forever.
 */
function isRecordNotFoundError(error: string | undefined): boolean {
  if (!error) return false
  const e = error.toLowerCase()
  return (
    e.includes('no record was found') ||
    e.includes('records that were required but not found') ||
    e.includes('record to update not found') ||
    e.includes('record to delete does not exist') ||
    e.includes('p2025')
  )
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && err.message.includes('fetch')) return true
  if (err instanceof Error && err.message.includes('NetworkError')) return true
  if (err instanceof Error && err.message.includes('Failed to fetch')) return true
  return false
}
