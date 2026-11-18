import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source = readFileSync(new URL('./src/pages/InvoiceDetailPage.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('InvoiceDetailPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let handler
function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleDownloadPdf') handler = node.getText(tree); ts.forEachChild(node, visit) }
visit(tree)
const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
function fixture(response) {
  const calls = { clicks: 0, revokes: [], busy: [], download: null, error: '' }
  const context = { invoice: { id: 'invoice-1', invoiceNumber: 'INV-1' }, pdfGenerating: false, pdfRequest: { current: null }, AbortController,
    localStorage: { getItem: () => 'test-token' }, fetch: async (url, options) => { calls.url = url; calls.authorization = options.headers.Authorization; return response },
    URL: { createObjectURL: () => 'blob:generated', revokeObjectURL: url => calls.revokes.push(url) },
    document: { createElement: () => ({ click() { calls.clicks++ } }), body: { appendChild() {}, removeChild() {} } },
    setPdfGenerating: v => calls.busy.push(v), setPdfError: v => { calls.error = v }, setPdfDownload: v => { calls.download = v } }
  return { calls, context, run: runInNewContext(`${js};handleDownloadPdf`, context) }
}
test('PDF uses authenticated endpoint and retains the URL for a visible download link', async () => {
  const { calls, run } = fixture({ ok: true, blob: async () => ({ size: 42, type: 'application/pdf' }) }); await run()
  assert.equal(calls.url, '/api/invoices/invoice-1/pdf'); assert.equal(calls.authorization, 'Bearer test-token')
  assert.equal(calls.clicks, 1); assert.equal(calls.download.fileName, 'invoice-INV-1.pdf'); assert.deepEqual(calls.revokes, []); assert.deepEqual(calls.busy, [true, false])
})
test('failed or non-PDF response exposes an error without a false download', async () => {
  for (const response of [{ ok: false }, { ok: true, blob: async () => ({ size: 10, type: 'text/html' }) }, { ok: true, blob: async () => ({ size: 0, type: 'application/pdf' }) }]) {
    const { calls, run } = fixture(response); await run(); assert.ok(calls.error); assert.equal(calls.clicks, 0); assert.equal(calls.download, null); assert.equal(calls.busy.at(-1), false)
  }
})
test('pending PDF generation cannot be submitted twice', async () => {
  const { calls, context, run } = fixture({}); context.pdfGenerating = true; await run(); assert.equal(calls.url, undefined); assert.deepEqual(calls.busy, [])
})
