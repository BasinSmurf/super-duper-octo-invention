import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function load(path, name, context) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let fn
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) fn = node.getText(ast); ts.forEachChild(node, visit) }
  visit(ast)
  assert.ok(fn)
  return runInNewContext(ts.transpileModule(`${fn.replace(/^export /, '')}; ${name}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
}

function fixture() {
  let rows = [], nextId = 1, transactional = false, committed = []
  const state = { serverStatus: 'in_progress', edits: 0, failedId: null, lostResponse: false, requests: [] }
  const query = filter => ({
    toArray: async () => rows.filter(filter),
    filter: extra => query(m => filter(m) && extra(m)),
    sortBy: async key => rows.filter(filter).sort((a, b) => String(a[key]).localeCompare(String(b[key]))),
  })
  const queue = {
    toArray: async () => [...rows],
    where: key => ({ equals: value => query(m => m[key] === value), anyOf: values => query(m => values.includes(m[key])) }),
    add: async value => { const id = nextId++; rows.push({ ...value, queueId: id }); if (!transactional) committed = [...rows]; return id },
    update: async (id, changes) => { Object.assign(rows.find(m => m.queueId === id), changes) },
    bulkUpdate: async updates => { for (const u of updates) await queue.update(u.key, u.changes) },
    delete: async id => { rows = rows.filter(m => m.queueId !== id) },
  }
  const table = { put: async () => {}, update: async () => {}, delete: async () => {} }
  const db = { mutationQueue: queue, tickets: table, ticketLineItems: table, ticketAttachments: table, trainingRosterRecords: table, equipmentInspections: table, shopWorkOrders: table,
    table: () => table,
    transaction: async (mode, tables, fn) => {
      const prior = structuredClone(rows); transactional = true
      try { await fn(); committed = [...rows] } catch (e) { rows = prior; throw e } finally { transactional = false }
    },
  }
  const api = { post: async (_, { mutations }) => {
    state.requests.push(mutations)
    const results = mutations.map(m => {
      if (m.entityId === state.failedId) return { queueId: m.queueId, status: 'error', error: 'Synthetic retryable failure' }
      if (['trainingRosterRecords', 'ticketLineItems', 'equipmentInspections', 'shopWorkOrders'].includes(m.table)) {
        assert.equal(state.serverStatus, 'in_progress', 'no roster mutation may arrive after submission')
        state.edits++
      } else if (m.payload.status === 'supervisor_review') state.serverStatus = 'supervisor_review'
      return { queueId: m.queueId, status: 'ok', serverId: m.entityId }
    })
    if (state.lostResponse) { state.lostResponse = false; throw Error('Synthetic lost response') }
    return { results }
  } }
  const persist = load('./src/lib/trainingSubmission.ts', 'persistTicketBatch', { db })
  const push = load('./src/lib/syncEngine.ts', 'pushMutations', { db, api, MAX_BATCH: 20, MAX_RETRIES: 5,
    console: { log() {}, warn() {} }, _state: { pushWarnings: [] }, setState() {}, updatePendingCount: async () => {},
    isRecordNotFoundError: () => false, remapEntityId: async () => {},
  })
  const enqueue = (table, entityId, payload) => queue.add({ table, entityId, payload, action: 'update', createdAt: '2026-09-28', status: 'pending', retryCount: 0 })
  async function save(fail = false) {
    await persist('class', true, '2026-09-28', async () => {
      await enqueue('tickets', 'class', { status: 'in_progress' })
      for (let i = 0; i < 20; i++) {
        await enqueue('trainingRosterRecords', `student-${i}`, { ticketId: 'class' })
        assert.equal(committed.length, 0, 'background sync must not see a partial local save')
        if (fail && i === 10) throw Error('Synthetic local failure')
      }
    })
  }
  return { state, db, persist, push, save, rows: () => rows }
}

test('20-student save spans batches and only submits after every roster acknowledgement', async () => {
  const f = fixture(); await f.save(); await f.push()
  assert.equal(f.state.edits, 20)
  assert.equal(f.state.serverStatus, 'supervisor_review')
  assert.deepEqual(f.state.requests.map(r => r.length), [20, 1, 1])
  assert.equal(f.rows().length, 0)
})
test('a failed or exhausted roster edit blocks submission until a successful retry', async () => {
  const f = fixture(); await f.save(); f.state.failedId = 'student-19'; await f.push()
  assert.equal(f.state.serverStatus, 'in_progress')
  assert.equal(f.rows().length, 2)
  const failed = f.rows().find(m => m.entityId === 'student-19'); failed.retryCount = 5
  await f.push(); assert.equal(f.state.serverStatus, 'in_progress')
  failed.retryCount = 0; f.state.failedId = null; await f.push()
  assert.equal(f.state.serverStatus, 'supervisor_review'); assert.equal(f.rows().length, 0)
})
test('lost response leaves the submission pending and permits replay of the edits first', async () => {
  const f = fixture(); await f.save(); f.state.lostResponse = true
  await assert.rejects(f.push(), /lost response/)
  assert.equal(f.state.serverStatus, 'in_progress')
  await f.push(); assert.equal(f.state.serverStatus, 'supervisor_review'); assert.equal(f.rows().length, 0)
})
test('local failure rolls back the whole class outbox, including its premature parent write', async () => {
  const f = fixture(); await assert.rejects(f.save(true), /local failure/)
  assert.equal(f.rows().length, 0)
})

test('field review waits for the priced lines, inspection ledger, and failed-unit shop handoff', async () => {
  const f = fixture()
  await f.persist('field', true, '2026-09-28', async () => {
    for (const [table, entityId, payload] of [
      ['tickets', 'field', { status: 'in_progress' }],
      ['ticketLineItems', 'charge', { ticketId: 'field', rate: 5, quantity: 1 }],
      ['equipmentInspections', 'pass', { ticketId: 'field' }],
      ['shopWorkOrders', 'shop', { items: [{ customData: { fieldInspectionRecord: { sourceTicketOfflineId: 'field' } } }] }],
    ]) await f.db.mutationQueue.add({ table, entityId, payload, action: 'create', createdAt: '2026-09-28', status: 'pending', retryCount: 0 })
  })
  assert.equal(f.rows().at(-1).dependsOn.length, 4)
  f.state.failedId = 'shop'
  await f.push()
  assert.equal(f.state.serverStatus, 'in_progress')
  assert.equal(f.rows().length, 2)
  f.state.failedId = null
  await f.push()
  assert.equal(f.state.serverStatus, 'supervisor_review')
  assert.equal(f.rows().length, 0)
})

test('the edited wizard completion stages the ticket, twenty roster rows, and a dependent submission', async () => {
  const f = fixture()
  let error = '', navigated = false
  const records = Array.from({ length: 20 }, (_, i) => ({ id: `student-${i}`, employeeName: `SYNTHETIC ${i}`, passed: true }))
  const save = load('./src/pages/TicketWizard.tsx', 'handleSaveEdit', {
    db: f.db, persistTicketBatch: f.persist, editTicketId: 'class', customer: {}, arrivedAt: 'start', departedAt: 'end',
    requiresSiteSignEvidence: false, workType: 'training', originalStatus: 'in_progress', signature: 'synthetic',
    setSaving() {}, setError: value => { error = value }, buildTicketPayload: () => ({}), locationBreadcrumb: () => 'SYNTHETIC',
    lineItems: [], originalLineItemIds: new Set(), serviceType: 'training', d3HasAir: false, d3HasGas: false, d3HasIh: false,
    trainingRosterRecords: records, originalTrainingRosterIds: new Set(records.map(r => r.id)), serviceDate: '2026-09-28',
    photos: [], siteSignPhotos: [], clearDraft: async () => {}, navigate: () => { navigated = true },
  })
  await save('supervisor_review')
  assert.equal(error, ''); assert.equal(navigated, true)
  assert.equal(f.rows()[0].payload.status, 'in_progress')
  assert.equal(f.rows().at(-1).dependsOn.length, 21)
  await f.push()
  assert.equal(f.state.edits, 20); assert.equal(f.state.serverStatus, 'supervisor_review')
})
