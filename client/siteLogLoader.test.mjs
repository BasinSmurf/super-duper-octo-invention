import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const js = ts.transpileModule(readFileSync(new URL('./src/lib/siteLogLoader.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { emptySiteLog, loadSiteLog } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const unavailable = async () => { throw new Error('Offline') }
const tick = () => new Promise(resolve => setImmediate(resolve))
const base = () => ({ localAgreement: async () => undefined, localLogs: async () => [], remoteAgreement: unavailable, remoteLogs: unavailable })
const log = (id, logDate) => ({ id, logDate, entries: [] })

test('a late response from the previous rental cannot replace the current rental log', async () => {
  const oldAgreement = deferred(), oldLogs = deferred(), snapshots = []
  let activeId = 'old'
  const old = loadSiteLog('old', { ...base(), remoteAgreement: () => oldAgreement.promise, remoteLogs: () => oldLogs.promise }, value => snapshots.push(value), () => activeId === 'old')
  await tick()
  assert.equal(snapshots.length, 1)
  activeId = 'new'
  await loadSiteLog('new', { ...base(), remoteAgreement: async () => ({ id: 'new', agreementNumber: 'RA-NEW', company: { name: 'New Customer' } }),
    remoteLogs: async () => ({ data: [log('new-log', '2026-11-16')] }) }, value => snapshots.push(value), () => activeId === 'new')
  oldAgreement.resolve({ id: 'old', agreementNumber: 'RA-OLD', company: { name: 'Old Customer' } })
  oldLogs.resolve({ data: [log('old-log', '2026-11-15')] })
  await old
  assert.equal(snapshots.at(-1).agreementId, 'new')
  assert.equal(snapshots.at(-1).agreementLabel, 'RA-NEW — New Customer')
  assert.equal(snapshots.at(-1).dailyLogs[0].id, 'new-log')
  assert.equal(snapshots.filter(value => value.agreementId === 'old').length, 1)
})
test('unmounting while Dexie is loading prevents state updates and unnecessary API requests', async () => {
  const local = deferred(), snapshots = []
  let active = true, requests = 0
  const run = loadSiteLog('r', { ...base(), localAgreement: () => local.promise,
    remoteAgreement: async () => { requests++; return { id: 'r' } } }, value => snapshots.push(value), () => active)
  active = false; local.resolve({ id: 'r', agreementNumber: 'RA-CACHED' })
  await run
  assert.equal(snapshots.length, 0); assert.equal(requests, 0)
})
test('offline loading preserves independently available cached logs even if the cached agreement fails', async () => {
  const snapshots = []
  await loadSiteLog('r', { ...base(), localAgreement: unavailable, localLogs: async () => [log('early', '2026-11-14'), log('late', '2026-11-16')] }, value => snapshots.push(value), () => true)
  assert.deepEqual(snapshots.at(-1).dailyLogs.map(row => row.id), ['late', 'early'])
  assert.equal(snapshots.at(-1).loading, false)
})
test('a failed remote agreement request does not suppress successful remote daily logs', async () => {
  const snapshots = []
  await loadSiteLog('r', { ...base(), remoteLogs: async () => ({ data: [log('remote', '2026-11-16')] }) }, value => snapshots.push(value), () => true)
  assert.equal(snapshots.at(-1).dailyLogs[0].id, 'remote')
  assert.equal(snapshots.at(-1).loading, false)
})
test('authoritative remote data clears a removed contact and retains deploy-first ticket ordering', async () => {
  const snapshots = []
  const ticket = (id, ticketType, serviceDate) => ({ id, ticketType, serviceDate, ticketNumber: id, serviceSubtype: null, status: 'completed', workDescription: null })
  await loadSiteLog('r', { ...base(), localAgreement: async () => ({ id: 'r', siteContactName: 'Removed contact' }),
    remoteAgreement: async () => ({ id: 'r', linkedServiceTickets: [ticket('field-old', 'field_service', '2026-11-01'), ticket('field-new', 'field_service', '2026-11-16'), ticket('deploy', 'rental', '2026-10-01')] }),
  }, value => snapshots.push(value), () => true)
  assert.equal(snapshots[0].siteContact.name, 'Removed contact')
  assert.equal(snapshots.at(-1).siteContact, null)
  assert.deepEqual(snapshots.at(-1).tickets.map(row => row.id), ['deploy', 'field-new', 'field-old'])
})
test('an absent rental ID does not leave the missing-rental screen behind a spinner', () => {
  assert.equal(emptySiteLog('').loading, false)
})
test('synchronous cache failures do not prevent the online fallback', async () => {
  const snapshots = []
  await loadSiteLog('r', { ...base(), localAgreement: () => { throw new Error('Cache unavailable') },
    remoteAgreement: async () => ({ id: 'r', agreementNumber: 'RA-ONLINE', company: { name: 'Online customer' } }),
  }, value => snapshots.push(value), () => true)
  assert.equal(snapshots.at(-1).agreementLabel, 'RA-ONLINE — Online customer')
  assert.equal(snapshots.at(-1).loading, false)
})
