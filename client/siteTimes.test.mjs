import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('./src/lib/siteTimes.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { getSiteShiftWindow, restoreSiteTimesManual } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const entries = [{ date: '2026-09-17', time: '18:00' }, { date: '2026-09-18', time: '06:00' }]
const serviceDate = '2026-09-17'
const iso = value => new Date(value).toISOString()

test('overnight log carries separate dates into final-step instants', () => {
  const window = getSiteShiftWindow([...entries].reverse(), serviceDate)
  assert.equal(window.start, '2026-09-17T18:00')
  assert.equal(window.end, '2026-09-18T06:00')
  assert.equal((new Date(window.end) - new Date(window.start)) / 3600000, 12)
})

test('reopened automatically calculated times continue following the log', () => {
  const saved = JSON.parse(JSON.stringify({
    entries: entries.slice(0, 1), serviceDate,
    arrivedAt: iso('2026-09-17T18:00'), departedAt: iso('2026-09-17T18:00'),
  }))
  assert.deepEqual(restoreSiteTimesManual(saved), { arrived: false, departed: false })
  const updated = getSiteShiftWindow([...saved.entries, entries[1]], serviceDate)
  assert.equal(updated.end, '2026-09-18T06:00')
})

test('legacy single-day automatic defaults can recalculate across midnight', () => {
  assert.deepEqual(restoreSiteTimesManual({ entries, serviceDate,
    arrivedAt: iso('2026-09-17T06:00'), departedAt: iso('2026-09-17T18:00'),
  }), { arrived: false, departed: false })
})

test('deliberate arrival/departure edits survive reopening', () => {
  assert.deepEqual(restoreSiteTimesManual({ entries, serviceDate,
    arrivedAt: iso('2026-09-17T17:00'), departedAt: iso('2026-09-18T07:00'),
  }), { arrived: true, departed: true })
  assert.deepEqual(restoreSiteTimesManual({ entries, serviceDate,
    manual: { arrived: true, departed: false },
    arrivedAt: iso('2026-09-17T18:00'), departedAt: iso('2026-09-18T06:00'),
  }), { arrived: true, departed: false })
})

test('draft round trip preserves entry dates and automatic/manual choices', () => {
  const draft = JSON.parse(JSON.stringify({ entries, serviceDate, manual: { arrived: false, departed: true } }))
  assert.equal(getSiteShiftWindow(draft.entries, draft.serviceDate).end, '2026-09-18T06:00')
  assert.deepEqual(restoreSiteTimesManual(draft), draft.manual)
})

test('empty logs, undated entries, and month boundaries remain supported', () => {
  assert.equal(getSiteShiftWindow([], serviceDate), null)
  assert.equal(getSiteShiftWindow([{ time: '08:00' }], serviceDate).start, '2026-09-17T08:00')
  assert.equal(getSiteShiftWindow([{ date: '2026-10-01', time: '01:00' }, { date: '2026-09-30', time: '23:00' }], '2026-09-30').end, '2026-10-01T01:00')
})

test('wizard final-step effect updates automatic departure but preserves manual arrival', () => {
  const wizard = readFileSync(new URL('./src/pages/TicketWizard.tsx', import.meta.url), 'utf8')
  const effect = wizard.match(/useEffect\(\(\) => \{\s*if \(serviceType !== 'on_site_services'\) return([\s\S]*?)\n  \}, \[serviceType, onSiteSubtype, onSiteShiftWindow, siteTimesManual\]\)/)
  assert.ok(effect, 'Find the actual final-step synchronization effect')
  const synchronize = new Function('onSiteSubtype', 'onSiteShiftWindow', 'siteTimesManual', 'setArrivedAt', 'setDepartedAt', effect[1])
  let arrival = iso('2026-09-17T17:00')
  let departure = iso('2026-09-17T18:00')
  synchronize('manned_trailer', getSiteShiftWindow(entries, serviceDate),
    { arrived: true, departed: false }, value => { arrival = value }, value => { departure = value })
  assert.equal(arrival, iso('2026-09-17T17:00'))
  assert.equal(departure, iso('2026-09-18T06:00'))
})
