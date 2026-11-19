import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('TicketWizard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(predicate) {
  let found
  function visit(node) { if (predicate(node)) found = node; ts.forEachChild(node, visit) }
  visit(ast)
  assert.ok(found, 'expected integration exists')
  return found.getText(ast)
}
function evaluate(code, context) {
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
}
const refresh = find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'refreshSignins')
const student = id => ({ id, employeeName: `SYNTHETIC ${id}`, employerCompanyId: 'synthetic-customer', courseName: 'H2S CLEAR', passed: true })
function setup(records, originals, server) {
  const state = { records, originals: new Set(originals), error: '' }
  const context = { editTicketId: 'synthetic-class', signinRefreshing: false,
    trainingRosterRecords: records, originalTrainingRosterIds: state.originals,
    trainingCourseName: 'H2S CLEAR', trainingCourseOther: '',
    api: { get: async () => ({ trainingRosterRecords: server }) },
    setSigninRefreshing: () => {}, setSigninError: value => { state.error = value }, setSigninNewCount: () => {},
    setTrainingRosterRecords: value => { state.records = typeof value === 'function' ? value(state.records) : value },
    setOriginalTrainingRosterIds: value => { state.originals = typeof value === 'function' ? value(state.originals) : value },
  }
  return { state, refresh: evaluate(`${refresh}; refreshSignins`, context) }
}
test('opening a cached training ticket automatically loads its registered students', () => {
  const effect = find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect'
    && n.arguments[0]?.getText(ast).includes('refreshSignins()'))
  let calls = 0
  for (const [isEditMode, editDataLoaded, workType, expected] of [
    [true, false, 'training', 0], [true, true, 'training', 1], [false, true, 'training', 1], [true, true, 'field_service', 1],
  ]) {
    evaluate(effect, { isEditMode, editDataLoaded, workType, refreshSignins: () => { calls++ }, useEffect: callback => callback() })
    assert.equal(calls, expected)
  }
})
test('legacy training tickets and drafts recover their missing D1 division without overriding an explicit class', () => {
  const effect = find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect'
    && n.arguments[0]?.getText(ast).includes('setDivision(WORK_TYPE_QB_DIVISION.training)'))
  for (const [workType, division, expected] of [['training', null, 'D1'], ['training', 'D3', 'D3'], ['field_service', null, null]]) {
    let actual = division
    evaluate(effect, { workType, division, WORK_TYPE_QB_DIVISION: { training: 'D1' }, setDivision: value => { actual = value }, useEffect: callback => callback() })
    assert.equal(actual, expected)
  }
})
test('refresh loads preregistration and QR rows while keeping local edits and intentional removals', async () => {
  const edited = { ...student('existing'), passed: false, notes: 'trainer correction' }
  const { state, refresh } = setup([edited, student('local-new')], ['existing', 'removed'],
    [student('existing'), student('removed'), student('new-qr')])
  await refresh()
  assert.deepEqual(Array.from(state.records, row => row.id), ['existing', 'local-new', 'new-qr'])
  assert.equal(state.records[0].passed, false)
  assert.ok(state.originals.has('new-qr'), 'saving the imported QR row must update it, not create it again')
  assert.ok(state.originals.has('removed'), 'the removal must survive until the edit diff deletes it')
})
test('a restored draft containing server students recovers their original identities', async () => {
  const { state, refresh } = setup([student('existing')], [], [student('existing')])
  await refresh()
  assert.equal(state.records.length, 1)
  assert.ok(state.originals.has('existing'), 'an already-present draft student is still an existing server record')
})
test('draft snapshots preserve the roster baseline so removed rows stay removed after reload', () => {
  const property = find(n => ts.isPropertyAssignment(n) && n.name.getText(ast) === 'originalTrainingRosterIds'
    && n.initializer.getText(ast) === '[...originalTrainingRosterIds]')
  const ids = evaluate(`({ ${property} }).originalTrainingRosterIds`, { originalTrainingRosterIds: new Set(['existing', 'removed']) })
  assert.deepEqual(Array.from(ids), ['existing', 'removed'])
  const restore = find(n => ts.isIfStatement(n) && n.expression.getText(ast) === 'd.originalTrainingRosterIds')
  let restored
  evaluate(restore, { d: { originalTrainingRosterIds: ids }, setOriginalTrainingRosterIds: value => { restored = value } })
  assert.ok(restored.has('removed'))
  const savedBaseline = find(n => ts.isPropertyAssignment(n) && n.name.getText(ast) === 'originalTrainingRosterIds'
    && n.initializer.getText(ast).includes('trainingRosterRecords.map'))
  const savedIds = evaluate(`({ ${savedBaseline} }).originalTrainingRosterIds`, { trainingRosterRecords: [student('existing')] })
  assert.deepEqual(Array.from(savedIds), ['existing'], 'after save, the next editor must not delete the removed row again')
})
test('resuming an editor draft retains the current ticket status when saving changes', async () => {
  const effect = find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect'
    && n.arguments[0]?.getText(ast).includes('loadExistingTicket(editTicketId!)'))
  let status = 'draft', loaded = false
  const pending = []
  evaluate(effect, { isEditMode: true, isLoaded: true, editDataLoaded: false, editTicketId: 'synthetic',
    draft: { wizardData: { workType: 'training' } },
    restoreEditStatus: id => { assert.equal(id, 'synthetic'); pending.push(Promise.resolve().then(() => { status = 'in_progress'; loaded = true })) },
    setEditDataLoaded: value => { loaded = value }, loadExistingTicket: () => assert.fail('must preserve unsaved form'),
    useEffect: callback => callback(),
  })
  await Promise.all(pending)
  assert.equal(status, 'in_progress')
  assert.equal(loaded, true)
})
test('draft status hydration respects pending offline transitions and falls back to cached status', async () => {
  const fn = find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'restoreEditStatus')
  for (const [cached, server, expected, calls] of [
    [{ status: 'in_progress', _offlineStatus: 'pending' }, { status: 'draft' }, 'in_progress', 0],
    [{ status: 'draft' }, { status: 'in_progress' }, 'in_progress', 1],
    [{ status: 'in_progress' }, null, 'in_progress', 1],
  ]) {
    let status, fetched = 0, ready = false
    await evaluate(`${fn}; restoreEditStatus('synthetic')`, {
      db: { tickets: { get: async () => cached } }, api: { get: async () => { fetched++; if (!server) throw Error('offline'); return server } },
      setOriginalStatus: value => { status = value }, setEditDataLoaded: value => { ready = value }, setError: message => assert.fail(message),
    })
    assert.equal(status, expected)
    assert.equal(fetched, calls)
    assert.equal(ready, true)
  }
})
test('trainer closeout records the class date, including correction of old QR arrival dates', () => {
  const payload = find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'trainingPayload')
  const mapped = evaluate(`const ${payload}; trainingPayload(rec)`, {
    editTicketId: 'synthetic', serviceDate: '2026-09-24', now: '2026-09-25T22:00:00Z',
    rec: { ...student('qr'), trainedAt: '2026-09-25T08:00:00Z' },
  })
  assert.equal(mapped.trainedAt.slice(0, 10), '2026-09-24')
})
test('training retains its selected venue instead of the booking customer breadcrumb', () => {
  const fn = find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'locationBreadcrumb')
  for (const [trainingIsOnSite, trainingLocationText, expected] of [
    [false, 'Basin Safety Training Center', 'Basin Safety Training Center'],
    [true, 'SYNTHETIC REMOTE SITE', 'SYNTHETIC REMOTE SITE'],
    [false, '', 'In-House (Basin Safety)'],
  ]) {
    assert.equal(evaluate(`${fn}; locationBreadcrumb()`, { workType: 'training', trainingIsOnSite, trainingLocationText,
      customer: { name: 'SYNTHETIC BOOKING CUSTOMER' }, location: {}, wellsDisplayLabel: () => '',
    }), expected)
  }
})
test('edited completion requires site times but saving unfinished work remains possible', async () => {
  const fn = find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleSaveEdit')
  for (const [targetStatus, arrivedAt, departedAt, blocked] of [
    ['supervisor_review', null, null, true], ['supervisor_review', 'start', null, true],
    [undefined, null, null, false], ['supervisor_review', 'start', 'end', false],
  ]) {
    let error = '', reachedSave = false
    const save = evaluate(`${fn}; handleSaveEdit`, { editTicketId: 'synthetic', customer: {}, arrivedAt, departedAt, serviceType: 'training',
      requiresSiteSignEvidence: false, setError: message => { error = message },
      setSaving: () => { reachedSave = true; throw Error('save-boundary') },
    })
    try { await save(targetStatus) } catch (e) { assert.equal(e.message, 'save-boundary') }
    assert.equal(reachedSave, !blocked)
    if (blocked) assert.match(error, /Arrival and departure/)
  }
})
