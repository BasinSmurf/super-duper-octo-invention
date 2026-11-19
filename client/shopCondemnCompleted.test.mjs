import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/ShopOrderDetailPage.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('ShopOrderDetailPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const parts = []
function visit(node) {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tree) === 'ITEM_TRANSITIONS')) parts.push(node.getText(tree))
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'changeItemStatus') parts.push(node.getText(tree))
  ts.forEachChild(node, visit)
}
visit(tree)
const compiled = ts.transpileModule(parts.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

test('completed unit offers Condemned and saves the selected disposition', async () => {
  const item = { id: 'unit', status: 'shop_complete' }
  let items = [item], patch, cached, error
  const context = {
    id: 'wo', items, order: { id: 'wo', status: 'in_progress', completedItems: 1 },
    api: {
      patch: async (path, body) => { patch = { path, body } },
      get: async () => ({ id: 'wo', status: 'complete', completedItems: 1 }),
    },
    db: {
      shopWorkOrderItems: { update: async (id, value) => { cached = { id, ...value } } },
      shopWorkOrders: { update: async () => {} },
    },
    setItems: update => { items = update(items) }, setOrder() {}, setStatusChanging() {},
    setError: value => { error = value },
  }
  const actions = runInNewContext(`${compiled}; ({ transitions: ITEM_TRANSITIONS, changeItemStatus })`, context)
  assert.ok(actions.transitions[item.status].includes('condemned'))
  await actions.changeItemStatus(item.id, 'condemned')
  assert.equal(error, undefined)
  assert.equal(patch.path, '/shop-orders/wo/items/unit/status')
  assert.equal(patch.body.status, 'condemned')
  assert.equal(cached.status, 'condemned')
  assert.equal(items[0].status, 'condemned')
});
