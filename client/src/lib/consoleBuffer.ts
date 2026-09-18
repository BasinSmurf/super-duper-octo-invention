/**
 * consoleBuffer.ts — defensive in-memory ring buffer of recent console output.
 *
 * Patches console.log/info/warn/error at import time and keeps the most recent
 * entries (capped by count AND age) so the bug-report feature can attach them.
 * Everything here is wrapped to never throw — a broken logger must never break
 * the app. Import once, early (main.tsx). The original console behavior is
 * preserved; we only tee a copy into the buffer.
 */

export interface ConsoleEntry {
  ts: number
  level: 'log' | 'info' | 'warn' | 'error'
  text: string
}

const MAX_ENTRIES = 200
const MAX_AGE_MS = 5 * 60 * 1000 // 5 minutes

const buffer: ConsoleEntry[] = []

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function record(level: ConsoleEntry['level'], args: unknown[]) {
  try {
    const text = args.map(stringifyArg).join(' ').slice(0, 2000)
    buffer.push({ ts: Date.now(), level, text })
    // Trim by count
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
  } catch {
    // never let logging capture break anything
  }
}

let installed = false

export function installConsoleBuffer() {
  if (installed) return
  installed = true
  ;(['log', 'info', 'warn', 'error'] as const).forEach((level) => {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      record(level, args)
      original(...args)
    }
  })
}

/** Snapshot of recent console entries, pruned to the last MAX_AGE_MS. */
export function getRecentLogs(): ConsoleEntry[] {
  const cutoff = Date.now() - MAX_AGE_MS
  return buffer.filter((e) => e.ts >= cutoff)
}
