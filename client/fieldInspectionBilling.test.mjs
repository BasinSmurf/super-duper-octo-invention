import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { v5 as uuidv5 } from 'uuid'

const source = readFileSync(new URL('./src/lib/fieldInspectionBilling.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source.replace(/^import .*$/gm, '').replace(/export function/g, 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const { fieldInspectionBillingError: validate, fieldInspectionBillingLines: reconcile } = runInNewContext(`${compiled}; ({fieldInspectionBillingError, fieldInspectionBillingLines})`, { uuidv5 })
const pass = { id: 'inspection-a', serialNumber: 'SYN-PASS', outcome: 'pass', fieldBillingServices: [{ productId: 'monthly-fex', partNumber: '0611006', name: 'Monthly Fire Extinguisher Inspection', quantity: 1, rate: 5 }] }
const fail = { ...pass, id: 'inspection-b', serialNumber: 'SYN-FAIL', outcome: 'fail' }

test('mixed outcomes charge only the passing serial and retain unrelated labor', () => {
  const lines = reconcile([{ id: 'labor', description: 'Travel' }], [pass, fail])
  assert.equal(lines.length, 2)
  assert.equal(lines[0].id, 'labor')
  assert.equal(lines[1].total, 5)
  assert.equal(lines[1].productId, 'monthly-fex')
  assert.equal(lines[1].fieldInspectionId, pass.id)
  assert.match(lines[1].description, /SYN-PASS/)
  assert.equal(validate([pass, fail]), null)
})
test('retries and reopened corrections replace charges without duplicating them', () => {
  const initial = reconcile([], [pass])
  const reloaded = JSON.parse(JSON.stringify(initial))
  const corrected = reconcile(reloaded, [{ ...pass, fieldBillingServices: [{ ...pass.fieldBillingServices[0], rate: 7 }] }])
  assert.equal(corrected.length, 1)
  assert.equal(corrected[0].id, initial[0].id)
  assert.equal(corrected[0].total, 7)
  assert.equal(reconcile(corrected, []).length, 0)
  assert.equal(reconcile(corrected, [{ ...pass, outcome: 'fail' }]).length, 0)
})
test('two serials with the same service bill separately; removing a service removes its charge', () => {
  const second = { ...pass, id: 'inspection-c', serialNumber: 'SYN-PASS-2' }
  const lines = reconcile([], [pass, second])
  assert.equal(new Set(lines.map(l => l.id)).size, 2)
  assert.equal(lines.reduce((sum, l) => sum + l.total, 0), 10)
  assert.equal(reconcile(lines, [{ ...pass, fieldBillingServices: [] }, second]).length, 1)
})
test('missing and invalid prices block completion; an explicit zero rate is allowed', () => {
  assert.match(validate([{ ...pass, fieldBillingServices: [] }]), /Choose a billable/)
  for (const changes of [{ rate: NaN }, { rate: -1 }, { quantity: 0 }, { quantity: Infinity }])
    assert.match(validate([{ ...pass, fieldBillingServices: [{ ...pass.fieldBillingServices[0], ...changes }] }]), /valid quantity and rate/)
  assert.equal(validate([{ ...pass, fieldBillingServices: [{ ...pass.fieldBillingServices[0], rate: 0 }] }]), null)
  assert.equal(validate([{ ...fail, fieldBillingServices: [] }]), null)
})
