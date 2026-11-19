import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
const source = readFileSync(new URL('./src/lib/helpTips.ts', import.meta.url), 'utf8')
const context = { exports: {} }
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context)
const { helpTipsVisible, HELP_TIPS_DURATION_MS } = context.exports
const start = '2026-10-22T12:00:00Z'
const end = Date.parse(start) + HELP_TIPS_DURATION_MS
test('automatic help ends exactly 90 days after first use', () => {
  assert.equal(helpTipsVisible(start, null, end - 1), true)
  assert.equal(helpTipsVisible(start, null, end), false)
  assert.equal(helpTipsVisible(start, null, end + 1), false)
})
test('account overrides allow hiding early and showing after expiry', () => {
  assert.equal(helpTipsVisible(start, false, Date.parse(start)), false)
  assert.equal(helpTipsVisible(start, true, end + 1000), true)
})
test('missing and invalid dates do not accidentally enable automatic help', () => {
  assert.equal(helpTipsVisible(null, null), false)
  assert.equal(helpTipsVisible('invalid', null), false)
})
