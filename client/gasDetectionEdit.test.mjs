import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('TicketWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function load(name, context) {
  let found
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit) }
  visit(ast)
  assert.ok(found, `${name} exists`)
  const js = ts.transpileModule(found.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return runInNewContext(`${js}; ${name}`, context)
}
const monitor = { id: 'synthetic-monitor', monitorSerial: 'SYN-GAS', monitorMake: 'SYNTHETIC', monitorModel: 'SYN',
  subtype: 'calibration', testResult: 'pass', sensorReplaced: '', workPerformed: '', notes: 'Synthetic calibration' }
function setup(records, stored = [], original = []) {
  const queue = [], rows = new Map(stored.map(r => [r.id, r]))
  const context = { gasDetectionRecords: records, originalGasDetectionIds: new Set(original), db: {
    gasDetectionRecords: {
      where: () => ({ equals: () => ({ toArray: async () => [...rows.values()] }) }),
      put: async row => rows.set(row.id, row), delete: async id => rows.delete(id),
    },
    mutationQueue: { add: async row => { queue.push(row) } },
    transaction: async (_mode, _tables, operation) => operation(),
  } }
  return { queue, rows, context, save: load('saveGasDetectionEdits', context) }
}
test('completing a reopened draft queues the monitor with the original identity and calibration', async () => {
  const { save, queue, rows } = setup([monitor])
  await save('synthetic-ticket', '2026-09-25T20:00:00Z')
  assert.equal(queue.length, 1)
  assert.equal(queue[0].action, 'create')
  assert.equal(queue[0].entityId, monitor.id)
  assert.equal(queue[0].payload.ticketId, 'synthetic-ticket')
  assert.equal(queue[0].payload.monitorSerial, 'SYN-GAS')
  assert.equal(queue[0].payload.subtype, 'calibration')
  assert.equal(queue[0].payload.testResult, 'pass')
  assert.equal(rows.get(monitor.id)._offlineStatus, 'pending')
})
test('edits, additions and removal keep each gas monitor represented once', async () => {
  const changed = { ...monitor, notes: '', testResult: 'fail' }
  const added = { ...monitor, id: 'added', monitorSerial: 'SYN-GAS-2' }
  const { save, queue, rows } = setup([changed, added], [monitor, { ...monitor, id: 'removed' }])
  await save('synthetic-ticket', 'now')
  assert.deepEqual(queue.map(q => [q.action, q.entityId]), [['update', monitor.id], ['create', 'added'], ['delete', 'removed']])
  assert.equal(queue[0].payload.notes, null, 'clearing notes must reach the server')
  assert.equal(queue[0].payload.testResult, 'fail')
  assert.equal(rows.size, 2)
  queue.length = 0
  await save('synthetic-ticket', 'later')
  assert.equal(queue.filter(q => q.action === 'create').length, 0, 'resaving must not recreate existing identities')
})
test('API-loaded monitors restore original IDs and can be corrected without recreating them', async () => {
  let records, ids
  load('restoreGasDetectionRecords', { setGasDetectionRecords: value => { records = value }, setOriginalGasDetectionIds: value => { ids = value } })([{ ...monitor, notes: null }])
  assert.equal(records[0].notes, '')
  const { save, queue } = setup(records, [], ids)
  await save('synthetic-ticket', 'now')
  assert.equal(queue[0].action, 'update')
})
test('edit-save invokes gas persistence for standalone and combined gas work', async () => {
  // Execute the actual integration branch from handleSaveEdit, including its condition.
  let branch
  function visit(node) {
    if (ts.isIfStatement(node) && node.thenStatement.getText(ast).includes('await saveGasDetectionEdits(editTicketId, now)')) branch = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(branch, 'edit completion must invoke gas persistence')
  const js = ts.transpileModule(`async function run() { ${branch.getText(ast)} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  for (const [serviceType, d3HasGas, expected] of [['gas_detection', false, 1], ['combined', true, 1], ['general', false, 0]]) {
    let calls = 0
    await runInNewContext(`${js}; run()`, { serviceType, d3HasGas, editTicketId: 'synthetic', now: 'now', saveGasDetectionEdits: async () => { calls++ } })
    assert.equal(calls, expected)
  }
})
