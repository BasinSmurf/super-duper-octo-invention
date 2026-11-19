import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('TicketWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let populate
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'populateFromTicket') populate = node
  ts.forEachChild(node, visit)
}
visit(ast)
const statements = [...populate.body.statements]
const end = statements.findIndex(s => s.getText(ast).startsWith('setOriginalStatus('))
const js = ts.transpileModule(`function restore(ticket) { ${statements.slice(0, end + 1).map(s => s.getText(ast)).join('\n')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

function restore(ticket) {
  const state = {}
  const context = {
    WORK_TYPES: [{ key: 'field_service' }, { key: 'd3_combined' }, { key: 'ih_testing' }],
    setWorkType: value => { state.workType = value },
    setD3CombinedServices: value => { state.services = [...value] },
    setOriginalStatus: value => { state.status = value },
    setError: value => { throw Error(value) },
  }
  runInNewContext(`${js}; restore`, context)(ticket)
  return state
}

test('reviewer-reopened combined visits restore all service editors without a draft snapshot', () => {
  const actual = restore({ ticketType: 'field_service', serviceSubtype: 'general', status: 'in_progress',
    customData: { isCombinedVisit: true, d3CombinedServices: ['air', 'ih', 'gas'] } })
  assert.equal(actual.workType, 'd3_combined')
  assert.deepEqual(actual.services, ['air', 'ih', 'gas'])
})

test('each combined service combination restores independently of the general subtype', () => {
  for (const services of [['air', 'gas'], ['air', 'ih'], ['ih', 'gas'], ['gas']]) {
    const actual = restore({ ticketType: 'field_service', serviceSubtype: 'general', customData: { d3CombinedServices: services } })
    assert.equal(actual.workType, 'd3_combined')
    assert.deepEqual(actual.services, services)
  }
})

test('standalone field and IH tickets keep their existing editors', () => {
  assert.equal(restore({ ticketType: 'field_service', serviceSubtype: 'general' }).workType, 'field_service')
  assert.equal(restore({ ticketType: 'inspection', serviceSubtype: 'ih_h2s' }).workType, 'ih_testing')
})
