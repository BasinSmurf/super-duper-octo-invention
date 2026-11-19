import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const lib = {}
runInNewContext(ts.transpileModule(readFileSync(new URL('./src/lib/rentalBom.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: lib })

const monitor = { id: 'mon', name: 'Area Gas Monitor Rental', defaultSellPrice: '150' }
const bare = {
  id: 'bare', bomType: 'unmanned', name: 'No monitors', isDefault: true, manned: false, includedTechs: 0,
  packageProductId: 'p-bare', packageProduct: { id: 'p-bare', name: 'Air Trailer - Base Rental (Daily)', defaultSellPrice: '250' },
  packageRate: 200, packagePriceLevel: 'Continental', items: [],
}
const withGas = {
  id: 'gas', bomType: 'unmanned', name: 'w/ gas detection (2 monitors)', isDefault: false, manned: false, includedTechs: 0,
  packageProductId: 'p-gas', packageProduct: { id: 'p-gas', name: 'Unmanned Air Trailer w/ Gas Detection', defaultSellPrice: '400' },
  packageRate: 300, packagePriceLevel: 'Continental',
  items: [{ id: 'i1', equipmentCategory: 'monitor_area', label: null, qty: 2, sortOrder: 0, productId: 'mon', product: monitor }],
}
const manned = { ...bare, id: 'man', bomType: 'manned', name: null, manned: true, isDefault: true }

test('several variants of one type: default first, others selectable', () => {
  const variants = lib.packageVariants([withGas, manned, bare], false, false)
  assert.deepEqual(variants.map(b => b.id), ['bare', 'gas'])
  assert.equal(lib.packageVariants([withGas, manned, bare], false, false)[0].id, 'bare')
  assert.deepEqual(lib.packageVariants([withGas, manned, bare], false, true).map(b => b.id), ['man'])
})

test('a legacy single package with no default flag still resolves', () => {
  const legacy = { ...bare, isDefault: undefined, name: undefined }
  assert.equal(lib.packageVariants([legacy], false, false)[0].id, 'bare')
})

test('variant picker names the variant, invoice line keeps the QB item name', () => {
  assert.equal(lib.bomDisplayName(withGas), 'Unmanned · w/ gas detection (2 monitors)')
  assert.equal(lib.bomPackageLine(withGas, 'daily').label, 'Unmanned Air Trailer w/ Gas Detection')
  assert.equal(lib.bomPackageLine(withGas, 'daily').rate, 300)
})

test('switching to a package that covers the monitors stops billing them as overages', () => {
  const next = lib.switchPackageComposition(withGas, 'daily', ['monitor_area', 'monitor_area'])
  assert.equal(next.bomPackage.productId, 'p-gas')
  assert.equal(next.bomPackage.rate, 300)
  assert.equal(next.bom[0].qty, 2)
  assert.equal(next.bomExtras.length, 0)
})

test('switching to a smaller package turns the excess on site into priced overages', () => {
  const oneMonitor = { ...withGas, id: 'one', items: [{ ...withGas.items[0], qty: 1 }] }
  const next = lib.switchPackageComposition(oneMonitor, 'daily', ['monitor_area', 'monitor_area', 'monitor_area'])
  assert.equal(next.bomExtras.length, 1)
  assert.equal(next.bomExtras[0].id, 'bomx-monitor_area')
  assert.equal(next.bomExtras[0].qty, 2)
  assert.equal(next.bomExtras[0].rate, 150)
})

test('a bare package has no row to price an overage from, so it arrives unrated for AR', () => {
  const next = lib.switchPackageComposition(bare, 'daily', ['monitor_area'])
  assert.equal(next.bomExtras.length, 1)
  assert.equal(next.bomExtras[0].qty, 1)
  assert.equal(next.bomExtras[0].rate, null)
})
