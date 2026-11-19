import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function module(name, dependencies = {}) {
  const context = { exports: {}, require: key => dependencies[key] ?? {} }
  const source = readFileSync(new URL(`./src/lib/${name}.ts`, import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return context.exports
}
const bom = module('rentalBom')
const pricing = module('priceLevels')
const area = { id: 'area', partNumber: '0412004', name: 'Area Gas Monitor Rental', productType: 'service',
  qbItemListId: 'qb-area', defaultSellPrice: '150.00', defaultRentalRateDaily: null, unitOfMeasure: 'DAY', isActive: true }
function setup({ get = async () => ({ data: [], total: 0 }), cache = [] } = {}) {
  let cacheReads = 0
  const db = { products: { where: () => ({ anyOf: () => ({ toArray: async () => { cacheReads++; return cache } }) }) } }
  const catalog = module('rentalCatalog', { './api': { api: { get } }, './db': { db }, './rentalBom': bom, './priceLevels': pricing })
  return { ...catalog, cacheReads: () => cacheReads }
}
const level = item => [{ name: 'Customer MSA', items: [{ qbItemListId: 'qb-area', ...item }] }]

function handler(file, attribute, contains) {
  const source = readFileSync(new URL(`./src/${file}.tsx`, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const matches = []
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === attribute
      && node.initializer && ts.isJsxExpression(node.initializer)
      && node.initializer.expression?.getText(ast).includes(contains)) matches.push(node.initializer.expression.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(matches.length, 1)
  return ts.transpileModule(`(${matches[0]})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}

test('selecting the QB area monitor in New Rental fills the actual rate input', () => {
  const { rentalCatalogRate } = setup()
  let rows = [{ id: 'line', productId: '', rate: null }]
  const onChange = runInNewContext(handler('components/DispatchRentalDialog', 'onChange', 'const opt = monitorProducts.find'), {
    monitorProducts: [area], idx: 0, rateForProduct: p => rentalCatalogRate(p, 'daily'),
    setGasMonitors: update => { rows = update(rows) },
  })
  onChange({ target: { value: 'area' } })
  assert.equal(rows[0].rate, 150)
  assert.equal(rows[0].productId, 'area')
  assert.equal(rows[0].manualRate, false)
})
test('selecting a QB other item keeps its identity and default rate', () => {
  const { rentalCatalogRate } = setup()
  let rows = []
  const onSelect = runInNewContext(handler('components/DispatchRentalDialog', 'onSelect', 'setOtherItems'), {
    uuidv4: () => 'line', rateForProduct: p => rentalCatalogRate(p, 'daily'),
    setOtherItems: update => { rows = update(rows) },
  })
  onSelect(area)
  assert.equal(rows[0].productId, 'area')
  assert.equal(rows[0].rate, 150)
})
test('replacing a monitor in Edit Rental seeds the QB rate too', () => {
  const { rentalCatalogRate } = setup()
  let patch
  const onChange = runInNewContext(handler('pages/RentalDetailPage', 'onChange', 'const opt = monitorProducts.find'), {
    monitorProducts: [area], idx: 0, rentalCatalogRate, editPriceLevels: [],
    edit: { rateType: 'daily', monitors: [{ id: 'line', rate: null }] }, patchEdit: value => { patch = value },
  })
  onChange({ target: { value: 'area' } })
  assert.equal(patch.monitors[0].rate, 150)
  assert.equal(patch.compTouched, true)
})

test('area monitor defaults to the QB $150 daily rate when rental-specific columns are empty', () => {
  const { rentalCatalogRate } = setup()
  assert.equal(rentalCatalogRate(area, 'daily'), 150)
  assert.equal(rentalCatalogRate({ ...area, defaultRentalRateDaily: '65' }, 'daily'), 65)
  assert.equal(rentalCatalogRate({ ...area, defaultSellPrice: null }, 'daily'), null)
  assert.equal(rentalCatalogRate({ ...area, productType: 'sale', name: 'EXO 8 Area Monitor', defaultSellPrice: '7044' }, 'daily'), null)
})
test('customer fixed and percentage prices apply once, including an explicit free rate', () => {
  const { rentalCatalogRate } = setup()
  assert.equal(rentalCatalogRate(area, 'daily', level({ customPrice: 125 })), 125)
  assert.equal(rentalCatalogRate(area, 'daily', level({ adjustPercent: -10 })), 135)
  assert.equal(rentalCatalogRate(area, 'daily', level({ customPrice: 0 })), 0)
  assert.equal(rentalCatalogRate({ ...area, defaultSellPrice: null }, 'daily', level({ customPrice: 125 })), 125)
  assert.equal(rentalCatalogRate({ ...area, defaultSellPrice: null }, 'daily', level({ adjustPercent: -10 })), null)
})
test('daily QB prices are not silently used as weekly or monthly rates', () => {
  const { rentalCatalogRate } = setup()
  assert.equal(rentalCatalogRate(area, 'weekly'), null)
  assert.equal(rentalCatalogRate(area, 'monthly'), null)
  assert.equal(rentalCatalogRate({ ...area, defaultRentalRateWeekly: '750' }, 'weekly'), 750)
})
test('late customer pricing refreshes automatic quotes but preserves manual edits and free overrides', () => {
  const { repriceRentalRows } = setup()
  const rows = [
    { productId: 'area', rate: 150 }, { productId: 'area', rate: 120, manualRate: true },
    { productId: 'area', rate: 0, manualRate: true },
  ]
  assert.deepEqual(Array.from(repriceRentalRows(rows, [area], 'daily', level({ adjustPercent: -10 })), r => r.rate), [135, 120, 0])
  assert.equal(repriceRentalRows(rows, [area], 'weekly', [])[0].rate, null)
})
test('monitor picker excludes inactive items, equipment sale prices, and trailer packages', () => {
  const { isRentalMonitor } = setup()
  assert.equal(isRentalMonitor(area), true)
  assert.equal(isRentalMonitor({ ...area, isActive: false }), false)
  assert.equal(isRentalMonitor({ ...area, name: 'EXO 8 Area Monitor', productType: 'sale', defaultSellPrice: '7044' }), false)
  assert.equal(isRentalMonitor({ ...area, name: 'Air Trailer Daily Rental w/ 1 Area Monitor' }), false)
  assert.equal(isRentalMonitor({ ...area, productType: 'rental', qbItemListId: null }), true)
})
test('office users get all API catalog pages even with an empty device cache', async () => {
  const requests = []
  const helper = setup({ get: async path => {
    requests.push(path)
    const personal = path.includes('monitor_personal')
    return personal ? { data: [path.endsWith('offset=0') ? area : { ...area, id: 'additional', name: 'Additional Area Gas Monitor Rental' }], total: 2 }
      : { data: [], total: 0 }
  } })
  const products = await helper.loadRentalMonitors()
  assert.deepEqual(Array.from(products, p => p.id).sort(), ['additional', 'area'])
  assert.equal(helper.cacheReads(), 0)
  assert.ok(requests.some(path => path.includes('offset=1')))
  assert.ok(requests.every(path => path.includes('active=true')))
})
test('network failures use the active cached rental catalog', async () => {
  const helper = setup({ get: async () => { throw Error('offline') }, cache: [area, { ...area, id: 'inactive', isActive: false }] })
  assert.deepEqual(Array.from(await helper.loadRentalMonitors(), p => p.id), ['area'])
  assert.equal(helper.cacheReads(), 1)
})
