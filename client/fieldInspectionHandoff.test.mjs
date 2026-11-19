import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('TicketWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function initializer(name, context) {
  let found
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(found, name)
  return runInNewContext(ts.transpileModule(`const result = ${found.getText(ast)}; result`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { ...context })
}
const failed = { id: 'inspection-failed', serialNumber: 'SYN-FEX', category: 'fire_extinguisher', outcome: 'fail',
  data: { brand: 'SYNTHETIC', size: '5#', type: 'ABC', checkpoints: { shell: { value: 'fail' } } },
  notes: 'Hose damaged and gauge below green', partsReplaced: 'Synthetic seal', serviceActions: ['visual_only'],
  inspectedAt: '2026-09-25T21:00:00Z', customerApprovedName: 'Synthetic customer' }
function context() {
  return { failRecords: [failed], now: '2026-09-25T22:00:00Z',
    INSP_TO_SHOP_CATEGORY: { fire_extinguisher: 'fire_extinguisher', gas_detection: 'gas_monitor' },
    ticketId: 'source-ticket', woId: 'synthetic-wo', customer: { id: 'synthetic-company' },
    user: { id: 'synthetic-tech' }, techName: 'Synthetic Tech',
    getActiveSiteId: () => 'dickinson', location: { pad: { id: 'synthetic-pad' } }, returnShopShortCode: 'WIL',
    poNumber: 'legacy-po', billingRefs: [{ type: 'po', value: 'SYN-PO' }, { type: 'afe', value: 'SYN-AFE' }],
  }
}
test('failed field handoff preserves the reported fault and original inspection context', () => {
  const c = context()
  const [item] = initializer('woItems', c)
  assert.ok(item.reportedIssue.includes(failed.notes))
  assert.equal(item.customData.fieldInspection.brand, 'SYNTHETIC')
  assert.equal(item.customData.fieldInspectionRecord.id, failed.id)
  assert.equal(item.customData.fieldInspectionRecord.notes, failed.notes)
  assert.equal(item.customData.fieldInspectionRecord.partsReplaced, failed.partsReplaced)
  assert.equal(item.customData.fieldInspectionRecord.inspectedAt, failed.inspectedAt)
  assert.equal(item.customData.fieldInspectionRecord.sourceTicketOfflineId, c.ticketId)
})
test('spawned shop order carries the source PO and AFE with the destination', () => {
  const c = context()
  c.woItems = initializer('woItems', c)
  const payload = initializer('woPayload', c)
  assert.equal(payload.poNumber, 'SYN-PO')
  assert.equal(payload.afeNumber, 'SYN-AFE')
  assert.equal(payload.transitToShortCode, 'WIL')
  assert.equal(payload.sourceLocationId, 'synthetic-pad')
  c.billingRefs = []
  assert.equal(initializer('woPayload', c).poNumber, 'legacy-po')
})
