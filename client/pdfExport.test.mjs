import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('./src/components/PdfExportButton.tsx', import.meta.url), 'utf8')
const compile = (source, fileName = 'component.tsx') => ts.transpileModule(source, { fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const compiled = compile(source)
const apiCompiled = compile(readFileSync(new URL('./src/lib/api.ts', import.meta.url), 'utf8'), 'api.ts')

function harness(count, { failDownload = false, url = '/api/tickets/123/pdf' } = {}) {
  const states = []
  let index = 0
  const requests = [], downloads = [], errors = [], summaries = []
  const out = {}
  const jsx = (type, props) => ({ type, props })
  const modules = {
    react: { useState: initial => { const slot = index++; if (!(slot in states)) states[slot] = initial; return [states[slot], value => { states[slot] = value }] } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': { FileDown: 'icon', Loader2: 'spinner' },
    '@/lib/api': {},
  }
  const context = {
    exports: out, require: name => modules[name],
    window: { alert: message => errors.push(message) },
    localStorage: { getItem: () => 'token' },
    sessionStorage: { getItem: () => null },
    fetch: async (url, options) => {
      if (url.endsWith('/pdf-attachments')) {
        summaries.push(url)
        const valid = /^\/api\/(tickets|shop-orders)\/[^/]+\/pdf-attachments$/.test(url)
        return { ok: valid, status: valid ? 200 : 404, json: async () => valid ? { count } : { error: 'Request failed' } }
      }
      requests.push({ url, options })
      return { ok: !failDownload, json: async () => ({ error: 'Could not include attachment "test.pdf"' }), blob: async () => ({}) }
    },
    URL: { createObjectURL: () => 'blob:pdf', revokeObjectURL: () => {} },
    document: { createElement: () => { const anchor = { click: () => downloads.push({ name: anchor.download, href: anchor.href }) }; return anchor } },
    setTimeout: callback => callback(),
  }
  const apiExports = {}
  runInNewContext(apiCompiled, { ...context, exports: apiExports })
  modules['@/lib/api'] = apiExports
  runInNewContext(compiled, context)
  function render() { index = 0; return out.PdfExportButton({ url, fileName: 'ticket.pdf' }) }
  function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)] }
  const find = predicate => nodes(render()).find(predicate)
  return {
    requests, downloads, errors, summaries,
    clickExport: () => find(node => node.type === 'button' && node.props['aria-label'] === 'Export PDF').props.onClick(),
    click: label => find(node => node.type === 'button' && node.props.children === label).props.onClick(),
    dialog: () => find(node => node.props?.role === 'dialog'),
  }
}
async function settle() { for (let index = 0; index < 4; index++) await new Promise(setImmediate) }

test('asks only when attachments exist and includes them on request', async () => {
  const app = harness(3)
  app.clickExport(); await settle()
  assert.equal(app.summaries[0], '/api/tickets/123/pdf-attachments')
  assert.deepEqual(app.errors, [])
  assert.ok(app.dialog())
  assert.equal(app.requests.length, 0)
  app.click('Include attachments'); await settle()
  assert.equal(app.requests[0].url, '/api/tickets/123/pdf?includeAttachments=true')
  assert.equal(app.requests[0].options.headers.Authorization, 'Bearer token')
  assert.equal(app.downloads[0].name, 'ticket.pdf')
})
test('without attachments downloads the base PDF; cancel downloads nothing', async () => {
  const app = harness(2, { url: '/api/shop-orders/123/pdf' })
  app.clickExport(); await settle(); app.click('Cancel'); await settle()
  assert.equal(app.requests.length, 0)
  assert.equal(app.dialog(), undefined)
  app.clickExport(); await settle(); app.click('Without attachments'); await settle()
  assert.equal(app.summaries[0], '/api/shop-orders/123/pdf-attachments')
  assert.equal(app.requests[0].url, '/api/shop-orders/123/pdf')
})
test('no files exports directly and occupational-health report uses the same inventory', async () => {
  const app = harness(0, { url: '/api/tickets/123/occ-health-pdf' })
  app.clickExport(); await settle()
  assert.equal(app.summaries[0], '/api/tickets/123/pdf-attachments')
  assert.equal(app.dialog(), undefined)
  assert.equal(app.requests[0].url, '/api/tickets/123/occ-health-pdf')
})
test('failed attachment export shows the server reason and downloads no partial PDF', async () => {
  const app = harness(1, { failDownload: true })
  app.clickExport(); await settle(); app.click('Include attachments'); await settle()
  assert.match(app.errors[0], /test.pdf/)
  assert.equal(app.downloads.length, 0)
})

for (const url of ['/api/tickets/123/pdf', '/api/shop-orders/123/pdf']) {
  test(`exports ${url} without prompting when there are no attachments`, async () => {
    const app = harness(0, { url })
    app.clickExport(); await settle()
    assert.deepEqual(app.errors, [])
    assert.equal(app.dialog(), undefined)
    assert.equal(app.requests[0].url, url)
    assert.equal(app.downloads.length, 1)
  })
}
