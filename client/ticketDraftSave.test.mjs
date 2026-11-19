import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('TicketWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function loadFunction(name, context) {
  let node
  function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) node = n
    ts.forEachChild(n, visit)
  }
  visit(ast)
  assert.ok(node, `${name} exists`)
  const js = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return runInNewContext(`${js}; ${name}`, { searchParams: { get: () => null }, ...context })
}

const draftData = {
  workType: 'field_service', serviceType: 'cascade_air',
  customer: { id: 'synthetic-customer' }, location: { pad: { id: 'synthetic-pad', pendingReview: true }, wells: [] },
  lineItems: [{ id: 'line', description: 'Primary air inspection', quantity: 1, rate: 185 }],
  airSystemRecords: [{ id: 'air', workPointName: 'SYNTHETIC AIR', cylinders: [{ serialNumber: 'SYN-CYL' }] }],
  gasDetectionRecords: [{ id: 'gas', monitorSerial: 'SYN-GAS' }],
  ihTestRecords: [{ id: 'ih', testType: 'h2s', testData: { ppm: 5 } }],
  photos: [{ id: 'photo', dataUrl: 'data:image/png;base64,synthetic' }],
  siteSignPhotos: [{ id: 'sign', latitude: 47, longitude: -103 }],
  signature: 'synthetic-signature',
}

test('Save Draft retains completed work in the synced ticket after the browser draft is cleared', async () => {
  let ticket, mutation, cleared = false
  const db = {
    tickets: { async put(value) { ticket = value } },
    mutationQueue: { async add(value) { mutation = value } },
    drafts: {},
    async transaction(mode, tables, run) { await run() },
  }
  const save = loadFunction('handleSaveDraft', {
    db, offlineId: 'synthetic-ticket', step: 3, Date,
    setSaving() {}, setError(error) { if (error) throw Error(error) }, navigate() {},
    buildTicketRecord: () => ({ id: 'synthetic-ticket', status: 'draft', customData: { cascadeAirSubtype: 'inspection' } }),
    buildTicketPayload: () => ({ companyId: 'synthetic-customer', customData: { cascadeAirSubtype: 'inspection' } }),
    getWizardData: () => draftData,
    async clearDraft() { cleared = true },
  })
  await save()
  assert.equal(cleared, true)
  assert.equal(mutation.payload.status, 'draft')
  // Simulate a new browser/device with only the JSON returned by the server.
  const serverTicket = JSON.parse(JSON.stringify(mutation.payload))
  assert.deepEqual(serverTicket.customData.wizardDraft?.data, draftData)
  assert.equal(serverTicket.customData.wizardDraft.step, 3)
  assert.deepEqual(JSON.parse(JSON.stringify(ticket.customData)), serverTicket.customData)
})

test('restoring synced work retains current location approval and students added through QR', () => {
  const state = {
    Customer: { id: 'synthetic-customer', name: 'Current customer' },
    Location: { pad: { id: 'synthetic-pad', pendingReview: false }, wells: [] },
    ServiceDate: '2026-10-16', DispatchNotes: 'Office instructions', WorkNotes: 'Corrected work',
    TrainingRosterRecords: [{ id: 'qr-student', employeeName: 'SYNTHETIC QR STUDENT' }],
  }
  const context = {
    normalizeServiceType: value => value,
    restoreSiteTimesManual: () => ({ arrived: false, departed: false }),
  }
  for (const key of ['WorkType', 'Step', 'Customer', 'Location', 'ServiceType', 'LineItems', 'SiteTimesManual',
    'Photos', 'SiteSignPhotos', 'Signature', 'AirSystemRecords', 'GasDetectionRecords', 'IhTestRecords',
    'InspectionRecords', 'OccDailyCalFiles', 'TrainingRosterRecords', 'ServiceDate', 'DispatchNotes', 'WorkNotes']) {
    context[`set${key}`] = value => { state[key] = typeof value === 'function' ? value(state[key]) : value }
  }
  const restore = loadFunction('restoreWizardData', context)
  const saved = { ...draftData, trainingRosterRecords: [{ id: 'pre-student', employeeName: 'SYNTHETIC PREREGISTERED' }],
    inspectionRecords: [{ id: 'failed-inspection', outcome: 'fail' }],
    occDailyCalFiles: [{ id: 'cal-file', dataUrl: 'synthetic' }],
    serviceDate: '2026-10-01', dispatchNotes: 'Old instructions', workNotes: 'Old work',
  }
  restore(saved, 3, false)
  assert.equal(state.Step, 3)
  assert.equal(state.Location.pad.pendingReview, false, 'old draft must not undo admin location approval')
  assert.equal(state.Customer.name, 'Current customer')
  assert.equal(state.ServiceDate, '2026-10-16', 'saved work must not undo office date corrections')
  assert.equal(state.DispatchNotes, 'Office instructions')
  assert.equal(state.WorkNotes, 'Corrected work')
  for (const [key, value] of Object.entries({ LineItems: saved.lineItems, AirSystemRecords: saved.airSystemRecords,
    GasDetectionRecords: saved.gasDetectionRecords, IhTestRecords: saved.ihTestRecords,
    Photos: saved.photos, SiteSignPhotos: saved.siteSignPhotos, Signature: saved.signature,
    InspectionRecords: saved.inspectionRecords, OccDailyCalFiles: saved.occDailyCalFiles })) {
    assert.deepEqual(state[key], value)
  }
  assert.deepEqual(Array.from(state.TrainingRosterRecords, row => row.id), ['pre-student', 'qr-student'])
  restore(saved, 3, true)
  assert.equal(state.ServiceDate, saved.serviceDate, 'browser drafts still restore their date and notes')
  assert.equal(state.DispatchNotes, saved.dispatchNotes)
  assert.equal(state.WorkNotes, saved.workNotes)
})

test('an outbox failure keeps the browser draft available for retry', async () => {
  let cleared = false, navigated = false, error = ''
  const db = {
    tickets: { async put() {} },
    mutationQueue: { async add() { throw Error('Synthetic storage failure') } },
    drafts: {},
    async transaction(mode, tables, run) { await run() },
  }
  await loadFunction('handleSaveDraft', {
    db, offlineId: 'synthetic-ticket', step: 3, Date,
    setSaving() {}, setError(value) { error = value }, navigate() { navigated = true },
    buildTicketRecord: () => ({ id: 'synthetic-ticket', status: 'draft' }),
    buildTicketPayload: () => ({ companyId: 'synthetic-customer' }),
    getWizardData: () => draftData,
    async clearDraft() { cleared = true },
  })()
  assert.equal(cleared, false)
  assert.equal(navigated, false)
  assert.ok(error)
})

test('assigned rental deploy drafts keep their ticket identity without creating another ticket', async () => {
  let saved, destination
  const save = loadFunction('handleSaveDraft', {
    searchParams: { get: key => key === 'deployTicket' ? 'assigned-ticket' : null },
    draftId: 'deploy-assigned-ticket', step: 2,
    getWizardData: () => ({ ...draftData, workType: 'rental', selectedStartJobRentalId: 'rental' }),
    db: {
      drafts: { async put(value) { saved = value } },
      tickets: { async put() { assert.fail('Must preserve the dispatched ticket') } },
      mutationQueue: { async add() { assert.fail('Must not create a duplicate ticket') } },
    },
    navigate: value => { destination = value },
  })
  await save()
  assert.equal(saved.id, 'deploy-assigned-ticket')
  assert.equal(saved.step, 2)
  assert.equal(saved.wizardData.selectedStartJobRentalId, 'rental')
  assert.equal(destination, '/my-jobs?tab=rentals')
})
