import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { v5 as uuidv5 } from 'uuid'
const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('TicketWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(predicate) { let result; function visit(n) { if (predicate(n)) result = n; ts.forEachChild(n, visit) } visit(ast); return result }
function evaluate(text, context) { return runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context) }
function load(name, context) {
  const fn = find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
  assert.ok(fn, `${name} exists`)
  return evaluate(`${fn.getText(ast)}; ${name}`, context)
}
test('Save & Complete finalizes field inspections; Save Changes leaves the draft unfinalized', async () => {
  const fn = find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleSaveEdit')
  let branch
  function visit(n) { if (ts.isIfStatement(n) && n.thenStatement.getText(ast).includes('await saveFieldInspectionSubmission(editTicketId, now)')) branch = n; ts.forEachChild(n, visit) }
  visit(fn)
  assert.ok(branch, 'edit completion must persist field results and failed-unit shop handoffs')
  for (const [serviceType, status, expected] of [['inspection','supervisor_review',1], ['inspection','draft',0], ['general','supervisor_review',0]]) {
    const calls = []
    await evaluate(`(async () => { ${branch.getText(ast)} })()`, { serviceType, status, editTicketId: 'ticket', now: 'now', saveFieldInspectionSubmission: async (...args) => calls.push(args) })
    assert.equal(calls.length, expected)
  }
})

function setup(submitted = []) {
  const queues = [], inspections = [], orders = []
  const records = [
    { id:'12121212-1212-4121-8121-121212121212', serialNumber:'SYN-PASS', category:'fire_extinguisher', outcome:'pass', data:{}, serviceActions:['visual_only'] },
    { id:'34343434-3434-4343-8343-343434343434', serialNumber:'SYN-FAIL', category:'gas_detection', outcome:'requires_parts', data:{make:'SYN'}, serviceActions:['bump_test'], notes:'Sensor dead' },
  ]
  const context = { inspectionRecords: records, fieldInspectionSubmittedIds: new Set(submitted), serviceType:'inspection', uuidv5,
    INSP_TO_SHOP_CATEGORY:{gas_detection:'gas_monitor'}, user:{id:'synthetic-tech',name:'Synthetic Tech'},
    customer:{id:'synthetic-company',name:'Synthetic Customer'}, billingRefs:[],poNumber:'SYN-PO',
    location:{pad:{id:'synthetic-pad'}},getActiveSiteId:()=> 'site', returnShopShortCode:'DIC',
    db:{equipmentInspections:{put:async r=>inspections.push(r)},shopWorkOrders:{put:async r=>orders.push(r)},mutationQueue:{add:async q=>queues.push(q)}},
  }
  return { context, queues, inspections, orders, records }
}
test('draft completion keeps passing records and failed shop handoff distinct, with stable retry IDs', async () => {
  const s = setup(), save = load('saveFieldInspectionSubmission', s.context)
  await save('synthetic-ticket','2026-09-25T22:00:00Z')
  assert.equal(s.inspections.length,1)
  assert.equal(s.inspections[0].serialNumber,'SYN-PASS')
  const handoff = s.queues.find(q=>q.table==='shopWorkOrders')
  assert.equal(handoff.payload.items.length,1)
  assert.equal(handoff.payload.items[0].serialNumber,'SYN-FAIL')
  assert.ok(handoff.payload.items[0].reportedIssue.includes('Sensor dead'))
  await save('remapped-server-ticket','2026-09-25T22:01:00Z')
  assert.equal(s.queues.filter(q=>q.table==='shopWorkOrders')[1].entityId,handoff.entityId)
})
test('reviewer corrections do not recreate already-submitted equipment or shop work', async () => {
  const s = setup(['12121212-1212-4121-8121-121212121212','34343434-3434-4343-8343-343434343434'])
  await load('saveFieldInspectionSubmission',s.context)('ticket','now')
  assert.equal(s.queues.length,0)
  s.context.inspectionRecords.push({...s.records[1],id:'56565656-5656-4565-8565-565656565656',serialNumber:'SYN-ADDED'})
  await load('saveFieldInspectionSubmission',s.context)('ticket','now')
  assert.equal(s.queues.length,1)
  assert.equal(s.queues[0].payload.items.length,1)
  assert.equal(s.queues[0].payload.items[0].serialNumber,'SYN-ADDED')
})

test('finalized snapshots preserve inspection context and submitted identities across reloads', () => {
  const s = setup([ '12121212-1212-4121-8121-121212121212' ])
  const snapshot = load('fieldInspectionSnapshot', s.context)
  assert.equal(snapshot(false).submittedIds.length,1,'draft save must not mark new units submitted')
  const completed = snapshot(true)
  assert.equal(completed.submittedIds.length,2)
  assert.equal(completed.records[1].notes,'Sensor dead')
  assert.equal(completed.returnShopShortCode,'DIC')
  const createPayload = find(n => ts.isObjectLiteralExpression(n) && n.properties.some(p => ts.isSpreadAssignment(p) && p.expression.getText(ast) === 'buildTicketPayload(true)'))
  assert.ok(createPayload,'direct creation must also persist finalized identities')
})
