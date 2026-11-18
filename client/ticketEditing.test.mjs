import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function loadFunction(file, name, context) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(found, name)
  const js = ts.transpileModule(found.getText(ast).replace('export ', ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText
  return runInNewContext(`${js}; ${name}`, context)
}

test('dispatch and admin can edit active tickets without opening billing-locked statuses', () => {
  const canEdit = loadFunction('./src/lib/ticketStateMachine.ts', 'canEditTicket', {})
  for (const role of ['dispatch', 'platform_admin']) {
    for (const status of ['draft', 'dispatched', 'in_progress']) {
      assert.equal(canEdit(status, role, false), true)
    }
    for (const status of ['invoiced', 'closed', 'void']) assert.equal(canEdit(status, role, false), false)
  }
  assert.equal(canEdit('in_progress', 'field_tech', false), false)
  assert.equal(canEdit('in_progress', 'field_tech', true), true)
})

test('admin edit route uses the online editor; dispatch retains the syncing wizard', () => {
  for (const role of ['platform_admin', 'dispatch']) {
    const route = loadFunction('./src/App.tsx', 'TicketEditRoute', {
      useAuth: () => ({ user: { role } }), useParams: () => ({ id: 'ticket' }), useState: () => ['other', () => {}], useEffect() {}, TicketEditPage: 'online', RequireSyncingRole: 'gate', TicketWizard: 'wizard',
      React: { createElement: (type, props, ...children) => ({ type, children }) },
    })()
    assert.equal(route.type, role === 'platform_admin' ? 'online' : 'gate')
    if (role === 'dispatch') assert.equal(route.children[0].type, 'wizard')
  }
  const source = readFileSync(new URL('./src/pages/TicketEditPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"].*(?:\/db|syncEngine|CustomerSearch)['"]/, 'office editor must not load offline modules')
})

test('office correction saves to HTTP, retains status, and shows server rejections without navigating', async () => {
  for (const rejected of [false, true]) {
    let navigated, error, submitted, saving = false
    const save = loadFunction('./src/pages/TicketEditPage.tsx', 'save', {
      ticket: { id: 'synthetic', status: 'in_progress', serviceDate: '2026-10-16T00:00:00.000Z', dispatchNotes: 'notes', workDescription: 'work', internalNotes: null },
      customer: { id: 'new' }, saving, Error,
      setSaving: value => { saving = value }, setError: value => { error = value },
      navigate: path => { navigated = path },
      api: { put: async (path, payload) => {
        submitted = { path, payload }
        if (rejected) throw new Error('Ticket is locked by billing')
      } },
    })
    await save()
    assert.equal(submitted.path, '/tickets/synthetic')
    assert.equal(submitted.payload.companyId, 'new')
    assert.equal(submitted.payload.serviceDate, '2026-10-16')
    assert.equal(submitted.payload.status, undefined)
    assert.equal(saving, false)
    if (rejected) { assert.equal(error, 'Ticket is locked by billing'); assert.equal(navigated, undefined) }
    else assert.equal(navigated, '/tickets/synthetic')
  }
})
