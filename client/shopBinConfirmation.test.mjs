import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/components/ShopUnitEntry.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('ShopUnitEntry.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const functions = []
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['confirmSharedBin', 'addItem', 'addItemsFromPaste'].includes(node.name?.text)) functions.push(node.getText(tree))
  ts.forEachChild(node, visit)
}
visit(tree)
const compiled = ts.transpileModule(functions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
function harness(overrides = {}) {
  const state = { changed: null, prompt: null }
  const context = {
    newCategory: 'personal_monitor', newSerial: 'SYNTHETIC-2', newServiceType: 'general', newIssue: '',
    newFexSize: '', newFexSizeOther: '', newBinLocation: 'Bin 13', newBinLocationOther: '',
    newMonitorBrand: '', newMonitorModel: '', newMonitorGasTypes: [],
    items: [], occupiedBins: new Map(), workOrderId: undefined, pasteText: 'SYNTHETIC-2\nSYNTHETIC-3',
    isMonitor: () => true, uuidv4: () => 'synthetic-id', setTimeout: () => {},
    setNewSerial() {}, setNewIssue() {}, setPasteText() {},
    setBinConfirmation: value => { state.prompt = value },
    onChange: value => { state.changed = value }, ...overrides,
  }
  const actions = runInNewContext(`${compiled}; ({ addItem, addItemsFromPaste })`, context)
  return { state, ...actions }
}
test('a second item waits for sharing confirmation and is added only after yes', () => {
  const h = harness({ items: [{ equipmentCategory: 'personal_monitor', binLocation: 'Bin 13' }] })
  h.addItem()
  assert.equal(h.state.changed, null)
  assert.equal(h.state.prompt.bin, 'Bin 13')
  h.state.prompt.confirm()
  assert.equal(h.state.changed.length, 2)
})
test('bulk pasted serials ask before sharing one bin', () => {
  const h = harness()
  h.addItemsFromPaste()
  assert.equal(h.state.changed, null)
  h.state.prompt.confirm()
  assert.equal(h.state.changed.length, 2)
})
test('an existing same-job bin also requires confirmation', () => {
  const h = harness({ workOrderId: 'own', occupiedBins: new Map([['Bin 13', { workOrderId: 'own' }]]) })
  h.addItem()
  assert.equal(h.state.changed, null)
  assert.ok(h.state.prompt)
})
test('separate bins save the added unit without a sharing prompt', () => {
  const h = harness({ items: [{ equipmentCategory: 'personal_monitor', binLocation: 'Bin 14' }] })
  h.addItem()
  assert.equal(h.state.prompt, null)
  assert.equal(h.state.changed.length, 2)
})
