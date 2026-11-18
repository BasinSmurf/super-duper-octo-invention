import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/pages/RentalReturnPage.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function harness() {
  const slots = [], pending = [], requests = [], mutations = [], updates = [], events = [], priceLevels = []
  let cursor = 0
  const jsx = (type, props) => ({ type, props })
  const react = {
    useState(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }]
    },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useEffect(fn, deps) {
      const i = cursor++
      if (!slots[i] || deps.some((dep, j) => !Object.is(dep, slots[i].deps[j]))) {
        slots[i]?.cleanup?.()
        pending.push(() => { slots[i] = { deps, cleanup: fn() } })
      }
    },
  }
  const exported = {}
  const item = id => ({ id, type: 'Monitor', serial: id, testDate: 'see tag', deployedAt: '2026-08-01' })
  runInNewContext(compiled, {
    exports: exported, Date, Set, URLSearchParams,
    require(name) {
      if (name === 'uuid') return { v4: () => 'ticket-id' }
      if (name === '@/contexts/AuthContext') return { useAuth: () => ({ user: { id: 'tech' } }) }
      if (name === '@/lib/priceLevels') return { useCompanyPriceLevels: () => ({ levels: priceLevels, loaded: true }) }
      if (name === '@/lib/rentalSwapBilling') return { loadSwapBillingLines: async () => [] }
      if (name === '@/lib/manualRentalVisit') return { saveManualRentalVisit: async (_rental, data) => { events.push(data); return { id: data.requestId } } }
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (name === 'react-router-dom') return { useNavigate: () => () => {}, useSearchParams: () => [new URLSearchParams()] }
      if (name === '@/lib/dates') return { todayKey: () => '2026-10-02' }
      if (name === '@/lib/api') return { api: {
        get: async url => url.includes('?') ? { data: [{ id: 'r1', agreementNumber: 'RA1', company: { name: 'Customer' } }], total: 1 } : { id: 'r1', companyId: 'c1', composition: { manualEquipment: [item('i1'), item('i2')] } },

      } }
      if (name === '@/lib/db') return { db: {
        transaction: async (...args) => args.at(-1)(),
        rentalAgreementItems: { update: async (id, data) => updates.push({ id, data }) },
        equipment: { update: async () => {} },
        rentalAgreements: { update: async (id, data) => updates.push({ id, data }) },
        mutationQueue: { add: async data => mutations.push(data) },
      } }
      return new Proxy({}, { get: (_, key) => key })
    },
  })
  function render() { cursor = 0; const tree = exported.RentalReturnPage(); while (pending.length) pending.shift()(); return tree }
  async function settle() { await new Promise(resolve => setImmediate(resolve)); return render() }
  function nodes(tree) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...nodes(tree.props?.children)] }
  const find = (tree, match) => nodes(tree).find(match)
  return { render, settle, find, requests, mutations, updates, events }
}

async function choose(h) {
  let tree = h.render()
  tree = await h.settle()
  const rental = h.find(tree, n => n.props?.['aria-pressed'] === false)
  assert.ok(rental, 'active rentals are offered without choosing a customer first')
  rental.props.onClick()
  h.render()
  await h.settle()
  return h.settle()
}

test('partial return freezes the edited date through billing and the batch inspection', async () => {
  const h = harness()
  let tree = await choose(h)
  h.find(tree, n => n.type === 'input' && n.props.type === 'date').props.onChange({ target: { value: '2026-08-15' } })
  h.find(tree, n => n.type === 'button' && n.props.children?.[1]?.type === 'Package').props.onClick()
  tree = h.render()
  h.find(tree, n => n.type === 'button' && Array.isArray(n.props.children) && n.props.children[0] === 'Return ').props.onClick()
  tree = h.render()
  h.find(tree, n => n.type === 'button' && n.props.children === 'Inspect & Complete Return Ticket').props.onClick()
  tree = h.render()
  // Date is frozen when the return batch begins.
  h.find(tree, n => n.type === 'input' && n.props.type === 'date').props.onChange({ target: { value: '2026-08-20' } })
  tree = h.render()
  if (h.find(tree, n => n.type === 'button' && n.props.children === 'Inspect & Complete Return Ticket')) {
    h.find(tree, n => n.type === 'button' && n.props.children === 'Inspect & Complete Return Ticket').props.onClick()
    tree = h.render()
  }
  await h.find(tree, n => n.type === 'RentalInspectionEditor').props.onComplete({ overallCondition: 'good' })
  assert.equal(h.events[0].serviceDate, '2026-08-15')
  assert.equal(h.events[0].selections.length, 1)
  assert.equal(h.events[0].selections[0].inspection.overallCondition, 'good')
  assert.equal(h.requests.length, 0)
})

test('Finish Job uses the edited date for every item and for rental completion', async () => {
  const h = harness()
  let tree = await choose(h)
  h.find(tree, n => n.type === 'input' && n.props.type === 'date').props.onChange({ target: { value: '2026-08-15' } })
  tree = h.render()
  h.find(tree, n => n.type === 'button' && n.props.children === 'Finish Job (return all)').props.onClick()
  tree = h.render()
  h.find(tree, n => n.type === 'button' && n.props.children === 'Inspect & Complete Return Ticket').props.onClick()
  tree = h.render()
  await h.find(tree, n => n.type === 'RentalInspectionEditor').props.onComplete({ overallCondition: 'good' })
  tree = h.render()
  assert.equal(h.events.length, 0, 'no partial batch is sent before all inspections are captured')
  await h.find(tree, n => n.type === 'RentalInspectionEditor').props.onComplete({ overallCondition: 'needs_repair' })
  tree = h.render()
  assert.equal(h.find(tree, n => n.type === 'RentalInspectionEditor'), undefined)
  assert.equal(h.events.length, 1)
  assert.equal(h.requests.length, 0)
  assert.equal(h.events[0].serviceDate, '2026-08-15')
  assert.equal(h.events[0].selections.length, 2)
  assert.deepEqual(h.events[0].selections.map(row => row.inspection.overallCondition), ['good', 'needs_repair'])
  assert.equal(h.events[0].selections[0].inspection.overallCondition, 'good')
})
