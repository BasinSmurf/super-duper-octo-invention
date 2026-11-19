import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const js = ts.transpileModule(readFileSync(new URL('./src/lib/inspectionApproval.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { inspectionApproval } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const now = '2026-11-16T12:00:00Z'
const previous = { customerApprovedName: 'Jane', customerApprovedSignature: 'data:image/png;base64,old', customerApprovedAt: '2026-10-01T12:00:00Z' }
test('new approval captures the signature and current timestamp', () => {
  assert.deepEqual(inspectionApproval(' Jane ', 'data:image/png;base64,new', undefined, now), {
    customerApprovedName: 'Jane', customerApprovedSignature: 'data:image/png;base64,new', customerApprovedAt: now,
  })
})
test('editing unrelated inspection fields preserves the original approval time', () => {
  assert.deepEqual(inspectionApproval('Jane', previous.customerApprovedSignature, previous, now), previous)
})
test('changing the approver or replacing the signature records a fresh approval', () => {
  assert.equal(inspectionApproval('John', previous.customerApprovedSignature, previous, now).customerApprovedAt, now)
  assert.equal(inspectionApproval('Jane', 'data:image/png;base64,new', previous, now).customerApprovedAt, now)
})
test('clearing approval clears its date; existing name-only approvals remain valid', () => {
  assert.deepEqual(inspectionApproval('', null, previous, now), { customerApprovedName: null, customerApprovedSignature: null, customerApprovedAt: null })
  const old = { ...previous, customerApprovedSignature: null }
  assert.deepEqual(inspectionApproval('Jane', null, old, now), old)
})
