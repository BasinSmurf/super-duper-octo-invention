import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const hookCode = compile(readFileSync(new URL('./src/hooks/useApiResource.ts', import.meta.url), 'utf8'))
const tick = () => new Promise(resolve => setImmediate(resolve))

// Exercise the actual hook with React's state/effect ordering, without a browser.
function resource() {
  const states = [], requests = []
  let cursor = 0, effect, previousDeps, cleanup, updates = 0
  const context = { exports: {}, AbortController, Error, require(name) {
    if (name === 'react') return {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = initial
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; updates++ }]
      },
      useCallback: callback => callback,
      useEffect: (callback, deps) => { effect = { callback, deps } },
    }
    if (name === '@/lib/api') return { api: { get(path, { signal }) {
      let resolve, reject
      const promise = new Promise((done, fail) => { resolve = done; reject = fail })
      requests.push({ path, signal, resolve, reject })
      return promise
    } } }
    throw new Error(`Unexpected import: ${name}`)
  } }
  runInNewContext(hookCode, context)
  return {
    requests,
    render(path, scope = 'user-1') {
      cursor = 0
      const value = context.exports.useApiResource(path, scope)
      if (!previousDeps || effect.deps.some((dep, index) => dep !== previousDeps[index])) {
        cleanup?.(); cleanup = effect.callback(); previousDeps = [...effect.deps]
      }
      return value
    },
    unmount() { cleanup?.() },
    get updates() { return updates },
  }
}

for (const path of ['/dashboard/service-history?companyId=', '/dashboard/h2s-analytics?companyId=']) {
  test(`${path} ignores out-of-order responses after a customer switch`, async () => {
    const view = resource()
    assert.equal(view.render(`${path}old`).loading, true)
    assert.equal(view.render(`${path}new`).data, null)
    assert.equal(view.requests[0].signal.aborted, true)
    view.requests[1].resolve({ companyId: 'new' }); await tick()
    assert.equal(view.render(`${path}new`).data.companyId, 'new')
    view.requests[0].resolve({ companyId: 'old' }); await tick()
    assert.equal(view.render(`${path}new`).data.companyId, 'new')
  })
}
test('changing dates or account hides the previous result before effects finish', async () => {
  const view = resource(), path = '/dashboard/service-history?dateFrom=2026-11-01'
  view.render(path); view.requests[0].resolve({ total: 123 }); await tick()
  assert.equal(view.render(path).data.total, 123)
  assert.equal(view.render(`${path}&ticketType=training`).data, null)
  assert.equal(view.render(`${path}&ticketType=training`, 'different-user').data, null)
  assert.equal(view.requests[1].signal.aborted, true)
  assert.equal(view.requests.length, 3)
})
test('closing a tab or unmounting cancels requests and prevents late state updates', async () => {
  const view = resource()
  view.render('/dashboard/billing-summary')
  assert.equal(view.render(null).loading, false)
  assert.equal(view.requests[0].signal.aborted, true)
  view.requests[0].resolve({ pipeline: 'old' }); await tick()
  assert.equal(view.updates, 0)
  view.render('/dashboard/billing-summary'); view.unmount()
  view.requests[1].reject(new Error('late network error')); await tick()
  assert.equal(view.updates, 0)
})
test('failed reports expose an error and Retry starts a clean request', async () => {
  const view = resource(), path = '/dashboard/service-history'
  view.render(path); view.requests[0].reject(new Error('Network unavailable')); await tick()
  const failed = view.render(path)
  assert.equal(failed.error, 'Network unavailable'); assert.equal(failed.loading, false)
  failed.reload()
  const retrying = view.render(path)
  assert.equal(retrying.error, null); assert.equal(retrying.loading, true)
  view.requests[1].resolve({ customers: ['current'] }); await tick()
  assert.deepEqual(view.render(path).data.customers, ['current'])
})

const apiCode = compile(readFileSync(new URL('./src/lib/api.ts', import.meta.url), 'utf8'))
function apiFixture(status, abortDuringFetch = false, replaceToken = false) {
  const controller = new AbortController(), calls = { removed: [], token: 'test-token' }
  const context = { exports: {}, DOMException, window: { location: { href: '/dashboard' } },
    localStorage: { getItem: () => calls.token, removeItem: key => calls.removed.push(key) },
    sessionStorage: { getItem: () => null },
    fetch: async (url, options) => {
      calls.url = url; calls.options = options
      if (abortDuringFetch) controller.abort()
      if (replaceToken) calls.token = 'new-token'
      return { status, ok: status === 200, json: async () => ({ value: 'result' }) }
    },
  }
  runInNewContext(apiCode, context)
  return { api: context.exports.api, calls, controller, context }
}
test('API GET retains authentication while forwarding the cancellation signal', async () => {
  const { api, calls, controller } = apiFixture(200)
  await api.get('/dashboard/billing-summary', { signal: controller.signal })
  assert.equal(calls.options.signal, controller.signal)
  assert.equal(calls.options.headers.Authorization, 'Bearer test-token')
})
test('an obsolete 401 cannot clear a newer login, while a current 401 still signs out', async () => {
  const cancelled = apiFixture(401, true)
  await assert.rejects(cancelled.api.get('/dashboard/service-history', { signal: cancelled.controller.signal }), error => error.name === 'AbortError')
  assert.deepEqual(cancelled.calls.removed, []); assert.equal(cancelled.context.window.location.href, '/dashboard')
  const switched = apiFixture(401, false, true)
  await assert.rejects(switched.api.get('/dashboard/service-history'), /Session changed/)
  assert.deepEqual(switched.calls.removed, []); assert.equal(switched.context.window.location.href, '/dashboard')
  const current = apiFixture(401)
  await assert.rejects(current.api.get('/dashboard/service-history'), /Session expired/)
  assert.deepEqual(current.calls.removed, ['sundog_token', 'sundog_user'])
  assert.equal(current.context.window.location.href, '/login')
})

const dashboard = readFileSync(new URL('./src/pages/DashboardPage.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('DashboardPage.tsx', dashboard, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function handler(name) {
  let found
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree); ts.forEachChild(node, visit) }
  visit(tree)
  assert.ok(found, `Missing dashboard handler ${name}`)
  return compile(found)
}
test('changing customers resets dependent location filters immediately', () => {
  const calls = {}, company = { id: 'new', name: 'New Customer' }
  const context = {
    setSelectedCompany: value => { calls.historyCompany = value }, setSelectedPadId: value => { calls.pad = value },
    setH2sCompany: value => { calls.h2sCompany = value }, setH2sLocationKey: value => { calls.location = value }, setH2sPieFilter: value => { calls.pie = value },
  }
  runInNewContext(handler('selectHistoryCompany'), context); context.selectHistoryCompany(company)
  runInNewContext(handler('selectH2sCompany'), context); context.selectH2sCompany(company)
  assert.equal(calls.pad, null); assert.equal(calls.location, null); assert.equal(calls.pie, 'all')
  assert.equal(calls.historyCompany, company); assert.equal(calls.h2sCompany, company)
})
