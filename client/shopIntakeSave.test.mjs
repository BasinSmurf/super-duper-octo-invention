import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/ShopIntakePage.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('ShopIntakePage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let submitSource
const validationSources = []
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleSubmit') submitSource = node.getText(tree)
  if (ts.isVariableDeclaration(node) && ['hasDeferredSerials', 'validItemCount'].includes(node.name.getText(tree))) {
    validationSources.push(`const ${node.getText(tree)};`)
  }
  ts.forEachChild(node, visit)
}
visit(tree)
assert.ok(submitSource)
const compiled = ts.transpileModule([...validationSources, submitSource].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const apiExports = {}
runInNewContext(ts.transpileModule(readFileSync(new URL('./src/lib/api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: apiExports, Error })
const { ApiError } = apiExports

async function submit(outcome, offlineEnabled = true, items = [{ serialNumber: 'A', bin: '13' }, { serialNumber: 'B', bin: '13' }]) {
  const state = { orders: [], mutations: [], error: '', submitting: false, destination: null, print: null }
  const contact = { name: 'Synthetic contact', phone: '', email: '', preferred: 'phone' }
  const context = {
    Error, ApiError, Date, offlineEnabled,
    customer: { id: 'synthetic-customer', name: 'Synthetic customer' },
    items,
    isInternal: false, intakeNotes: '', poNumber: '', afeNumber: '', tier1: false,
    primaryCategory: null, priority: 'normal', dropOffContact: contact, effectivePickupContact: contact,
    getActiveSiteId: () => 'synthetic-site', buildShopItemPayload: item => item,
    uuidv4: () => 'offline-order',
    api: { post: async () => { if (outcome instanceof Error) throw outcome; return outcome } },
    db: {
      transaction: async (_mode, _tables, run) => run(),
      shopWorkOrders: { put: async row => state.orders.push(row) },
      mutationQueue: { add: async row => state.mutations.push(row) },
    },
    setSubmitting: value => { state.submitting = value },
    setSubmitError: value => { state.error = value },
    setPrintPromptWo: value => { state.print = value },
    navigate: value => { state.destination = value },
  }
  await runInNewContext(`${compiled}; handleSubmit()`, context)
  return state
}

for (const status of [400, 401, 403, 409, 500]) {
  test(`HTTP ${status} retains the form and creates no pending order`, async () => {
    const message = 'Bin 13 is picked for two units in this request — choose different bins.'
    const result = await submit(new ApiError(status, message))
    assert.equal(result.error, message)
    assert.equal(result.orders.length, 0)
    assert.equal(result.mutations.length, 0)
    assert.equal(result.destination, null)
    assert.equal(result.submitting, false)
  })
}

test('network failure still saves the order and complete payload for offline replay', async () => {
  const result = await submit(new TypeError('Failed to fetch'))
  assert.equal(result.orders.length, 1)
  assert.equal(result.mutations.length, 1)
  assert.equal(result.mutations[0].payload.items.length, 2)
  assert.equal(result.destination, '/shop/offline-order')
  assert.equal(result.error, '')
})

test('billing users retain their equipment form on network failure instead of entering an unavailable sync queue', async () => {
  const result = await submit(new TypeError('Failed to fetch'), false)
  assert.match(result.error, /Work order was not saved/)
  assert.equal(result.orders.length, 0)
  assert.equal(result.mutations.length, 0)
  assert.equal(result.destination, null)
  assert.equal(result.submitting, false)
})

test('successful online intake opens printing without queuing another order', async () => {
  const result = await submit({ id: 'saved-order' })
  assert.equal(result.print.id, 'saved-order')
  assert.equal(result.orders.length, 0)
  assert.equal(result.mutations.length, 0)
  assert.equal(result.submitting, false)
})

test('offline mass intake retains all pieces and defers their serial collection', async () => {
  const pieces = Array.from({ length: 11 }, () => ({ serialNumber: '', equipmentCategory: 'ue_cylinder', serviceType: 'ue_testing' }))
  const result = await submit(new TypeError('Failed to fetch'), true, pieces)
  assert.equal(result.orders[0].totalItems, 11)
  assert.equal(result.mutations[0].payload.massIntake, true)
  assert.equal(result.mutations[0].payload.items.length, 11)
  assert.ok(result.mutations[0].payload.items.every(piece => piece.serialNumber === ''))
})

test('count-only intake below the mass threshold cannot create or queue an order', async () => {
  const pieces = Array.from({ length: 10 }, () => ({ serialNumber: '' }))
  const result = await submit({ id: 'saved-order' }, true, pieces)
  assert.equal(result.orders.length, 0)
  assert.equal(result.mutations.length, 0)
  assert.equal(result.print, null)
})
