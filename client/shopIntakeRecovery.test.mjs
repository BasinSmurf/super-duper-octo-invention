import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const compiled = ts.transpileModule(readFileSync(new URL('./src/lib/shopIntakeRecovery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
function harness({ reject, loseRead = false } = {}) {
  const mutation = { queueId: 1, table: 'shopWorkOrders', action: 'create', entityId: 'original-id', payload: { items: [{ serialNumber: 'SERIAL-1', customData: { binLocation: 'Bin 13' } }] } }
  const unrelated = { queueId: 2, table: 'tickets', action: 'create', entityId: 'unrelated' }
  const state = { rows: [mutation, unrelated], requests: [], headers: [], items: [], error: null }
  const db = {
    mutationQueue: {
      filter: predicate => ({ first: async () => state.rows.find(predicate) }),
      delete: async id => { state.rows = state.rows.filter(row => row.queueId !== id) },
      update: async (_id, changes) => { state.error = changes.errorMessage },
    },
    shopWorkOrders: { update: async (id, changes) => state.headers.push({ id, changes }) },
    shopWorkOrderItems: { bulkPut: async items => { state.items = items } },
    transaction: async (_mode, _tables, run) => run(),
  }
  const api = {
    post: async (url, body) => {
      state.requests.push({ url, body })
      return { results: [{ queueId: 1, status: reject ? 'error' : 'ok', serverId: 'original-id', error: reject }] }
    },
    get: async () => { if (loseRead) throw new Error('Connection lost'); return { id: 'original-id', workOrderNumber: 'SW-123', status: 'intake', items: [{ id: 'saved-item', workOrderId: 'original-id', serialNumber: 'SERIAL-1', childComponents: [{ id: 'component', parentItemId: 'saved-item' }] }] } },
  }
  const exports = {}
  runInNewContext(compiled, { exports, Error, require: name => name === './api' ? { api } : { db } })
  return { ...exports, state }
}
test('recovery sends exactly one original intake and preserves unrelated queued work', async () => {
  const h = harness()
  await h.retryShopIntake('original-id')
  assert.equal(h.state.requests.length, 1)
  assert.equal(h.state.requests[0].body.mutations.length, 1)
  assert.equal(h.state.requests[0].body.mutations[0].entityId, 'original-id')
  assert.equal(h.state.requests[0].body.mutations[0].payload.items[0].serialNumber, 'SERIAL-1')
  assert.deepEqual(h.state.rows.map(r => r.queueId), [2])
  assert.equal(h.state.headers[0].changes.workOrderNumber, 'SW-123')
  assert.equal(h.state.items.length, 2)
  assert.equal(h.state.items[0].serialNumber, 'SERIAL-1')
})
test('server rejection shows its reason and preserves equipment for another attempt', async () => {
  const h = harness({ reject: 'Bin belongs to another job' })
  await assert.rejects(h.retryShopIntake('original-id'), /Bin belongs/)
  assert.equal(h.state.rows.length, 2)
  assert.equal(h.state.headers.length, 0)
  assert.equal(h.state.error, 'Bin belongs to another job')
})
test('a lost verification response keeps the original ID and local equipment for safe retry', async () => {
  const h = harness({ loseRead: true })
  await assert.rejects(h.retryShopIntake('original-id'), /Connection lost/)
  assert.equal(h.state.rows.length, 2)
  assert.equal(h.state.headers.length, 0)
})
test('a missing queued intake does not send unrelated records', async () => {
  const h = harness()
  await assert.rejects(h.retryShopIntake('missing'), /could not be found/)
  assert.equal(h.state.requests.length, 0)
})
