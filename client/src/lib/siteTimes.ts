export type SiteTimesManual = { arrived: boolean; departed: boolean }

type LogEntryTime = { date?: string; time: string }

export function getSiteShiftWindow(entries: LogEntryTime[], serviceDate: string) {
  const times = entries.filter(e => e.time).map(e => `${e.date || serviceDate}T${e.time}`).sort()
  if (!times.length) return null
  return {
    first: times[0].replace('T', ' '),
    last: times[times.length - 1].replace('T', ' '),
    start: times[0],
    end: times[times.length - 1],
  }
}

// Older tickets did not record whether site times were automatic. Recognize
// both the full-date defaults and the old single-day defaults when reopening.
// Other saved times remain manual so travel time is not silently discarded.
export function restoreSiteTimesManual(input: {
  manual?: SiteTimesManual
  entries?: LogEntryTime[]
  serviceDate: string
  arrivedAt?: string | null
  departedAt?: string | null
  shiftStart?: string
  shiftEnd?: string
}): SiteTimesManual {
  if (input.manual) return { ...input.manual }
  const entries = input.entries || []
  const window = getSiteShiftWindow(entries, input.serviceDate)
  const oldTimes = entries.map(e => e.time).filter(Boolean).sort()
  const isManual = (value: string | null | undefined, defaults: (string | undefined)[]) => {
    if (!value) return false
    const timestamp = new Date(value).getTime()
    return !defaults.some(d => d && new Date(d).getTime() === timestamp)
  }
  return {
    arrived: isManual(input.arrivedAt, [window?.start, input.shiftStart, oldTimes.length ? `${input.serviceDate}T${oldTimes[0]}` : undefined]),
    departed: isManual(input.departedAt, [window?.end, input.shiftEnd, oldTimes.length ? `${input.serviceDate}T${oldTimes[oldTimes.length - 1]}` : undefined]),
  }
}
