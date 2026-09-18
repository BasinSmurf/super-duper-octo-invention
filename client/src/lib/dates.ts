/**
 * Calendar dates vs. instants.
 *
 * The schema has two different kinds of date. Rendering one like the other is
 * an off-by-one-day bug, and which direction it goes depends on the field:
 *
 *   CALENDAR DATES (Prisma `@db.Date`) — serviceDate, serviceDateTo, hydro and
 *   expiry dates, period start/end, deployedDate… These are calendar facts:
 *   "the work happened on the 25th", with no time and no zone. The API
 *   serializes them as UTC midnight ("2026-08-25T00:00:00.000Z"), so formatting
 *   one with a local-time method renders the day BEFORE anywhere west of
 *   Greenwich — Aug 25 shows as "Aug 24" in North Dakota. Use the helpers here.
 *
 *   INSTANTS (`DateTime` with a time) — createdAt, arrivedAt, departedAt,
 *   completedAt… These are moments, and they SHOULD render in the viewer's
 *   local zone. Do NOT use these helpers for those; plain toLocale* is right.
 *
 * Service date in particular rides out to Enverus/OpenInvoice, so a day's drift
 * is a wrong invoice, not a cosmetic glitch.
 */

/** Options accepted by the calendar formatters (timeZone is forced to UTC). */
type CalendarFormatOptions = Omit<Intl.DateTimeFormatOptions, 'timeZone'>

const DEFAULT_FORMAT: CalendarFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }

/**
 * Render a calendar date without letting the local zone shift it.
 *
 * Accepts a full ISO string, a bare "YYYY-MM-DD" (what offline drafts hold), or
 * a Date. Returns the placeholder for null/undefined/unparseable input rather
 * than "Invalid Date".
 */
export function formatCalendarDate(
  value: string | Date | null | undefined,
  opts: CalendarFormatOptions = DEFAULT_FORMAT,
  placeholder = '—',
): string {
  const d = toCalendarDate(value)
  if (!d) return placeholder
  return d.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' })
}

/** "Mon, Aug 25, 2026" — the long form used on detail screens. */
export function formatCalendarDateLong(
  value: string | Date | null | undefined,
  placeholder = '—',
): string {
  return formatCalendarDate(
    value,
    { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' },
    placeholder,
  )
}

/** "8/25/2026" — the numeric form used in dense lists and tables. */
export function formatCalendarDateNumeric(
  value: string | Date | null | undefined,
  placeholder = '—',
): string {
  return formatCalendarDate(
    value,
    { year: 'numeric', month: 'numeric', day: 'numeric' },
    placeholder,
  )
}

/**
 * The "YYYY-MM-DD" key for a calendar date — what `<input type="date">` wants,
 * and what the API expects back for an `@db.Date` field.
 */
export function calendarDateKey(value: string | Date | null | undefined): string {
  const d = toCalendarDate(value)
  if (!d) return ''
  return d.toISOString().slice(0, 10)
}

/**
 * The "YYYY-MM-DD" key for the calendar day an instant falls on *in the
 * viewer's zone*. Use this whenever a wall-clock moment has to become a date
 * filter or a date field: `someLocalDate.toISOString().slice(0, 10)` converts
 * to UTC first and lands on the previous day for most of the evening in North
 * America, which silently shifts every date range built that way.
 */
export function localDateKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * TODAY as "YYYY-MM-DD" in the *viewer's* zone — the correct seed for a service
 * date. `new Date().toISOString().slice(0, 10)` is UTC's today, which after
 * ~7pm Central is already tomorrow: an evening ticket would be stamped with the
 * next day's service date and billed on the wrong day.
 */
export function todayKey(): string {
  return localDateKey(new Date())
}

/** "YYYY-MM-DD" for N days before today, in the viewer's zone. */
export function daysAgoKey(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDateKey(d)
}

/**
 * Normalize any calendar-date input to a Date pinned at UTC midnight, or null.
 * A bare "YYYY-MM-DD" already parses as UTC midnight; a full ISO timestamp is
 * truncated to its UTC date so the calendar day survives.
 */
function toCalendarDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  // "2026-08-25" and "2026-08-25T00:00:00.000Z" both land on the same instant.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value)
  return Number.isNaN(d.getTime()) ? null : d
}
