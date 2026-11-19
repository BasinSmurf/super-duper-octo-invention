import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function findNode(file, match) {
  const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let result
  function walk(node) { if (match(node, ast)) result = node; ts.forEachChild(node, walk) }
  walk(ast)
  assert.ok(result)
  return result.getText(ast)
}
const fn = name => node => ts.isFunctionDeclaration(node) && node.name?.text === name
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

test('deselecting the baseline removes package contents and charges while preserving manual items', () => {
  const bomExports = {}
  runInNewContext(ts.transpileModule(readFileSync(new URL('./src/lib/rentalBom.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: bomExports })
  const names = ['bomVariants', 'resolvedBom', 'baselineItems', 'packageLine', 'manualPackageLine', 'packageRateLine',
    'boundPackageBills', 'manualPackageBills', 'packageBills', 'compositionPriced', 'composition']
  const declarations = names.map(name => `const ${findNode('./src/components/DispatchRentalDialog.tsx', node => ts.isVariableDeclaration(node) && node.name.getText() === name)};`).join('\n')
  const context = {
    ...bomExports, selectedBomId: null, baselinePackageSelected: false, pickupType: 'dispatch', customer: { id: 'customer' },
    customerBoms: [{ bomType: 'standard', manned: true, packageProductId: 'package', items: [{ equipmentCategory: 'monitor_area', qty: 4 }] }],
    drillingRig: false, trailerManned: true, billingRateType: 'daily', rateTypeLabel: 'Daily',
    bomPackageRate: 250, trailerOn: true, trailerRate: null, hasRate: value => typeof value === 'number',
    gasMonitors: [{ id: 'monitor', productId: 'monitor-product', productName: 'Monitor', qty: 2, rate: 15 }],
    otherItems: [{ id: 'other', label: 'Manual item', qty: 1, rate: 10 }],
  }
  const evaluate = () => runInNewContext(compile(`${declarations}\nJSON.parse(JSON.stringify({ composition, compositionPriced }))`), { ...context })
  let result = evaluate()
  assert.equal(Object.hasOwn(result.composition, 'bom'), false)
  assert.equal(Object.hasOwn(result.composition, 'bomPackage'), false)
  assert.equal(result.composition.gasMonitors[0].rate, 15)
  assert.equal(result.composition.other[0].label, 'Manual item')
  assert.equal(result.compositionPriced, false)
  context.trailerRate = 100
  assert.equal(evaluate().compositionPriced, true)
  context.baselinePackageSelected = true
  result = evaluate()
  assert.equal(result.composition.bom.length, 1)
  assert.equal(result.composition.bomPackage.rate, 250)
})

test('deselecting a package clears its covered trailer rate', () => {
  const changes = []
  const toggle = runInNewContext(compile(`${findNode('./src/components/DispatchRentalDialog.tsx', fn('toggleBaselinePackage'))}; toggleBaselinePackage`), {
    packageBills: true, trailerRate: 0,
    setBaselinePackageSelected: value => changes.push(['selected', value]),
    setTrailerRate: value => changes.push(['trailerRate', value]),
  })
  toggle(false)
  assert.deepEqual(changes, [['selected', false], ['trailerRate', null]])
})

test('rental callout starts the shared wizard with dispatch and RA context', () => {
  const paths = []
  runInNewContext(compile(`${findNode('./src/pages/DispatchPage.tsx', fn('openRentalCallout'))}; openRentalCallout({ id: 'ra1' })`), { navigate: path => paths.push(path) })
  assert.equal(paths[0], '/tickets/start?dispatch=1&rentalId=ra1')
})
test('division and work selection preserve dispatch mode and linked RA', () => {
  const paths = []
  runInNewContext(compile(`${findNode('./src/pages/wizard/WizardShell.tsx', fn('continueToTicket'))}; continueToTicket()`), {
    division: { qbDivision: 'D3' }, selectedEntry: { workType: 'd3_combined' }, dispatchMode: true,
    searchParams: new URLSearchParams('dispatch=1&rentalId=ra1'), URLSearchParams, navigate: path => paths.push(path),
  })
  const params = new URL(paths[0], 'http://localhost').searchParams
  assert.equal(params.get('dispatch'), '1')
  assert.equal(params.get('rentalId'), 'ra1')
  assert.equal(params.get('type'), 'd3_combined')
  assert.equal(params.get('division'), 'D3')
})
test('rental dispatch preparation inherits customer, location and billing references once', async () => {
  const effect = findNode('./src/pages/TicketWizard.tsx', node => ts.isArrowFunction(node) && node.getText().includes('if (!dispatchMode || !draftRestored || !rentalId || dispatchRentalSeeded.current)') && node.getText().startsWith('() => {'))
  const rental = { id: 'ra1', companyId: 'customer', poNumber: 'PO-123', afeNumber: 'AFE-456' }
  const applied = [], refs = [], errors = []
  const context = { dispatchMode: true, draftRestored: true, draft: null, dispatchRentalSeeded: { current: false },
    searchParams: new URLSearchParams('rentalId=ra1'), api: { get: async () => rental },
    decorateRentalJobs: async rows => rows, applyRentalJobToWizard: async (...args) => applied.push(args),
    setPoNumber: value => { context.po = value }, setBillingRefsSeeded() {}, setBillingRefs: value => refs.push(...value), uuidv4: () => 'ref', setError: value => errors.push(value),
  }
  const run = runInNewContext(compile(`(${effect})`), context)
  run()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(applied[0][0], rental)
  assert.equal(applied[0][1], 'link')
  assert.equal(context.po, 'PO-123')
  assert.deepEqual(refs.map(ref => [ref.type, ref.value]), [['po', 'PO-123'], ['afe', 'AFE-456']])
  run()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(applied.length, 1)
  assert.deepEqual(errors, [])
})
