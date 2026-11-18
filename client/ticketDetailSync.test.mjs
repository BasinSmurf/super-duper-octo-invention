import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function sourceNode(file, predicate) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found
  function visit(node) { if (predicate(node)) found = node; ts.forEachChild(node, visit) }
  visit(ast)
  assert.ok(found)
  return found.getText(ast)
}
function evaluate(source, context) {
  return runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
}
const loader = sourceNode('./src/pages/TicketDetailPage.tsx', node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadTicket')
class ApiError extends Error { constructor(status, message) { super(message); this.status = status } }
test('a rejected transition shows the server reason and does not queue an invalid retry', async () => {
  const handler = sourceNode('./src/pages/TicketDetailPage.tsx', node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleTransition')
  for (const status of [400, 403, 409]) {
    let ticket = { id: 'synthetic', status: 'supervisor_review' }, error = ''
    const queue = []
    await evaluate(`${handler}; handleTransition('billing_queue')`, {
      id: ticket.id, ticket, navigator: { onLine: true }, ApiError, Error,
      api: { get: async () => ({ groups: [{ id: 'default' }] }),
        post: async () => { throw new ApiError(status, 'Synthetic approval rejection') } },
      db: { tickets: { update: async () => {} }, mutationQueue: { add: async row => queue.push(row) } },
      setTransitioning: () => {}, setTransitionError: value => { error = value }, setTicket: update => { ticket = update(ticket) },
    })
    assert.equal(queue.length, 0)
    assert.equal(ticket.status, 'supervisor_review')
    assert.equal(error, 'Synthetic approval rejection')
  }
})
test('approval preview failures preserve the ticket and never queue or submit approval', async () => {
  const handler = sourceNode('./src/pages/TicketDetailPage.tsx', node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleTransition')
  let error = '', posts = 0, localWrites = 0
  const ticket = { id: 'synthetic', status: 'supervisor_review' }
  await evaluate(`${handler}; handleTransition('billing_queue')`, {
    id: ticket.id, ticket, navigator: { onLine: true }, ApiError, Error,
    api: { get: async () => { throw new ApiError(409, 'Allocation preview changed') }, post: async () => { posts++ } },
    db: { tickets: { update: async () => { localWrites++ } }, mutationQueue: { add: async () => assert.fail('approval cannot be queued offline') } },
    setTransitioning: () => {}, setTransitionError: value => { error = value },
    setTicket: () => assert.fail('failed preview cannot change ticket status'),
  })
  assert.equal(error, 'Allocation preview changed')
  assert.equal(posts, 0)
  assert.equal(localWrites, 0)
  assert.equal(ticket.status, 'supervisor_review')
})

test('multiple billing groups open optional allocation before any approval or local status change', async () => {
  const handler = sourceNode('./src/pages/TicketDetailPage.tsx', node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleTransition')
  const plan = { version: 'preview', groups: [{ id: 'hse' }, { id: 'sampling' }] }
  let opened = null, posts = 0, localWrites = 0
  const ticket = { id: 'synthetic', status: 'supervisor_review' }
  await evaluate(`${handler}; handleTransition('billing_queue')`, {
    id: ticket.id, ticket, navigator: { onLine: true }, ApiError, Error,
    api: { get: async () => plan, post: async () => { posts++ } },
    db: { tickets: { update: async () => { localWrites++ } }, mutationQueue: { add: async () => assert.fail('approval cannot be queued offline') } },
    setApprovalPlan: value => { opened = value }, setTransitioning: () => {}, setTransitionError: () => {},
    setTicket: () => assert.fail('allocation review must happen before changing status'),
  })
  assert.equal(opened, plan)
  assert.equal(posts, 0)
  assert.equal(localWrites, 0)
  assert.equal(ticket.status, 'supervisor_review')
})

test('offline field completion remains queueable while approval requires a server connection', async () => {
  const handler = sourceNode('./src/pages/TicketDetailPage.tsx', node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleTransition')
  for (const target of ['supervisor_review', 'billing_queue']) {
    let ticket = { id: 'synthetic', status: 'in_progress' }, error = ''
    const queue = []
    await evaluate(`${handler}; handleTransition(target)`, {
      target, id: ticket.id, ticket, navigator: { onLine: false }, ApiError, Error,
      db: { tickets: { update: async () => {} }, mutationQueue: { add: async row => queue.push(row) } },
      setTransitioning: () => {}, setTransitionError: value => { error = value }, setTicket: update => { ticket = update(ticket) },
    })
    assert.equal(queue.length, target === 'supervisor_review' ? 1 : 0)
    if (target === 'billing_queue') { assert.equal(ticket.status, 'in_progress'); assert.match(error, /Connect/) }
  }
})
function contextFor(local, get, queued = [{ entityId: 'synthetic', status: 'pending' }]) {
  const state = { ticket: null, error: '', loading: true }
  const empty = { where: () => ({ equals: () => ({ toArray: async () => [] }) }) }
  const context = {
    db: { tickets: { get: async () => local }, companies: { get: async () => null },
      ticketLineItems: empty, ticketAttachments: empty, fitTestRecords: empty, ihTestRecords: empty, trainingRosterRecords: empty,
      mutationQueue: { filter: predicate => ({ count: async () => queued.filter(predicate).length }) } },
    api: { get }, ticketLoadRequest: { current: 0 },
    setTicket: value => { state.ticket = value }, setError: value => { state.error = value }, setLoading: value => { state.loading = value },
  }
  return { state, context, load: evaluate(`${loader}; loadTicket`, context) }
}
test('discarded rejected retries cannot keep a ticket falsely marked Billing and Queued', async () => {
  const { load, state } = contextFor({ id: 'synthetic', status: 'billing_queue', _offlineStatus: 'pending' },
    async () => ({ id: 'synthetic', status: 'supervisor_review' }), [])
  await load('synthetic')
  assert.equal(state.ticket.status, 'supervisor_review')
  assert.equal(state.ticket._offlineStatus, undefined)
})

test('pending local completion is not replaced by the older server draft', async () => {
  let fetched = false
  const { load, state } = contextFor({ id: 'synthetic', status: 'supervisor_review', _offlineStatus: 'pending' }, async () => {
    fetched = true; return { id: 'synthetic', status: 'draft' }
  })
  await load('synthetic')
  assert.equal(state.ticket.status, 'supervisor_review')
  assert.equal(fetched, false)
})

test('finishing synchronization triggers a detail reload without page navigation', () => {
  const effect = sourceNode('./src/pages/TicketDetailPage.tsx', node => ts.isCallExpression(node)
    && node.expression.getText() === 'useEffect' && node.arguments[0]?.getText().includes('loadTicket(id)'))
  let previous, calls = 0
  const context = { id: 'synthetic', syncState: { lastSyncedAt: 'before' }, ticketLoadRequest: { current: 0 }, loadTicket: () => { calls++ },
    useEffect: (callback, dependencies) => {
      if (!previous || dependencies.some((value, i) => value !== previous[i])) callback()
      previous = [...dependencies]
    },
  }
  evaluate(effect, context)
  context.syncState = { lastSyncedAt: 'after' }
  evaluate(effect, context)
  assert.equal(calls, 2)
})

test('a delayed old response cannot overwrite the newer completed ticket', async () => {
  let firstResolve, secondResolve, calls = 0
  const { load, state } = contextFor(null, () => new Promise(resolve => {
    if (++calls === 1) firstResolve = resolve; else secondResolve = resolve
  }))
  const first = load('synthetic')
  await new Promise(resolve => setImmediate(resolve))
  const second = load('synthetic')
  await new Promise(resolve => setImmediate(resolve))
  secondResolve({ id: 'synthetic', status: 'supervisor_review' })
  await second
  firstResolve({ id: 'synthetic', status: 'draft' })
  await first
  assert.equal(state.ticket.status, 'supervisor_review')
})

test('a synced local draft is not labeled unsynced while the assigned list catches up', () => {
  const declaration = sourceNode('./src/pages/MyJobsPage.tsx', node => ts.isVariableDeclaration(node) && node.name.getText() === 'localRows')
  const rows = evaluate(`const ${declaration}; localRows`, { localOnlyDrafts: [
    { id: 'synced', ticketNumber: 'FS-SYN-1', _offlineStatus: 'synced' },
    { id: 'pending', _offlineStatus: 'pending' },
    { id: 'pulled', ticketNumber: 'FS-SYN-2' },
  ] })
  assert.equal(rows[0].pending, false)
  assert.equal(rows[1].pending, true)
  assert.equal(rows[2].pending, false, 'server-pulled rows omit the client-only sync flag')
})
