import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/lib/rentalSwapBilling.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
function harness(cached, defaults = {}) {
  const exports = {}
  const requests = []
  const seedCalls = []
  runInNewContext(compiled, { exports, require(name) {
    if (name === 'uuid') return { v4: () => 'line-id' }
    if (name === './api') return { api: { get: async path => { requests.push(path); return { defaults } } } }
    if (name === './defaultLineItems') return { getDefaultLineItems: async (...args) => { seedCalls.push(args); return structuredClone(cached) } }
    if (name === './priceLevels') return { priceLine: (levels, product, listRate) => ({
      rate: levels[0]?.rate ?? listRate, listRate, priceLevelName: levels[0]?.name ?? null,
    }) }
    throw new Error(`Unexpected import ${name}`)
  } })
  return { load: exports.loadSwapBillingLines, requests, seedCalls }
}

test('Swap seeds the standard D4 labor and mileage lines once without requiring a reason', async () => {
  const h = harness([{ lineType: 'labor', rate: 85 }, { lineType: 'travel', rate: 3 }])
  const levels = [{ name: 'Customer pricing', rate: 75 }]
  const lines = await h.load(levels)
  assert.deepEqual(h.seedCalls, [['general', 4, levels]])
  assert.deepEqual(Array.from(lines, line => line.lineType), ['labor', 'travel'])
  assert.equal(lines[0].notes, 'Equipment swap')
  assert.equal(h.requests.length, 0)
})

test('Swap fills only missing cached defaults from D4 catalog with customer pricing', async () => {
  const h = harness([{ lineType: 'labor', rate: 85 }], {
    travel: { id: 'mileage', partNumber: '0400001', name: 'D4 Mileage', defaultSellPrice: 3, unitOfMeasure: 'MI' },
  })
  const lines = await h.load([{ name: 'Customer pricing', rate: 2 }])
  assert.deepEqual(h.requests, ['/products/defaults?division=4'])
  assert.equal(lines.length, 2)
  assert.equal(lines[1].partNumber, '0400001')
  assert.equal(lines[1].rate, 2)
  assert.equal(lines[1].total, 2)
  assert.equal(lines[1].contractRate, 2)
  assert.equal(lines[1].priceLevelName, 'Customer pricing')
})

test('uncached free defaults preserve explicit zero rates', async () => {
  const h = harness([], { labor: { id: 'labor', name: 'D4 Labor', partNumber: '0400002', defaultSellPrice: 0 } })
  const lines = await h.load([])
  assert.equal(lines[0].rate, 0)
  assert.equal(lines[0].total, 0)
})

const pageSource = readFileSync(new URL('./src/pages/RentalSwapPage.tsx', import.meta.url), 'utf8')
const pageAst = ts.createSourceFile('RentalSwapPage.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let submitNode
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submit') submitNode = node
  ts.forEachChild(node, visit)
}
visit(pageAst)
function submissionHarness(lineItems) {
  const calls = []
  const context = { swapDate: '2026-08-15', todayKey: () => '2026-10-02', submitting: { current: false }, rentalId: 'r1', billingReady: true, reason: '', lineItems,
    rental: { id: 'r1' }, user: { id: 'tech' }, items: [{ id: 'item', serial: 'OLD', type: 'Monitor', testDate: 'old date' }],
    selections: { item: { serial: 'NEW', type: 'Custom', testDate: 'see tag' } },
    requestId: { current: 'stable-request' }, error: '', saved: false,
    setSaving(value) { context.saved = value }, setError(value) { context.error = value },
    saveManualRentalVisit: async (rental, body) => { calls.push({ url: `/rentals/${rental.id}/equipment-visit`, body }); return { id: 'ticket' } },
    navigate(path) { context.destination = path },
  }
  const compiledSubmit = ts.transpileModule(`${submitNode.getText(pageAst)}; submit`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return { context, calls, submit: runInNewContext(compiledSubmit, context) }
}
test('finishing Swap submits actual time and mileage even with no reason', async () => {
  const lines = [{ lineType: 'labor', quantity: 2.5, rate: 85 }, { lineType: 'travel', quantity: 40, rate: 3 }]
  const h = submissionHarness(lines)
  await h.submit()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].url, '/rentals/r1/equipment-visit')
  assert.equal(h.calls[0].body.reason, '')
  assert.equal(h.calls[0].body.selections[0].replacement.serial, 'NEW')
  assert.equal(h.calls[0].body.selections[0].expected.serial, 'OLD')
  assert.equal(h.calls[0].body.lineItems, lines)
  assert.equal(h.calls[0].body.serviceDate, '2026-08-15')
  assert.equal(h.calls[0].body.requestId, 'stable-request')
  assert.equal(h.context.destination, '/tickets/ticket')
})
test('unpriced Swap billing lines stay editable and cannot silently become free', async () => {
  const h = submissionHarness([{ lineType: 'labor', quantity: 2.5, rate: null }])
  await h.submit()
  assert.equal(h.calls.length, 0)
  assert.match(h.context.error, /Enter a rate/)
})
