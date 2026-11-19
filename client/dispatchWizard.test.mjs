import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const exports = {}
runInNewContext(ts.transpileModule(readFileSync(new URL('./src/lib/dispatchWizard.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports })
for (const [name, steps, expected] of [
  ['field', ['who_where', 'line_items', 'wrap_up'], 2],
  ['combined', ['d3_services', 'who_where', 'line_items', 'wrap_up'], 3],
  ['IH', ['ih_setup', 'ih_records', 'ih_line_items', 'ih_wrap_up'], 2],
  ['occupational health', ['ft_setup', 'ft_records', 'ft_line_items', 'ft_wrap_up'], 2],
  ['training', ['tr_setup', 'tr_roster', 'tr_line_items', 'tr_wrap_up'], 2],
  ['air fill', ['af_customer', 'af_confirm', 'af_line_items', 'af_wrap_up'], 2],
]) test(`dispatch ${name} ends before field data`, () => {
  const prepared = Array.from(exports.dispatchWizardSteps(steps))
  assert.deepEqual(prepared, [...steps.slice(0, expected - 1), 'dispatch_review'])
})
test('a dispatched ticket opens on the first screen until the tech has saved it', () => {
  // Stored step is ignored: tickets dispatched before this rule stored a later one.
  assert.equal(exports.wizardResumeStep({ dispatchPrepared: true, wizardDraft: { step: 2 } }), 1)
  assert.equal(exports.wizardResumeStep({ dispatchPrepared: true, wizardDraft: { step: 3, techSaved: true } }), 3)
  assert.equal(exports.wizardResumeStep({ wizardDraft: { step: 4 } }), 4, 'ordinary saved drafts resume where they were')
  assert.equal(exports.wizardResumeStep({ wizardDraft: {} }), 1)
  assert.equal(exports.wizardResumeStep(null), 1)
})
const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('Wizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let node
function find(n) { if (ts.isFunctionDeclaration(n) && n.name?.text === 'handleDispatchCallout') node = n; ts.forEachChild(n, find) }
find(ast)
test('dispatch submits assignment, work setup, prefilled charges and one editable callout fee', async () => {
  const posts = []
  const lines = [{ id: 'labor', lineType: 'labor', quantity: 2, rate: 90 }]
  const context = { dispatchSubmitting: { current: false }, customer: { id: 'customer' }, dispatchTechId: 'tech', canAdvance: () => true,
    setSaving() {}, setError() {}, WORK_TYPES: [{ key: 'field_service', steps: ['who_where', 'line_items', 'wrap_up'] }], workType: 'field_service',
    buildTicketPayload: () => ({ companyId: 'customer', serviceSubtype: 'general', linkedRentalAgreementId: 'ra', customData: { isCallOut: true } }),
    lineItems: lines, dispatchFeeLineId: 'fee', dispatchCalloutFee: '175', isCallOut: true, dispatchNotificationDivision: '', division: 'D3',
    getWizardData: () => ({ workType: 'field_service', serviceType: 'general' }), offlineId: 'request',
    api: { post: async (...args) => posts.push(args) }, clearDraft: async () => {}, navigate: value => { context.destination = value },
  }
  const fn = runInNewContext(ts.transpileModule(`${node.getText(ast)}; handleDispatchCallout`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  await fn()
  const body = posts[0][1]
  assert.equal(body.ticket.assignedTechId, 'tech')
  assert.equal(body.ticket.linkedRentalAgreementId, 'ra')
  assert.equal(body.ticket.customData.dispatchNotificationDivision, 'D3')
  assert.equal(body.ticket.customData.wizardDraft.step, 1)
  assert.equal(body.lineItems.length, 2)
  assert.equal(body.lineItems[1].partNumber, '148')
  assert.equal(body.lineItems[1].rate, 175)
  assert.equal(body.ticket.customData.wizardDraft.data.lineItems, body.lineItems)
  assert.equal(context.destination, '/dispatch')
  context.lineItems = body.lineItems
  context.dispatchNotificationDivision = 'D4'
  await fn()
  assert.equal(posts[1][1].ticket.customData.dispatchNotificationDivision, 'D4')
  assert.equal(posts[1][1].lineItems.length, 2, 'no duplicate fee if already prefilled')
})
