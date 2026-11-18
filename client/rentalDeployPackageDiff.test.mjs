import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function load(file) {
  const exports = {}
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports })
  return exports
}
const { seedDeploymentRows, deploymentRowCategory } = load('./src/lib/rentalDeploymentItems.ts')
const { diffDeployedAgainstBaseline, netAlreadyLined } = load('./src/lib/rentalBom.ts')

// A real prod package (Hess manned): the bound rental items are catalogued under
// different categories than the package lines they fill.
const catalog = { p0412006: 'monitor_personal', p0414005: 'supplied_air_component', p0414006: 'misc' }
const productCategory = id => (id ? catalog[id] : null) ?? null
const rental = { id: 'ra', billingRateType: 'daily', composition: {
  trailer: { manned: true, rate: 0 }, gasMonitors: [], other: [], drillingRig: false,
  bom: [
    { label: 'Area Monitor', qty: 2, equipmentCategory: 'monitor_area', productId: 'p0412006' },
    { label: '5 Min Pack', qty: 4, equipmentCategory: 'supplied_air_component', productId: 'p0414005' },
    { label: '30 Min Pack', qty: 2, equipmentCategory: 'supplied_air_component', productId: 'p0414006' },
  ],
} }
let n = 0
// Results come from the vm realm; compare as plain data.
const plain = v => JSON.parse(JSON.stringify(v))
const diff = rows => diffDeployedAgainstBaseline(rental.composition.bom,
  netAlreadyLined(rows.map(row => deploymentRowCategory(row, productCategory)), new Map()))

test('a full package deployed as pre-filled matches the package exactly', () => {
  const rows = seedDeploymentRows(rental, () => `row-${n++}`)
  assert.equal(rows.length, 9) // trailer + 8 package units
  assert.deepEqual(plain(diff(rows).map(r => [r.equipmentCategory, r.over, r.short])),
    [['monitor_area', 0, 0], ['supplied_air_component', 0, 0]])
})

test('removing package rows still reads as short, against the right line', () => {
  const rows = seedDeploymentRows(rental, () => `row-${n++}`).filter(row => row.productName !== 'Area Monitor')
  const monitors = diff(rows).find(r => r.equipmentCategory === 'monitor_area')
  assert.equal(monitors.short, 2)
  assert.equal(diff(rows).some(r => r.over > 0), false)
})

test('an unbound package line still counts its rows', () => {
  const unbound = { ...rental, composition: { ...rental.composition, bom: [{ label: 'Area Monitor', qty: 2, equipmentCategory: 'monitor_area', productId: null }] } }
  const rows = seedDeploymentRows(unbound, () => `row-${n++}`)
  const result = diffDeployedAgainstBaseline(unbound.composition.bom, rows.map(row => deploymentRowCategory(row, productCategory)))
  assert.deepEqual(plain(result.map(r => [r.deployed, r.short, r.over])), [[2, 0, 0]])
})

test('rows not from the package keep their product category', () => {
  assert.equal(deploymentRowCategory({ productId: 'p0414005' }, productCategory), 'supplied_air_component')
  assert.equal(deploymentRowCategory({ productId: '' }, productCategory), null)
})
