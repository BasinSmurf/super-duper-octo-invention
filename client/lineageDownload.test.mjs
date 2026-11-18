import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('./src/components/LineageDownloadButton.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText

function harness(tickets, failIds = new Set()) {
  const states = [], requests = [], downloads = [], revoked = []
  let index = 0
  const exports = {}
  const jsx = (type, props) => ({ type, props })
  runInNewContext(compiled, {
    exports,
    require: name => ({
      react: { useState: initial => { const slot = index++; if (!(slot in states)) states[slot] = initial; return [states[slot], value => { states[slot] = value }] } },
      'react/jsx-runtime': { jsx, jsxs: jsx },
      'lucide-react': { Download: 'download', Loader2: 'spinner' },
    })[name],
    localStorage: { getItem: () => 'session-token' },
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: ![...failIds].some(id => url === `/api/tickets/${id}/pdf` || (id === 'combined' && url === '/api/tickets/pdf-batch')), blob: async () => ({}), json: async () => ({ error: 'Export failed' }) }
    },
    URL: { createObjectURL: () => `blob:${requests.length}`, revokeObjectURL: url => revoked.push(url) },
    document: {
      body: { appendChild: () => {} },
      createElement: () => { const link = { click: () => downloads.push({ name: link.download, href: link.href }), remove: () => {} }; return link },
    },
    setTimeout: callback => callback(),
  })
  function render() { index = 0; return exports.LineageDownloadButton({ tickets }) }
  function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)] }
  const find = predicate => nodes(render()).find(predicate)
  return {
    requests, downloads, revoked,
    click: () => find(node => node.type === 'button').props.onClick(),
    retry: () => find(node => node.type === 'button' && node.props.children === 'Retry failed downloads').props.onClick(),
    status: () => find(node => node.props?.role === 'status')?.props.children,
    disabled: () => find(node => node.type === 'button').props.disabled,
    selectTicket: (serial, checked) => find(node => node.props?.['aria-label'] === `Select ${serial}`).props.onChange({ target: { checked } }),
    selectAll: checked => find(node => node.type === 'input' && !node.props['aria-label']).props.onChange({ target: { checked } }),
    format: value => find(node => node.type === 'select').props.onChange({ target: { value } }),
  }
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate) }

test('ten distinct tickets produce ten serial-named PDFs despite repeated lines and revisions', async () => {
  const tickets = Array.from({ length: 10 }, (_, i) => ({ ticketId: `t${i}`, ticketNumber: `SW-2026-${String(i + 1).padStart(5, '0')}` }))
  const app = harness([...tickets, ...tickets, tickets[0]])
  app.click()
  assert.equal(app.disabled(), true)
  await settle()
  assert.deepEqual(app.downloads.map(file => file.name), tickets.map(ticket => `${ticket.ticketNumber}.pdf`))
  assert.equal(app.requests.length, 10)
  assert.ok(app.requests.every(request => request.options.headers.Authorization === 'Bearer session-token'))
  assert.equal(app.revoked.length, 10)
  assert.equal(app.disabled(), false)
  assert.equal(app.status(), '10 PDF downloads started.')
})

test('continues after a failed ticket and retries only failed exports', async () => {
  const failures = new Set(['bad'])
  const app = harness([{ ticketId: 'bad', ticketNumber: 'SW-1' }, { ticketId: 'good', ticketNumber: 'SW-2' }], failures)
  app.click(); await settle()
  assert.deepEqual(app.downloads.map(file => file.name), ['SW-2.pdf'])
  assert.match(app.status(), /Could not export: SW-1/)
  failures.clear()
  app.retry(); await settle()
  assert.equal(app.requests.length, 3)
  assert.deepEqual(app.downloads.map(file => file.name), ['SW-2.pdf', 'SW-1.pdf'])
})

test('no associated tickets disables the download button', () => {
  assert.equal(harness([]).disabled(), true)
})

test('checkbox selection limits separate downloads and selecting none disables export', async () => {
  const app = harness([{ ticketId: 'one', ticketNumber: 'SW-1' }, { ticketId: 'two', ticketNumber: 'SW-2' }])
  app.selectAll(false)
  assert.equal(app.disabled(), true)
  app.selectTicket('SW-2', true)
  app.click(); await settle()
  assert.deepEqual(app.downloads.map(file => file.name), ['SW-2.pdf'])
  app.selectAll(true)
  app.click(); await settle()
  assert.equal(app.requests.length, 3)
})

test('all in one posts only selected unique tickets and saves one PDF', async () => {
  const one = { ticketId: 'one', ticketNumber: 'SW-1' }
  const app = harness([one, one, { ticketId: 'two', ticketNumber: 'SW-2' }])
  app.selectTicket('SW-2', false)
  app.format('combined')
  app.click(); await settle()
  assert.equal(app.requests.length, 1)
  assert.equal(app.requests[0].url, '/api/tickets/pdf-batch')
  assert.equal(app.requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(app.requests[0].options.body), { ticketIds: ['one'] })
  assert.deepEqual(app.downloads.map(file => file.name), ['billing-lineage-tickets.pdf'])
})

test('combined export failure downloads nothing and can be retried', async () => {
  const failures = new Set(['combined'])
  const app = harness([{ ticketId: 'one', ticketNumber: 'SW-1' }], failures)
  app.format('combined')
  app.click(); await settle()
  assert.equal(app.downloads.length, 0)
  assert.equal(app.status(), 'Export failed')
  failures.clear()
  app.retry(); await settle()
  assert.equal(app.downloads.length, 1)
})
