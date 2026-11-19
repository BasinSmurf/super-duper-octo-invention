import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/lib/syncEngine.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('syncEngine.ts', source, ts.ScriptTarget.Latest, true)
const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'repairStaleProductReferences')
const js = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

async function recover({ partNumber = '406', cachedPart = '406', products = [{ id: 'current', partNumber: '406' }], error = 'AppError Invalid productId', table = 'ticketLineItems', action = 'create' } = {}) {
  const row = { queueId: 36, table, action, entityId: 'line', status: 'error', retryCount: 5,
    errorMessage: error, payload: { productId: 'old', ...(partNumber ? { partNumber } : {}), quantity: 2, rate: 85, total: 170 } }
  let localUpdate, requests = 0
  const db = {
    mutationQueue: { filter: fn => ({ toArray: async () => [row].filter(fn) }), update: async (id, changes) => Object.assign(row, changes) },
    products: { get: async () => cachedPart ? { partNumber: cachedPart } : undefined },
    ticketLineItems: { update: async (id, changes) => { localUpdate = changes } },
    transaction: async (mode, tables, fn) => fn(),
  }
  const api = { get: async url => { requests++; assert.equal(url, '/sync/pull?tables=products'); return { tables: { products: { data: products } } } } }
  await runInNewContext(`${js}; repairStaleProductReferences()`, { db, api })
  return { row, localUpdate, requests }
}

test('repairs an exhausted create by exact part number and preserves the quote', async () => {
  const { row, localUpdate } = await recover()
  assert.equal(row.status, 'pending')
  assert.equal(row.retryCount, 0)
  assert.equal(row.errorMessage, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(row.payload)), { productId: 'current', partNumber: '406', quantity: 2, rate: 85, total: 170 })
  assert.equal(localUpdate.productId, 'current')
})
test('can recover a legacy payload using its cached catalog identity', async () => {
  assert.equal((await recover({ partNumber: null })).row.payload.productId, 'current')
})
test('does not guess when the part is missing, conflicting, or unmatched', async () => {
  for (const options of [{ products: [] }, { cachedPart: 'other' }, { partNumber: null, cachedPart: null }, { products: [{ id: 'old', partNumber: '406' }] }]) {
    const { row, localUpdate } = await recover(options)
    assert.equal(row.status, 'error')
    assert.equal(row.retryCount, 5)
    assert.equal(localUpdate, undefined)
  }
})
test('does not recover deletes, other tables, or unrelated failures', async () => {
  for (const options of [{ action: 'delete' }, { table: 'rentalAgreementItems' }, { error: 'Ticket is locked by billing' }]) {
    const { requests, row } = await recover(options)
    assert.equal(requests, 0)
    assert.equal(row.retryCount, 5)
  }
})
