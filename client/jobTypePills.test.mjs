import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('./src/components/JobTypePills.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const exports = {}
runInNewContext(compiled, {
  exports,
  require: name => name === '@/lib/cn' ? { cn: (...values) => values.filter(Boolean).join(' ') } : require(name),
})
const { deriveJobTypePills, JobTypePillRow } = exports
const labels = agreement => Array.from(deriveJobTypePills(agreement), pill => pill.label)

test('sandbox legacy trailer and BOM compositions render without a monitor list', () => {
  for (const composition of [{ trailer: { manned: false, rate: 100 } }, { bomPackage: { qty: 1 } }]) {
    assert.doesNotThrow(() => renderToStaticMarkup(createElement(JobTypePillRow, { agreement: { composition } })))
  }
  assert.deepEqual(labels({ composition: { trailer: { manned: false } } }), ['Unmanned'])
})

test('missing or malformed monitor lists use the legacy monitor flag', () => {
  for (const gasMonitors of [undefined, null, {}]) {
    assert.deepEqual(labels({ composition: { gasMonitors }, monitorsIncluded: true }), ['Monitors'])
    assert.deepEqual(labels({ composition: { gasMonitors }, monitorsIncluded: false }), [])
  }
})

test('an explicit empty monitor list overrides a stale legacy flag', () => {
  assert.deepEqual(labels({ composition: { gasMonitors: [] }, monitorsIncluded: true }), [])
})

test('complete compositions preserve the badge order and override legacy flags', () => {
  assert.deepEqual(labels({ composition: { drillingRig: true, trailer: { manned: true }, gasMonitors: [{ qty: 1 }] } }),
    ['Rig Job', 'Manned', 'Monitors'])
})

test('rentals without composition retain legacy badges', () => {
  assert.deepEqual(labels({ isRigJob: true, isManned: true, monitorsIncluded: true, composition: null }),
    ['Rig Job', 'Manned', 'Monitors'])
})
