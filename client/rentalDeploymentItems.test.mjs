import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/lib/rentalDeploymentItems.ts', import.meta.url), 'utf8')
const exports = {}
runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports })
const { rentalDeploymentLines, removeRentalDeployment } = exports

test('test dates format common input and retain free text', () => {
  assert.equal(exports.formatEquipmentTestDate('2026-10-08'), '10/08/2026')
  assert.equal(exports.formatEquipmentTestDate('10/8/2026'), '10/08/2026')
  assert.equal(exports.formatEquipmentTestDate('10082026'), '10/08/2026')
  assert.equal(exports.formatEquipmentTestDate('See inspection tag'), 'See inspection tag')
})

const item = (id, coveredBy) => ({
  id, serializedEquipmentId: `equipment-${id}`, productId: `product-${id}`,
  ...(coveredBy ? { deployInspection: { coveredBy } } : {}),
})
const ids = items => Array.from(items, row => row.id)

test('SCBA and trailer contents remain tracked without individual deploy lines', () => {
  const items = [item('pack'), item('regulator', 'pack'), item('cylinder', 'pack'),
    item('trailer'), item('trailer-cylinder', 'trailer'), item('monitor')]
  assert.deepEqual(ids(rentalDeploymentLines(items)), ['pack', 'trailer', 'monitor'])
  assert.equal(items.length, 6)
  assert.equal(items[1].serializedEquipmentId, 'equipment-regulator')
})

test('standalone regulator and cylinder still appear on the ticket', () => {
  const items = [item('regulator'), item('cylinder')]
  assert.deepEqual(ids(rentalDeploymentLines(items)), ['regulator', 'cylinder'])
})

test('restored draft components are grouped by their stored parent inspection', () => {
  const items = JSON.parse(JSON.stringify([item('pack'), item('regulator', 'pack')]))
  assert.deepEqual(ids(rentalDeploymentLines(items)), ['pack'])
})

test('an orphaned component stays visible so it cannot deploy unnoticed', () => {
  assert.deepEqual(ids(rentalDeploymentLines([item('regulator', 'missing')])), ['regulator'])
})

test('removing a pack removes all its tracked contents and leaves other gear', () => {
  const items = [item('pack'), item('regulator', 'pack'), item('cylinder', 'pack'),
    item('trailer'), item('trailer-cylinder', 'trailer')]
  assert.deepEqual(ids(removeRentalDeployment(items, 'pack')), ['trailer', 'trailer-cylinder'])
  assert.equal(items.length, 5)
})

test('removing an assembly removes nested contents regardless of list order', () => {
  const items = [item('bottle', 'pack'), item('pack', 'trailer'), item('trailer'), item('monitor')]
  assert.deepEqual(ids(removeRentalDeployment(items, 'trailer')), ['monitor'])
})

test('removing standalone gear leaves assembly components intact', () => {
  const items = [item('pack'), item('regulator', 'pack'), item('monitor')]
  assert.deepEqual(ids(removeRentalDeployment(items, 'monitor')), ['pack', 'regulator'])
})
