import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const compiled = ts.transpileModule(readFileSync(new URL('./src/lib/manualRentalVisit.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
class ApiError extends Error {}
const gear = { id: 'first', serial: '123', type: 'Monitor', testDate: 'see tag', deployedAt: '2026-08-01' }
const rental = { id: 'ra', companyId: 'customer', status: 'active', items: [], composition: { trailer: { rate: 300 }, manualEquipment: [gear, { ...gear, id: 'second', serial: '456' }] } }
const inspection = { overallCondition: 'good', notes: 'Inspected together', damagePhotos: [{ id: 'photo', dataUrl: 'data:image/jpeg;base64,example' }] }
const visit = { requestId: 'visit', workType: 'rental_return', serviceDate: '2026-08-15', selections: [{ itemId: 'first', expected: gear }, { itemId: 'second' }], inspection,
  lineItems: [{ id: 'labor', lineType: 'labor', quantity: 2, rate: 90 }, { id: 'miles', lineType: 'travel', quantity: 40, rate: 3 }] }
function harness(failure = new TypeError('Network unavailable')) {
  const tickets = new Map(), rentals = new Map(), lines = [], mutations = []
  const db = { tickets: { get: async id => tickets.get(id), put: async row => tickets.set(row.id, row) },
    rentalAgreements: { get: async id => rentals.get(id), put: async row => rentals.set(row.id, row) },
    ticketLineItems: { put: async row => lines.push(row) }, mutationQueue: { add: async row => mutations.push(row) },
    transaction: async (_mode, _tables, action) => action() }
  const exported = {}
  runInNewContext(compiled, { exports: exported, TypeError, Error, require: name => name === './db' ? { db } : { ApiError, api: { post: async () => { if (failure) throw failure; return { id: 'visit' } } } } })
  return { save: exported.saveManualRentalVisit, tickets, rentals, lines, mutations }
}
test('offline batch return stores one inspection and queues gear, charges and closure as one command', async () => {
  const h = harness()
  await h.save(rental, visit, 'tech')
  assert.equal(h.mutations.length, 1)
  assert.equal(h.mutations[0].table, 'rentalAgreements')
  assert.equal(h.mutations[0].payload.equipmentVisit.inspection, inspection)
  assert.equal(h.tickets.get('visit').customData.inspection.data, inspection)
  assert.equal(h.tickets.get('visit').customData.inspection.itemIds.length, 2)
  assert.deepEqual(Array.from(h.rentals.get('ra').composition.manualEquipment, row => row.returnInspectionId), ['visit', 'visit'])
  assert.equal(h.rentals.get('ra').status, 'completed')
  assert.equal(h.rentals.get('ra').endDate, visit.serviceDate)
  assert.deepEqual(h.lines.map(line => line.total), [180, 120])
  await h.save(rental, visit, 'tech')
  assert.equal(h.mutations.length, 1)
})
test('offline partial return leaves unselected rows and agreement active', async () => {
  const h = harness()
  await h.save(rental, { ...visit, selections: [visit.selections[0]] }, 'tech')
  assert.equal(h.rentals.get('ra').status, 'active')
  assert.equal(h.rentals.get('ra').composition.manualEquipment[1].status, undefined)
})
test('offline swap preserves deployment and pricing with old and new text snapshots', async () => {
  const h = harness()
  await h.save(rental, { ...visit, workType: 'rental_swap', inspection: undefined, selections: [{ itemId: 'first', expected: gear, replacement: { serial: 'NEW', type: 'Custom', testDate: 'see sticker' } }] }, 'tech')
  assert.equal(h.rentals.get('ra').composition.manualEquipment[0].serial, 'NEW')
  assert.equal(h.rentals.get('ra').composition.manualEquipment[0].deployedAt, gear.deployedAt)
  assert.equal(h.rentals.get('ra').composition.trailer.rate, 300)
  assert.equal(h.tickets.get('visit').customData.equipmentChanges[0].before.serial, '123')
})
test('server validation and permission errors stay visible and never queue a rejected return', async () => {
  const h = harness(new ApiError('Equipment changed'))
  await assert.rejects(h.save(rental, visit, 'tech'), /Equipment changed/)
  assert.equal(h.mutations.length, 0)
})
test('online success does not enqueue a second copy', async () => {
  const h = harness(null)
  assert.equal((await h.save(rental, visit, 'tech')).id, 'visit')
  assert.equal(h.mutations.length, 0)
})
