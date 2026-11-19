import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function findNode(file, match) {
  const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let result
  function walk(node) { if (match(node, ast)) result = node; ts.forEachChild(node, walk) }
  walk(ast)
  assert.ok(result)
  return result.getText(ast)
}
const fn = name => node => ts.isFunctionDeclaration(node) && node.name?.text === name
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

test('new rental allows blank dispatch fields and unavailable optional choices', () => {
  const declaration = name => findNode('./src/components/DispatchRentalDialog.tsx', node => ts.isVariableDeclaration(node) && node.name.getText() === name)
  const context = {
    pickupType: 'dispatch', baseValid: true, siteContactValid: true, walkInValid: false,
    compositionPriced: true, customerCreditHold: false, assignedTechId: '', ringCentralChannel: '',
    optionsError: 'Could not load dispatch users and channels.',
  }
  const valid = () => runInNewContext(compile(`const ${declaration('canSubmit')}; canSubmit`), { ...context })
  assert.equal(valid(), true)
  context.siteContactValid = false
  assert.equal(valid(), false)
  context.siteContactValid = true
  context.customerCreditHold = true
  assert.equal(valid(), false)

  const payload = runInNewContext(compile(`const ${declaration('payload')}; JSON.parse(JSON.stringify(payload))`), {
    pickupType: 'dispatch', commonPayload: {}, assignedTechId: '', ringCentralChannel: '',
    location: { wells: [] }, effectiveSiteName: '', effectiveSitePhone: '', effectiveSiteEmail: '', seededPics: undefined,
  })
  assert.equal(Object.hasOwn(payload, 'assignedTechId'), false)
  assert.equal(Object.hasOwn(payload, 'ringCentralChannel'), false)
})

