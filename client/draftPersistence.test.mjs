import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/hooks/useDraftPersistence.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText

// Control delivery of the live query separately from IndexedDB reads. This
// reproduces the window where the old second read marked an empty draft ready.
function harness(records) {
  const slots = []
  let cursor = 0
  let effects = []
  let query
  let delivered
  const listeners = { document: {}, window: {} }
  const target = kind => ({
    addEventListener(name, fn) { listeners[kind][name] = fn },
    removeEventListener(name) { delete listeners[kind][name] },
  })
  const document = { visibilityState: 'visible', ...target('document') }
  const react = {
    useRef(initial) {
      const i = cursor++
      return slots[i] ??= { current: initial }
    },
    useState(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = initial
      return [slots[i], value => { slots[i] = value }]
    },
    useCallback(fn) { return fn },
    useEffect(fn, deps) {
      const i = cursor++
      if (!slots[i] || deps.some((dep, j) => !Object.is(dep, slots[i][j]))) effects.push(fn)
      slots[i] = deps
    },
  }
  const exports = {}
  runInNewContext(compiled, {
    exports, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, document, window: target('window'),
    require(name) {
      if (name === 'react') return react
      if (name === 'dexie-react-hooks') return {
        useLiveQuery(fn) { query = fn; return delivered },
      }
      if (name === '@/lib/db') return {
        db: { drafts: {
          async get(id) { return records.get(id) },
          async put(entry) { records.set(entry.id, entry) },
          async delete(id) { records.delete(id) },
        } },
      }
      throw new Error(`Unexpected import: ${name}`)
    },
  })
  return {
    render(id) {
      cursor = 0
      effects = []
      const value = exports.useDraftPersistence(id)
      for (const effect of effects) effect()
      return value
    },
    async deliver() { delivered = await query() },
    // The app going to the background, e.g. the camera opening for a photo.
    hide() { document.visibilityState = 'hidden'; listeners.document.visibilitychange() },
  }
}

const saved = {
  id: 'ih-draft', step: 5,
  wizardData: {
    workType: 'ih_testing', customer: { name: 'Test customer' },
    photos: [{ id: 'photo-1', dataUrl: 'data:image/png;base64,cGhvdG8=' }],
    ihTestRecords: [{ notes: 'Completed work before GPS warning' }],
  },
}

test('saved draft cannot become ready before its live-query data arrives', async () => {
  const h = harness(new Map([[saved.id, saved]]))
  assert.equal(h.render(saved.id).isLoaded, false)
  // Allow any independent readiness read to finish, but hold back the query.
  await new Promise(resolve => setImmediate(resolve))
  const waiting = h.render(saved.id)
  assert.equal(waiting.isLoaded, false, 'must not restore empty state or redirect')
  assert.equal(waiting.draft, null)
  await h.deliver()
  const restored = h.render(saved.id)
  assert.equal(restored.isLoaded, true)
  assert.equal(restored.draft, saved, 'restore the saved step, fields and photos together')
})

test('missing draft becomes ready only after the query confirms absence', async () => {
  const h = harness(new Map())
  assert.equal(h.render('new-draft').isLoaded, false)
  await h.deliver()
  const empty = h.render('new-draft')
  assert.equal(empty.isLoaded, true)
  assert.equal(empty.draft, null)
})

test('changing draft id does not expose the previous draft as loaded', async () => {
  const other = { ...saved, id: 'other-draft', step: 2 }
  const h = harness(new Map([[saved.id, saved], [other.id, other]]))
  h.render(saved.id)
  await h.deliver()
  assert.equal(h.render(saved.id).draft, saved)
  const waiting = h.render(other.id)
  assert.equal(waiting.isLoaded, false)
  assert.equal(waiting.draft, null)
  await h.deliver()
  assert.equal(h.render(other.id).draft, other)
})

test('backgrounding the app writes the draft without waiting for the debounce', async () => {
  const records = new Map()
  const h = harness(records)
  const hook = h.render('camera-draft')
  hook.saveDraft({ workType: 'field_service', arrivedAt: '2026-11-11T14:00:00.000Z' }, 4)
  assert.equal(records.has('camera-draft'), false, 'debounce has not fired yet')
  h.hide()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(records.get('camera-draft').step, 4)
  assert.equal(records.get('camera-draft').wizardData.arrivedAt, '2026-11-11T14:00:00.000Z')
})

test('a cleared draft is not resurrected by a late change before leaving', async () => {
  const records = new Map()
  const h = harness(records)
  const hook = h.render('submitted-draft')
  hook.saveDraft({ workType: 'field_service' }, 2)
  await hook.clearDraft()
  hook.saveDraft({ workType: 'field_service' }, 2)
  h.hide()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(records.has('submitted-draft'), false)
})
