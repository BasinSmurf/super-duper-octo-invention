import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
const code = compile(readFileSync(new URL('./src/pages/DispatchPage.tsx', import.meta.url), 'utf8'))
const ticket = (overrides = {}) => ({ id: 'ticket-1', ticketNumber: 'FS-1', ticketType: 'field_service', status: 'draft',
  serviceDate: '2026-11-17T00:00:00Z', companyId: 'customer', company: { name: 'Customer' }, ...overrides })

function board({ linked = 'ticket-1', result = {}, user = { id: 'dispatcher', role: 'dispatch' } } = {}) {
  const states = [], effects = [], requests = [], timers = new Map()
  let cursor = 0, pending = [], scrolls = 0, reloads = 0, nextTimer = 0
  let query = new URLSearchParams(linked ? { ticket: linked } : {})
  let currentResult = { loading: false, error: null, data: { data: [ticket()] }, ...result }
  const jsx = (type, props) => ({ type, props })
  const exports = {}
  const context = { exports, URLSearchParams, alert() {},
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) {
      if (name === 'react') return {
        useState(initial) { const slot = cursor++; if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
          return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value }] },
        useRef(initial) { const slot = cursor++; return states[slot] ??= { current: initial } },
        useCallback(callback) { cursor++; return callback },
        useEffect(callback, deps) { const slot = cursor++; const previous = effects[slot]
          if (!previous || deps.some((dep, index) => dep !== previous.deps[index])) pending.push(() => {
            previous?.cleanup?.(); effects[slot] = { deps, cleanup: callback() }
          }) },
      }
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react-router-dom') return { useNavigate: () => () => {}, useSearchParams: () => [query], Link: 'a' }
      if (name === '@/contexts/AuthContext') return { useAuth: () => ({ user }) }
      if (name === '@/hooks/useApiResource') return { useApiResource: (path, scope) => {
        requests.push({ path, scope }); return { ...currentResult, reload: () => reloads++ }
      } }
      if (name === '@/lib/api') return { api: { get: async path => path === '/routes/techs' ? { data: [] } : { routes: [] } } }
      if (name === '@/lib/cn') return { cn: (...values) => values.filter(Boolean).join(' ') }
      if (name === '@/lib/dates') return { formatCalendarDateNumeric: value => value, calendarDateKey: value => value?.slice(0, 10), todayKey: () => '2026-11-17' }
      if (name.startsWith('@/components/')) return new Proxy({}, { get: (_, key) => key })
      if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => key })
      throw new Error(`Unexpected import ${name}`)
    },
  }
  runInNewContext(code, context)
  const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)]
  let tree
  return {
    requests,
    render() { cursor = 0; pending = []; tree = exports.DispatchPage()
      for (const node of flatten(tree)) if (node.props?.ref && typeof node.props.ref === 'object') node.props.ref.current = { scrollIntoView() { scrolls++ } }
      pending.forEach(effect => effect()); return tree },
    nodes: () => flatten(tree),
    text: () => { const text = node => node == null ? '' : typeof node === 'object' ? Array.isArray(node) ? node.map(text).join(' ') : text(node.props?.children) : String(node); return text(tree) },
    result(value) { currentResult = { ...currentResult, ...value } },
    link(value) { query = new URLSearchParams(value ? { ticket: value } : {}) },
    click(label) { flatten(tree).find(node => node.type === 'button' && node.props.children === label).props.onClick() },
    unmount() { effects.forEach(effect => effect?.cleanup?.()) },
    runTimers() { for (const [id, callback] of timers) { timers.delete(id); callback() } },
    get scrolls() { return scrolls }, get reloads() { return reloads }, get timers() { return timers.size },
  }
}

test('a dashboard ticket link opens assignment with its calendar service date after loading', () => {
  const view = board({ result: { loading: true, data: null } })
  view.render()
  assert.equal(view.nodes().some(node => node.props?.['aria-label'] === 'Loading dispatch tickets'), true)
  assert.equal(view.scrolls, 0)
  view.result({ loading: false, data: { data: [ticket()] } })
  view.render(); view.render()
  assert.match(view.text(), /Tech.*Service Date.*Notes/)
  assert.equal(view.nodes().find(node => node.type === 'input' && node.props.type === 'date').props.value, '2026-11-17')
  assert.equal(view.scrolls, 1)
  assert.match(view.nodes().find(node => node.props?.ref).props.className, /ring-blue-200/)
});

test('a deep-linked ticket needing a location never opens the assignment form', () => {
  const view = board({ result: { data: { data: [ticket({ customData: { needsLocation: true } })] } } })
  view.render(); view.render()
  assert.match(view.text(), /Set location/)
  assert.equal(view.nodes().some(node => node.type === 'TechCombobox'), false)
  assert.equal(view.scrolls, 1)
})

test('a missing deep-linked ticket offers its detail route without opening another ticket', () => {
  const view = board({ linked: 'missing/id' })
  view.render(); view.render()
  assert.match(view.text(), /no longer in this queue/)
  assert.equal(view.nodes().find(node => node.type === 'a').props.to, '/tickets/missing%2Fid')
  assert.equal(view.nodes().some(node => node.type === 'TechCombobox'), false)
})

test('closing an assignment form does not reopen it when the queue refreshes', () => {
  const view = board()
  view.render(); view.render()
  const close = view.nodes().find(node => node.type === 'button' && node.props.children?.type === 'X')
  close.props.onClick({ stopPropagation() {} })
  view.result({ data: { data: [ticket()] } })
  view.render(); view.render()
  assert.equal(view.nodes().some(node => node.type === 'TechCombobox'), false)
  assert.equal(view.scrolls, 1)
})

test('a new ticket parameter selects the new ticket without a page reload', () => {
  const view = board({ result: { data: { data: [ticket(), ticket({ id: 'two', serviceDate: '2026-11-18T00:00:00Z' })] } } })
  view.render(); view.render(); view.link('two'); view.render(); view.render()
  assert.equal(view.nodes().find(node => node.type === 'input' && node.props.type === 'date').props.value, '2026-11-18')
  assert.equal(view.scrolls, 2)
})

test('edited assignment values survive refreshes and reset for a different link', () => {
  const view = board()
  view.render()
  view.nodes().find(node => node.type === 'TechCombobox').props.onChange('chosen-tech')
  view.render()
  view.result({ data: { data: [ticket()] } }); view.render()
  assert.equal(view.nodes().find(node => node.type === 'TechCombobox').props.value, 'chosen-tech')
  view.result({ data: { data: [ticket({ id: 'two', assignedTech: { id: 'other-tech' } })] } })
  view.link('two'); view.render()
  assert.equal(view.nodes().find(node => node.type === 'TechCombobox').props.value, 'other-tech')
})

test('queue errors offer Retry instead of reporting an empty queue', () => {
  const view = board({ result: { data: null, error: 'Network unavailable' } })
  view.render()
  assert.match(view.text(), /Could not load dispatch tickets:\s+Network unavailable/)
  assert.doesNotMatch(view.text(), /No draft tickets|no longer in this queue/)
  view.click('Retry')
  assert.equal(view.reloads, 1)
})

test('tab and debounced search changes use distinct account-scoped request keys', () => {
  const view = board({ linked: null })
  view.render()
  assert.equal(view.requests.at(-1).path, '/tickets/dispatch-queue?section=queue')
  assert.equal(view.requests.at(-1).scope, 'dispatcher:dispatch')
  view.click('Dispatched'); view.render()
  assert.equal(view.requests.at(-1).path, '/tickets/dispatch-queue?section=dispatched')
  view.nodes().find(node => node.type === 'input' && node.props.type === 'text').props.onChange({ target: { value: 'A & B' } })
  view.runTimers(); view.render()
  assert.equal(view.requests.at(-1).path, '/tickets/dispatch-queue?section=dispatched&search=A+%26+B')
  view.click('Rentals'); view.render()
  assert.equal(view.requests.at(-1).path, null)
})

test('unmount cancels the pending search debounce', () => {
  const view = board({ linked: null })
  view.render()
  view.nodes().find(node => node.type === 'input' && node.props.type === 'text').props.onChange({ target: { value: 'pending' } })
  assert.equal(view.timers, 1)
  view.unmount()
  assert.equal(view.timers, 0)
})
