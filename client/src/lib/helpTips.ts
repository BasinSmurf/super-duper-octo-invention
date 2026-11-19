export const HELP_TIPS_DURATION_MS = 90 * 24 * 60 * 60 * 1000

export function helpTipsVisible(startedAt: string | null | undefined, enabled: boolean | null | undefined, now = Date.now()) {
  if (typeof enabled === 'boolean') return enabled
  if (!startedAt) return false
  const start = Date.parse(startedAt)
  return Number.isFinite(start) && now < start + HELP_TIPS_DURATION_MS
}
