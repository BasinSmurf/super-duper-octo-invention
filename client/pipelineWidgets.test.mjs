import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const dates = {}
runInNewContext(compile(readFileSync(new URL('./src/lib/dates.ts', import.meta.url), 'utf8')), { exports: dates })
const code = compile(readFileSync(new URL('./src/components/widgets/PipelineWidgets.tsx', import.meta.url), 'utf8'))

function view(name, result, user = { id: 'staff-1', role: 'boss' }) {
  const exports = {}, requests = []
  let retries = 0
  runInNewContext(code, { exports, require: module => ({
    'react-router-dom': { Link: ({ to, children, ...props }) => createElement('a', { ...props, href: to }, children) },
    '@/contexts/AuthContext': { useAuth: () => ({ user }) },
    '@/hooks/useApiResource': { useApiResource: (path, scope) => {
      requests.push({ path, scope })
      return { data: null, error: null, loading: false, reload: () => retries++, ...result }
    } },
    '@/lib/dates': dates,
  })[module] ?? require(module) })
  const tree = exports[name]()
  const flatten = node => {
    if (!node || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap(flatten)
    if (typeof node.type === 'function') return flatten(node.type(node.props))
    return [node, ...flatten(node.props?.children)]
  }
  return { html: renderToStaticMarkup(tree), requests,
    retry: () => flatten(tree).find(node => node.type === 'button').props.onClick(),
    get retries() { return retries },
  }
}

for (const name of ['QbSyncQueueWidget', 'TicketVolumeWidget']) {
  test(`${name} distinguishes loading, failure and retry from empty results`, () => {
    const loading = view(name, { loading: true })
    assert.match(loading.html, /role="status"/)
    assert.doesNotMatch(loading.html, /No (invoices|tickets)/)
    const failed = view(name, { error: 'Network failed' })
    assert.match(failed.html, /role="alert"/)
    assert.match(failed.html, /Network failed/)
    failed.retry()
    assert.equal(failed.retries, 1)
    assert.match(view(name, {}).html, /did not return data/)
  })
  test(`${name} scopes its request to the signed-in account and role`, () => {
    const first = view(name, { loading: true })
    assert.equal(first.requests[0].scope, 'staff-1:boss')
    const switched = view(name, { loading: true }, { id: 'staff-2', role: 'dispatch' })
    assert.equal(switched.requests[0].scope, 'staff-2:dispatch')
    assert.equal(view(name, { loading: true }, null).requests[0].path, null)
  })
}

test('QuickBooks shows all pipeline stages and opens a real billing route', () => {
  const result = view('QbSyncQueueWidget', { data: { pipeline: { approvedInvoices: 2, queuedInvoices: 3, soCreatedInvoices: 4 } } })
  assert.equal(result.requests[0].path, '/dashboard/billing-summary')
  assert.match(result.html, /Approved.*ready to push/)
  assert.match(result.html, /Queued for QuickBooks/)
  assert.match(result.html, /Sales orders.*awaiting conversion/)
  for (const count of [2, 3, 4]) assert.match(result.html, new RegExp(`>${count}</dd>`))
  assert.match(result.html, /href="\/billing"/)
  assert.doesNotMatch(result.html, /TBD|No invoices/)
})

test('QuickBooks explicitly describes an empty pipeline', () => {
  assert.match(view('QbSyncQueueWidget', { data: { pipeline: { approvedInvoices: 0, queuedInvoices: 0, soCreatedInvoices: 0 } } }).html, /No invoices awaiting QuickBooks processing/)
})

test('Ticket Volume renders dated counts, zero days, and an accessible table', () => {
  const result = view('TicketVolumeWidget', { data: { from: '2026-10-18', to: '2026-11-16', total: 3,
    days: [{ date: '2026-10-18', count: 0 }, { date: '2026-10-19', count: 3 }, { date: '2026-11-16', count: 0 }] } })
  assert.equal(result.requests[0].path, '/dashboard/ticket-volume')
  assert.match(result.html, /Central time.*excludes drafts and voids/)
  assert.match(result.html, /Daily counts/)
  assert.match(result.html, /scope="col">Service date/)
  assert.match(result.html, /Oct 18/)
  assert.match(result.html, /Nov 16/)
  assert.match(result.html, /height:0%/)
  assert.match(result.html, /height:100%/)
  assert.match(result.html, /href="\/tickets"/)
  assert.doesNotMatch(result.html, /NaN|Infinity|TBD/)
})

test('Ticket Volume describes empty results without invalid bar dimensions', () => {
  const html = view('TicketVolumeWidget', { data: { from: '2026-10-18', to: '2026-11-16', total: 0, days: [{ date: '2026-10-18', count: 0 }] } }).html
  assert.match(html, /No tickets in this period/)
  assert.doesNotMatch(html, /NaN|Infinity/)
})
