import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('./src/lib/enverusWarnings.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { enverusWarnings } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('shows the additional-inspection alert even though the receipt was submitted successfully', () => {
  const receipt = { status: 'SUBMITTED', lineItems: [
    { lineItemNumber: '1', complianceAlerts: { priceBook: { green: { conditions: ['Compliant'] } } } },
    { lineItemNumber: '2', productServiceCode: '0311004', complianceAlerts: { priceBook: { yellow: { conditions: ['Item is not covered by the price book.'] } } } },
  ] }
  assert.deepEqual(enverusWarnings({ receipt }), ['Line 2 (0311004): Item is not covered by the price book.'])
})
test('preserves POST warnings from saved queue responses and tolerates malformed historical data', () => {
  const response = JSON.stringify({ confirmMessage: { resourceMessages: [{ processMessages: [
    { messageTypeCode: { codeValue: 'warning' }, developerMessage: { messageTxt: 'Supplier site fallback' } },
  ] }] } })
  assert.deepEqual(enverusWarnings(response, response, '{bad', null), ['Supplier site fallback'])
})
