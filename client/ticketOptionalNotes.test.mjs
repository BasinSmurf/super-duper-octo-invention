import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('TicketWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declarations = new Map()
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node)
  ts.forEachChild(node, visit)
}
visit(ast)
function load(name, context) {
  const exports = {}
  const compiled = ts.transpileModule('export ' + declarations.get(name).getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(compiled, { exports, ...context })
  return exports[name]
}

test('empty labor notes do not block editing, while service requirements still apply', () => {
  const context = { lineItems: [{ partNumber: '406', notes: '' }], serviceLineItemsBlocker: () => null }
  assert.equal(load('lineItemsBlocker', context)(), null)
  context.serviceLineItemsBlocker = () => 'Finish the inspection.'
  assert.equal(load('lineItemsBlocker', context)(), 'Finish the inspection.')
})

test('repeat edits can revise and clear labor notes in both local storage and sync', async () => {
  const saved = new Map([['labor', { notes: 'Original notes' }]])
  const server = new Map([['labor', { notes: 'Original notes' }]])
  const mutations = [], errors = []
  const line = { id: 'labor', partNumber: '406', lineType: 'labor', description: 'Labor', quantity: 1, rate: 50 }
  const context = {
    editTicketId: 'ticket', customer: { id: 'customer' }, originalStatus: 'supervisor_review',
    requiresSiteSignEvidence: false, siteSignPhotos: [], siteSignGeotagged: false,
    setSaving() {}, setError(value) { if (value) errors.push(value) },
    buildTicketPayload: () => ({ workDescription: null }), locationBreadcrumb: () => 'Site',
    signature: '', workType: 'field_service', serviceType: 'other',
    lineItems: [line], originalLineItemIds: new Set(['labor']),
    d3HasAir: false, d3HasGas: false, d3HasIh: false, photos: [],
    priceLevelCustomData: () => null, clearDraft: async () => {}, navigate() {},
    db: {
      tickets: { update: async () => {} },
      ticketLineItems: { update: async (id, data) => saved.set(id, { ...saved.get(id), ...data }) },
      mutationQueue: {
        where: () => ({ equals: () => ({ toArray: async () => [] }) }),
        add: async data => mutations.push(data),
      },
    },
  }
  for (const notes of ['Revised notes', '', 'New notes', '']) {
    line.notes = notes
    mutations.length = 0
    await load('handleSaveEdit', context)()
    assert.deepEqual(errors, [])
    const mutation = mutations.find(m => m.table === 'ticketLineItems')
    const payload = JSON.parse(JSON.stringify(mutation.payload))
    server.set('labor', { ...server.get('labor'), ...payload })
    assert.equal(saved.get('labor').notes, notes || null)
    assert.equal(server.get('labor').notes, notes || null)
  }
})
