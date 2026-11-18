import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/lib/defaultLineItems.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText

function harness(products) {
  const exports = {}
  const lookups = []
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'uuid') return { v4: () => 'line-id' }
      if (name === './db') return { db: { products: { where: () => ({
        equals(partNumber) {
          lookups.push(partNumber)
          return { first: async () => products.find(p => p.partNumber === partNumber) }
        },
      }) } } }
      if (name === './divisions') return {
        divisionLaborPartNumber: d => `0${d}00002`,
        divisionMileagePartNumber: d => `0${d}00001`,
      }
      if (name === './priceLevels') return {
        priceLine: (levels, product) => ({
          rate: levels?.[0]?.rate ?? product.defaultSellPrice,
          listRate: product.defaultSellPrice,
          priceLevelName: levels?.[0]?.name,
        }),
      }
      throw new Error(`Unexpected import: ${name}`)
    },
  })
  return { getDefaults: exports.getDefaultLineItems, lookups }
}

const products = [
  { id: 'inspection', partNumber: '0311001', name: 'Primary Breathing Air Inspection', defaultSellPrice: 150, unitOfMeasure: 'EA' },
  { id: 'labor', partNumber: '0300002', name: 'Labor', defaultSellPrice: 85 },
  { id: 'mileage', partNumber: '0300001', name: 'Mileage', defaultSellPrice: 3 },
]

test('D3 air inspection seeds only its catalog charge with customer pricing', async () => {
  const h = harness(products)
  const lines = await h.getDefaults('cascade_air_inspection', 3, [{ name: 'Contract', rate: 125 }])
  assert.equal(lines.length, 1)
  assert.equal(lines[0].partNumber, '0311001')
  assert.equal(lines[0].description, 'Primary Breathing Air Inspection')
  assert.equal(lines[0].productId, 'inspection')
  assert.equal(lines[0].quantity, 1)
  assert.equal(lines[0].rate, 125)
  assert.equal(lines[0].total, 125)
  assert.deepEqual(h.lookups, ['0311001'])
})

test('missing inspection product never falls back to generic labor or mileage', async () => {
  const h = harness(products.slice(1))
  assert.equal((await h.getDefaults('cascade_air_inspection', 3)).length, 0)
  assert.deepEqual(h.lookups, ['0311001'])
})

test('other air service retains division labor and mileage defaults', async () => {
  const h = harness(products)
  const lines = await h.getDefaults('cascade_air', 3)
  assert.deepEqual(Array.from(lines, l => l.partNumber), ['0300002', '0300001'])
})
