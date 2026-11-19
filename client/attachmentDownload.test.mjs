import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const code = ts.transpileModule(readFileSync(new URL('./src/lib/attachmentDownload.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
function fixture(ok = true) {
  const calls = { clicked: 0, removed: 0, revoked: [] }
  const link = { click() { calls.clicked++ }, remove() { calls.removed++ } }
  const context = { exports: {}, localStorage: { getItem: () => 'jwt' },
    fetch: async (url, options) => { calls.url = url; calls.headers = options.headers; return { ok, blob: async () => 'bytes' } },
    URL: { createObjectURL: () => 'blob:attachment', revokeObjectURL: url => calls.revoked.push(url) },
    document: { createElement: () => link, body: { appendChild() {} } }, setTimeout: callback => { calls.cleanup = callback } }
  runInNewContext(code, context)
  return { calls, link, open: context.exports.openStoredAttachment }
}
test('downloads B2 attachments with authorization and releases the temporary object URL', async () => {
  const { calls, link, open } = fixture()
  await open('a/b', 'UE report.pdf')
  assert.equal(calls.url, '/api/attachments/a%2Fb/content')
  assert.equal(calls.headers.Authorization, 'Bearer jwt')
  assert.equal(link.download, 'UE report.pdf')
  assert.equal(calls.clicked, 1); assert.equal(calls.removed, 1)
  calls.cleanup(); assert.deepEqual(calls.revoked, ['blob:attachment'])
})
test('failed storage reads do not create a misleading download', async () => {
  const { calls, open } = fixture(false)
  await assert.rejects(open('missing', 'missing.pdf'), /Could not open/)
  assert.equal(calls.clicked, 0)
})
