/**
 * supervisor.ts
 *
 * A tiny in-process supervisor for the setInterval-driven background processors
 * (BlueLion/Vault queue, Enverus queue, auto-approval, QB diff, rental-bill,
 * print queue, printer health). It does two jobs:
 *
 *   1. Graceful shutdown — `stopAll()` clears every registered processor's
 *      timers so SIGTERM/SIGINT (docker stop, a deploy) tears down cleanly
 *      instead of leaving dangling intervals and half-open connections.
 *
 *   2. Watchdog / auto-restart — each processor calls `heartbeat(name)` every
 *      time its interval fires. `startWatchdog()` periodically checks: if an
 *      enabled processor hasn't beaten within its stall window, stop() + start()
 *      it. Restart storms are bounded (MAX_RESTARTS per window → give up + alert)
 *      so a genuinely-broken or freshly-disabled processor can't thrash.
 *
 * Liveness is per-process and in-memory on purpose: it proves *this* instance's
 * timer is still firing. (Process-wide crashes are handled a level up — index.ts
 * exits on uncaughtException and the container's restart policy recovers it.)
 *
 * A processor that never beats (its start() self-skipped because it's not
 * configured/enabled) is never watched — `everBeat` stays false, so disabled
 * processors are silently ignored rather than restart-looped.
 */

const RESTART_WINDOW_MS = 30 * 60 * 1000; // window over which restarts are counted
const MAX_RESTARTS_PER_WINDOW = 3;        // after this many, give up + alert

interface Task {
  name: string;
  start: () => void;
  stop: () => void;
  /** No heartbeat within this many ms (once it has ever beaten) ⇒ restart. */
  stallMs: number;
  lastBeat: number | null;
  everBeat: boolean;
  restarts: number;
  windowStart: number;
  restartsInWindow: number;
  givenUp: boolean;
}

const tasks = new Map<string, Task>();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
const now = () => Date.now();

/**
 * Register a background processor. `stallMs` should sit comfortably above the
 * processor's tick interval (a few multiples) so a slow tick never trips it.
 */
export function registerTask(t: { name: string; start: () => void; stop: () => void; stallMs: number }): void {
  tasks.set(t.name, {
    ...t,
    lastBeat: null,
    everBeat: false,
    restarts: 0,
    windowStart: now(),
    restartsInWindow: 0,
    givenUp: false,
  });
}

/** Called by a processor each time its interval fires — the liveness signal. */
export function heartbeat(name: string): void {
  const task = tasks.get(name);
  if (!task) return;
  task.lastBeat = now();
  task.everBeat = true;
  // A processor that recovered on its own clears an earlier give-up.
  if (task.givenUp) {
    task.givenUp = false;
    task.restartsInWindow = 0;
    console.log(`[supervisor] ${name} is beating again — clearing give-up state`);
  }
}

/** Start every registered processor (records nothing; start() self-gates). */
export function startAll(): void {
  for (const task of tasks.values()) {
    try {
      task.start();
    } catch (err) {
      console.error(`[supervisor] ${task.name} start() threw:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Stop every registered processor — used by graceful shutdown. */
export function stopAll(): void {
  for (const task of tasks.values()) {
    try {
      task.stop();
    } catch (err) {
      console.error(`[supervisor] ${task.name} stop() threw:`, err instanceof Error ? err.message : err);
    }
  }
}

function checkOnce(): void {
  const t = now();
  for (const task of tasks.values()) {
    // Never-started/disabled processors never beat — leave them alone.
    if (!task.everBeat || task.givenUp || task.lastBeat === null) continue;
    if (t - task.lastBeat <= task.stallMs) continue;

    // Stalled. Bound restarts within the rolling window.
    if (t - task.windowStart > RESTART_WINDOW_MS) {
      task.windowStart = t;
      task.restartsInWindow = 0;
    }
    if (task.restartsInWindow >= MAX_RESTARTS_PER_WINDOW) {
      task.givenUp = true;
      console.error(
        `[SUPERVISOR ALERT] ${task.name} stalled (no heartbeat for ${Math.round((t - task.lastBeat) / 1000)}s) and hit ${MAX_RESTARTS_PER_WINDOW} restarts — giving up until it recovers or the process restarts`,
      );
      continue;
    }

    console.warn(
      `[supervisor] ${task.name} stalled (no heartbeat for ${Math.round((t - task.lastBeat) / 1000)}s) — restarting`,
    );
    try {
      task.stop();
      task.start();
      task.restarts++;
      task.restartsInWindow++;
      // Grace: treat the restart as a beat so we don't immediately re-trip
      // before the processor's warmup tick fires.
      task.lastBeat = t;
    } catch (err) {
      console.error(`[supervisor] ${task.name} restart failed:`, err instanceof Error ? err.message : err);
    }
  }
}

export function startWatchdog(checkMs = 120_000): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    try {
      checkOnce();
    } catch (err) {
      console.error('[supervisor] watchdog cycle threw:', err instanceof Error ? err.message : err);
    }
  }, checkMs);
  console.log(`[supervisor] Watchdog started (checking every ${checkMs / 1000}s over ${tasks.size} processors)`);
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/** Test-only: drop all registered tasks and stop the watchdog. */
export function _resetSupervisor(): void {
  stopWatchdog();
  tasks.clear();
}

/**
 * Read-only snapshot for the ops dashboard.
 *
 * `everBeat` is part of the payload because `running: false` alone conflates
 * two completely different situations: a processor that started and then went
 * quiet (a fault) and one whose start() self-skipped because the integration
 * isn't configured (normal, and the reason the watchdog ignores it — see the
 * note at the top of this file). A reader that can't tell them apart shows a
 * permanent row of red for every switched-off integration, which is how a
 * health display stops being read at all.
 */
export function supervisorStatus(): Array<{
  name: string;
  running: boolean;
  /** False ⇒ never started; not a fault, and not watched. */
  everBeat: boolean;
  lastBeatAgoMs: number | null;
  stallMs: number;
  restarts: number;
  givenUp: boolean;
}> {
  const t = now();
  return Array.from(tasks.values()).map((task) => ({
    name: task.name,
    running: task.everBeat && !task.givenUp && task.lastBeat !== null && t - task.lastBeat <= task.stallMs,
    everBeat: task.everBeat,
    lastBeatAgoMs: task.lastBeat === null ? null : t - task.lastBeat,
    stallMs: task.stallMs,
    restarts: task.restarts,
    givenUp: task.givenUp,
  }));
}
