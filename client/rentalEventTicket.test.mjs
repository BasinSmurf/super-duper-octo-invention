import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const compiled = ts.transpileModule(readFileSync(new URL('./src/lib/rentalEventTicket.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function harness(existing) {
  const tickets = new Map(existing ? [[existing.id, existing]] : [])
  const lines = [], mutations = []
  const db = { tickets: { get: async id => tickets.get(id), put: async row => tickets.set(row.id, row) },
    ticketLineItems: { put: async row => lines.push(row) }, mutationQueue: { add: async row => mutations.push(row) },
    transaction: async (_mode, _tables, action) => action() }
  const exports = {}
  runInNewContext(compiled, { exports, require: () => ({ db }) })
  return { queue: exports.queueRentalEventTicket, tickets, lines, mutations }
}
const input = { id: 'visit', rental: { id: 'job', companyId: 'customer', padId: 'pad', poNumber: 'PO' },
  serviceDate: '2026-09-22', userId: 'tech', description: 'Equipment deployment\nMonitor: 123',
  lines: [{ id: 'labor', lineType: 'labor', quantity: 2, rate: 85, total: 999 }, { id: 'miles', lineType: 'travel', quantity: 40, rate: 3 }] }
for (const workType of ['rental_deploy', 'rental_return']) test(`${workType} stays on the job with time and mileage and is retry safe`, async () => {
  const h = harness()
  await h.queue({ ...input, workType })
  assert.equal(h.tickets.get('visit').linkedRentalAgreementId, 'job')
  assert.equal(h.tickets.get('visit').customData.workType, workType)
  assert.equal(h.tickets.get('visit').serviceDate, '2026-09-22')
  assert.equal(h.tickets.get('visit').status, 'supervisor_review')
  assert.deepEqual(h.mutations.map(mutation => mutation.table), ['tickets', 'ticketLineItems', 'ticketLineItems', 'tickets'])
  assert.equal(h.mutations[0].payload.status, 'in_progress')
  assert.equal(h.mutations.at(-1).payload.status, 'supervisor_review')
  assert.deepEqual(h.lines.map(line => line.total), [170, 120])
  assert.equal(h.lines[0].notes, input.description)
  await h.queue({ ...input, workType })
  assert.equal(h.mutations.length, 4)
})
test('resuming a saved Deploy draft updates that ticket rather than silently skipping it', async () => {
  const h = harness({ id: 'visit', status: 'draft' })
  await h.queue({ ...input, workType: 'rental_deploy' })
  assert.equal(h.mutations[0].action, 'update')
  assert.equal(h.tickets.get('visit').status, 'supervisor_review')
})
test('unpriced visit lines cannot silently become free', async () => {
  const h = harness()
  await assert.rejects(h.queue({ ...input, workType: 'rental_return', lines: [{ lineType: 'labor', rate: null }] }), /Enter a rate/)
  assert.equal(h.mutations.length, 0)
})

test('an assigned deploy ticket is updated even before its first device sync', async () => {
  const h = harness()
  const manualEquipment = [{ id: 'gear', serial: 'ABC', type: 'Trailer', testDate: '10/01/2026', deployedAt: '2026-10-08T14:00:00Z' }]
  await h.queue({ ...input, assignedTicketId: input.id, workType: 'rental_deploy', manualEquipment })
  assert.equal(h.mutations[0].action, 'update')
  assert.equal(h.mutations[0].entityId, input.id)
  assert.equal(h.mutations[0].payload.customData.manualEquipment[0].serial, 'ABC')
  assert.equal(h.mutations.at(-1).payload.status, 'supervisor_review')
})

test('completing a synced dispatched ticket retains its identity', async () => {
  const h = harness({ id: 'visit', status: 'dispatched' })
  await h.queue({ ...input, assignedTicketId: input.id, workType: 'rental_deploy' })
  assert.equal(h.mutations[0].action, 'update')
  assert.equal(h.mutations.filter(row => row.table === 'tickets' && row.action === 'create').length, 0)
})

const page = readFileSync(new URL('./src/pages/RentalReturnPage.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('Return.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let node
function find(n) { if (ts.isFunctionDeclaration(n) && n.name?.text === 'handleInspected') node = n; ts.forEachChild(n, find) }
find(ast)
test('Return posts all per-item inspections and selected rows atomically', async () => {
  const posts = []
  const first = { id: 'first', type: 'Monitor', serial: '123', testDate: 'see tag' }
  const second = { ...first, id: 'second', serial: '456' }
  const context = { agreementId: 'job', rental: input.rental, batchItems: [first, second], batchReturnDate: input.serviceDate,
    ticketId: 'visit', user: { id: 'tech' }, lineItems: input.lines, submitting: { current: false },
    setSaving() {}, setInspecting() {}, setItems() {}, setDone: value => { context.done = value }, setError: value => { context.error = value },
    saveManualRentalVisit: async (...args) => posts.push(args),
  }
  context.inspectionIndex = 0; context.itemInspections = {}; context.setInspectionIndex = value => { context.inspectionIndex = value }; context.setItemInspections = value => { context.itemInspections = value }
  const fn = runInNewContext(ts.transpileModule(`${node.getText(ast)}; handleInspected`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  const inspection = { overallCondition: 'good', notes: 'Both checked' }
  await fn(inspection)
  assert.equal(posts.length, 0)
  await fn({ ...inspection, overallCondition: 'needs_repair' })
  assert.equal(context.done, true)
  assert.equal(posts.length, 1)
  assert.equal(posts[0][0], input.rental)
  assert.equal(posts[0][1].selections[0].inspection, inspection)
  assert.equal(posts[0][1].selections[1].inspection.overallCondition, 'needs_repair')
  assert.deepEqual(Array.from(posts[0][1].selections, row => row.itemId), ['first', 'second'])
  assert.equal(posts[0][1].serviceDate, input.serviceDate)
  assert.equal(posts[0][1].lineItems, input.lines)
})

test('failed batch return stays open for retry without reporting success', async () => {
  const context = { agreementId: 'job', rental: input.rental, batchItems: [{ id: 'first' }], batchReturnDate: input.serviceDate,
    ticketId: 'visit', user: { id: 'tech' }, lineItems: [], submitting: { current: false },
    setSaving() {}, setInspecting() { throw new Error('Must remain open') }, setItems() {}, setDone() { throw new Error('Must not succeed') }, setError: value => { context.error = value },
    saveManualRentalVisit: async () => { throw new Error('Conflict') }, Error,
  }
  context.inspectionIndex = 0; context.itemInspections = {}; context.setInspectionIndex = value => { context.inspectionIndex = value }; context.setItemInspections = value => { context.itemInspections = value }
  const fn = runInNewContext(ts.transpileModule(`${node.getText(ast)}; handleInspected`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  await fn({ overallCondition: 'good' })
  assert.equal(context.error, 'Conflict')
  assert.equal(context.submitting.current, false)
})
