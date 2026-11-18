import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('TicketWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let declaration
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submitRentalAgreement') declaration = node
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(declaration)
const compiled = ts.transpileModule('export ' + declaration.getText(ast), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText

const helperExports = {}
runInNewContext(ts.transpileModule(readFileSync(new URL('./src/lib/rentalDeploymentItems.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: helperExports })

test('editing deployment after scanning updates all item dates and preserves the exact time for sync', async () => {
  const mutations = [], saved = [], errors = [], events = []
  const deploymentAt = '2026-10-02T02:15:00.000Z'
  const rentalItems = ['parent', 'child'].map(id => ({
    id, serializedEquipmentId: id, productId: 'p1', deployedDate: '2026-09-30',
    productName: id === 'parent' ? 'SCBA 5 min Pack' : 'SCBA Regulator', rate: 25,
    deployInspection: { inspectedAt: '2026-10-02T03:00:00Z', coveredBy: id === 'child' ? 'parent' : undefined },
  }))
  const exported = {}
  runInNewContext(compiled, {
    exports: exported, Date, Error, isNaN,
    searchParams: { get: () => null },
    selectedStartJobRentalId: 'r1', deploymentAt, offlineId: 'visit', user: { id: 'tech' }, lineItems: [],
    queueRentalEventTicket: async data => events.push(data),
    // Simulate the selected wall clock in Central time across UTC midnight.
    isoToLocalInput: () => '2026-10-01T21:15', todayKey: () => '2026-10-02',
    setSaving: () => {}, setError: value => { if (value) errors.push(value) },
    deployExtras: [], deployShortRows: [], deployComposition: null,
    rentalBillingRateType: 'daily', customer: { id: 'c1' },
    rentalItems, rentalLines: helperExports.rentalDeploymentLines(rentalItems),
    db: {
      transaction: async (...args) => args.at(-1)(),
      rentalAgreements: { get: async () => ({ id: 'r1', companyId: 'c1' }), put: async () => {} },
      rentalAgreementItems: { put: async data => saved.push(data) },
      equipment: { update: async () => {} },
      mutationQueue: { add: async data => mutations.push(data) },
    },
    clearDraft: async () => {}, navigate: () => {},
  })
  await exported.submitRentalAgreement()
  assert.deepEqual(errors, [])
  assert.equal(saved.length, 2)
  assert.equal(events[0].serviceDate, '2026-10-01')
  assert.equal(events[0].description, 'Equipment deployment\nSCBA 5 min Pack: parent')
  assert.equal(saved.find(item => item.id === 'child').rate, 0)
  assert.equal(saved.find(item => item.id === 'parent').rate, 25)
  for (const item of saved) {
    assert.equal(item.deployedDate, '2026-10-01')
    assert.equal(item.deployInspection.deployedAt, deploymentAt)
    assert.equal(item.deployInspection.inspectedAt, '2026-10-02T03:00:00Z')
  }
  const queued = mutations.filter(m => m.table === 'rentalAgreementItems')
  assert.equal(queued.length, 2)
  assert.equal(queued.find(item => item.entityId === 'child').payload.rate, 0)
  assert.equal(queued.find(item => item.entityId === 'child').payload.deployInspection.coveredBy, 'parent')
  for (const item of queued) {
    assert.equal(item.payload.deployedDate, '2026-10-01')
    assert.equal(item.payload.deployInspection.deployedAt, deploymentAt)
  }
})

test('manual deployment saves Serial, Type, and Test date without touching inventory', async () => {
  const mutations = [], rentals = [], events = [], errors = []
  const item = { id: 'typed-gear', manualEntry: true, serialNumber: 'ABC-123', productName: 'Trailer', testDate: '10/01/2026' }
  const exported = {}
  runInNewContext(compiled, {
    exports: exported, Date, Error, isNaN,
    searchParams: { get: () => 'assigned-ticket' },
    selectedStartJobRentalId: 'r1', deploymentAt: '2026-10-08T14:00:00Z', offlineId: 'assigned-ticket', user: { id: 'tech' }, lineItems: [],
    queueRentalEventTicket: async data => events.push(data),
    isoToLocalInput: () => '2026-10-08T09:00', todayKey: () => '2026-10-08',
    setSaving() {}, setError: value => { if (value) errors.push(value) },
    deployExtras: [], deployShortRows: [], deployComposition: null,
    rentalBillingRateType: 'daily', customer: { id: 'c1' }, rentalItems: [item], rentalLines: [item],
    db: {
      transaction: async (...args) => args.at(-1)(),
      rentalAgreements: { get: async () => ({ id: 'r1', companyId: 'c1' }), put: async data => rentals.push(data) },
      rentalAgreementItems: { put: async () => assert.fail('Manual equipment must not create inventory rental items') },
      equipment: { update: async () => assert.fail('Manual equipment must not modify inventory') },
      mutationQueue: { add: async data => mutations.push(data) },
    },
    clearDraft: async () => {}, navigate() {},
  })
  await exported.submitRentalAgreement()
  assert.deepEqual(errors, [])
  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].payload.manualEquipment[0].serial, 'ABC-123')
  assert.equal(rentals[0].composition.manualEquipment[0].testDate, '10/01/2026')
  assert.equal(events[0].assignedTicketId, 'assigned-ticket')
  assert.match(events[0].description, /Trailer: ABC-123 \(Test date: 10\/01\/2026\)/)
})
