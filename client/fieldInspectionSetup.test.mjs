import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('TicketWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let setup, advance
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect') {
    const callback = node.arguments[0]
    if (callback?.getText(ast).includes("workType !== 'field_inspection'") && callback.getText(ast).includes('setDivision')) setup = callback
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'canAdvance') advance = node
  ts.forEachChild(node, visit)
}
visit(ast)
const transpile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function setupInspection(workType = 'field_inspection') {
  const context = {
    workType, division: 'D3', serviceType: '', dispatchMode: false, requiresSiteSignEvidence: false, siteSignGeotagged: false, linkedRentalId: '',
    setDivision(value) { context.division = value },
    setServiceType(value) { context.serviceType = value },
    setShopSites() {}, cacheActiveSites() {},
    api: { get: async () => ({ data: [] }) },
    currentStepId: 'who_where', customer: { id: 'synthetic' }, location: { pad: { id: 'synthetic-pad' }, wells: [] },
  }
  runInNewContext(transpile(`const run = ${setup.getText(ast)}; run()`), context)
  return { context, canAdvance: runInNewContext(transpile(`${advance.getText(ast)}; canAdvance`), context) }
}

test('D6 Equipment Inspection tile seeds its fixed service and allows a complete customer/site step', () => {
  const { context, canAdvance } = setupInspection()
  assert.equal(context.division, 'D6')
  assert.equal(context.serviceType, 'inspection')
  assert.equal(canAdvance(), true)
  context.customer = null
  assert.equal(canAdvance(), false)
  context.customer = { id: 'synthetic' }
  context.location.pad = null
  assert.equal(canAdvance(), false)
})

test('the fixed field-inspection setup does not change another service workflow', () => {
  const { context } = setupInspection('field_service')
  assert.equal(context.division, 'D3')
  assert.equal(context.serviceType, '')
})

test('missing GPS blocks the customer/site step before submission, while dispatch hands the capture to the tech', () => {
  const { context, canAdvance } = setupInspection()
  context.requiresSiteSignEvidence = true
  assert.equal(canAdvance(), false)
  context.siteSignGeotagged = true
  assert.equal(canAdvance(), true)
  context.siteSignGeotagged = false; context.dispatchMode = true
  assert.equal(canAdvance(), true)
})
test('a linked walk-in daily requires its customer and rental but no invented site', () => {
  const { context, canAdvance } = setupInspection('field_service')
  Object.assign(context, { serviceType: 'on_site_services', onSiteSubtype: 'manned_trailer', division: 'D4', linkedRentalId: 'walk-in' })
  context.location.pad = null
  assert.equal(canAdvance(), true)
  context.linkedRentalId = ''
  assert.equal(canAdvance(), false)
})
