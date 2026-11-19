import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/components/ShopUnitEntry.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const exports = {}
runInNewContext(compiled, { exports, require() { return {} } })
const { buildShopItemPayload, resolveScbaParts } = exports

function scba(overrides = {}) {
  return {
    serialNumber: '', equipmentCategory: 'scba', serviceType: 'inspection',
    scbaCaseSerial: 'CASE-123', scbaRegulatorSerial: 'REG-123',
    scbaMaskSerial: '', scbaHarnessSerial: '', scbaBottleSerials: ['BOTTLE-123'],
    ...overrides,
  }
}

test('matching unit and case numbers are submitted once, preserving other components', () => {
  const payload = buildShopItemPayload(scba({ serialNumber: 'CASE-123' }))
  assert.equal(payload.serialNumber, 'CASE-123')
  assert.deepEqual(Array.from(payload.components, c => c.type), ['regulator', 'bottle'])
  assert.equal(new Set([payload.serialNumber, ...payload.components.map(c => c.serialNumber)]).size, 3)
})

test('case supplies a blank unit serial without creating a duplicate child', () => {
  const payload = buildShopItemPayload(scba())
  assert.equal(payload.serialNumber, 'CASE-123')
  assert.equal(payload.components.some(c => c.type === 'case'), false)
})

test('case alias comparison ignores whitespace and capitalization', () => {
  const payload = buildShopItemPayload(scba({ serialNumber: ' case-123 ', scbaCaseSerial: ' CASE-123 ' }))
  assert.equal(payload.serialNumber, 'case-123')
  assert.equal(payload.components.some(c => c.type === 'case'), false)
})

test('a differently numbered case remains a separately recorded component', () => {
  const payload = buildShopItemPayload(scba({ serialNumber: 'PACK-123' }))
  assert.equal(payload.serialNumber, 'PACK-123')
  assert.equal(payload.components.find(c => c.type === 'case').serialNumber, 'CASE-123')
})

test('a case-only SCBA does not submit any duplicate components', () => {
  const payload = buildShopItemPayload(scba({ scbaRegulatorSerial: '', scbaBottleSerials: [] }))
  assert.equal(payload.serialNumber, 'CASE-123')
  assert.equal(payload.components, undefined)
})

test('other duplicate component serials stay in the payload for server validation', () => {
  const payload = buildShopItemPayload(scba({ scbaRegulatorSerial: 'CASE-123' }))
  assert.equal(payload.components.find(c => c.type === 'regulator').serialNumber, payload.serialNumber)
})

test('parts not included are flagged without a serial and never become units', () => {
  const payload = buildShopItemPayload(scba({ serialNumber: 'PACK-123', scbaNotIncluded: ['mask', 'harness'] }))
  const flagged = payload.components.filter(c => c.notIncluded)
  assert.deepEqual(Array.from(flagged, c => c.type), ['mask', 'harness'])
  assert.equal(flagged.some(c => 'serialNumber' in c), false)
})

test('a lone cylinder is identified by its bottle serial with no duplicate child', () => {
  const draft = resolveScbaParts({
    serial: '', caseSerial: '', regulatorSerial: 'N/A', maskSerial: '', harnessSerial: '',
    bottleSerials: ['CYL-123'], notIncluded: ['case'],
  })
  assert.equal(draft.serial, 'CYL-123')
  assert.deepEqual(Array.from(draft.notIncluded), ['case', 'regulator'])
  const payload = buildShopItemPayload(scba({
    serialNumber: draft.serial, scbaCaseSerial: draft.caseSerial, scbaRegulatorSerial: draft.regulatorSerial,
    scbaBottleSerials: draft.bottleSerials, scbaNotIncluded: draft.notIncluded,
  }))
  assert.equal(payload.customData.unitSerialPart, 'bottle')
  assert.equal(payload.components.some(c => c.serialNumber), false)
})

test('other categories do not use a stale SCBA case as their serial', () => {
  const payload = buildShopItemPayload(scba({ equipmentCategory: 'other' }))
  assert.equal(payload.serialNumber, '')
  assert.equal(payload.components, undefined)
})
