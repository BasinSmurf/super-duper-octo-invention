import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerTask,
  heartbeat,
  startAll,
  stopAll,
  startWatchdog,
  stopWatchdog,
  supervisorStatus,
  _resetSupervisor,
} from '../supervisor.js';

/**
 * The watchdog restarts live background jobs in production, so the cases that
 * matter most here are the ones where it must NOT act: a processor that is
 * disabled (never beats) and a processor that is merely slow.
 */

const CHECK_MS = 1_000;
const STALL_MS = 10_000;

function makeTask(name: string, stallMs = STALL_MS) {
  const calls = { start: 0, stop: 0 };
  registerTask({
    name,
    start: () => { calls.start++; },
    stop: () => { calls.stop++; },
    stallMs,
  });
  return calls;
}

describe('supervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSupervisor();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _resetSupervisor();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts and stops every registered task', () => {
    const a = makeTask('a');
    const b = makeTask('b');

    startAll();
    expect(a.start).toBe(1);
    expect(b.start).toBe(1);

    stopAll();
    expect(a.stop).toBe(1);
    expect(b.stop).toBe(1);
  });

  // A processor whose start() self-skipped (integration not configured) never
  // beats. Restart-looping it would be pure noise.
  it('never restarts a task that has never beaten', () => {
    const t = makeTask('unconfigured');
    startAll();
    startWatchdog(CHECK_MS);

    vi.advanceTimersByTime(STALL_MS * 20);

    expect(t.start).toBe(1); // the initial startAll() only
    expect(t.stop).toBe(0);
    expect(supervisorStatus()[0]).toMatchObject({ running: false, lastBeatAgoMs: null });
  });

  it('leaves a task alone while it keeps beating', () => {
    const t = makeTask('healthy');
    startAll();
    startWatchdog(CHECK_MS);

    // Beat comfortably inside the stall window, repeatedly.
    for (let i = 0; i < 30; i++) {
      heartbeat('healthy');
      vi.advanceTimersByTime(STALL_MS / 2);
    }

    expect(t.start).toBe(1);
    expect(t.stop).toBe(0);
    expect(supervisorStatus()[0]).toMatchObject({ running: true, restarts: 0 });
  });

  it('restarts a task that beat once and then stalled', () => {
    const t = makeTask('stalled');
    startAll();
    startWatchdog(CHECK_MS);

    heartbeat('stalled');
    vi.advanceTimersByTime(STALL_MS + CHECK_MS * 2);

    expect(t.stop).toBe(1);
    expect(t.start).toBe(2); // initial + one restart
    expect(supervisorStatus()[0]?.restarts).toBe(1);
  });

  it('bounds restarts per window, then gives up instead of thrashing', () => {
    const t = makeTask('broken');
    startAll();
    startWatchdog(CHECK_MS);

    heartbeat('broken');
    // Each restart is treated as a beat, so it re-trips one stall window later.
    // Run well past the 3-restart cap to prove it stops rather than looping.
    vi.advanceTimersByTime((STALL_MS + CHECK_MS) * 12);

    const status = supervisorStatus()[0];
    expect(status?.restarts).toBe(3);
    expect(status?.givenUp).toBe(true);
    expect(t.start).toBe(4); // initial + 3 bounded restarts
  });

  it('clears give-up state once the task beats again', () => {
    makeTask('recovering');
    startAll();
    startWatchdog(CHECK_MS);

    heartbeat('recovering');
    vi.advanceTimersByTime((STALL_MS + CHECK_MS) * 12);
    expect(supervisorStatus()[0]?.givenUp).toBe(true);

    heartbeat('recovering');
    expect(supervisorStatus()[0]).toMatchObject({ givenUp: false, running: true });
  });

  it('stops watching once the watchdog is stopped', () => {
    const t = makeTask('after-stop');
    startAll();
    startWatchdog(CHECK_MS);
    heartbeat('after-stop');

    stopWatchdog();
    vi.advanceTimersByTime(STALL_MS * 20);

    expect(t.stop).toBe(0);
    expect(t.start).toBe(1);
  });

  it('ignores heartbeats for unregistered names', () => {
    expect(() => heartbeat('nobody')).not.toThrow();
    expect(supervisorStatus()).toEqual([]);
  });

  // startAll() must not abort partway through if one processor throws on boot.
  it('keeps starting the remaining tasks when one start() throws', () => {
    registerTask({ name: 'throws', start: () => { throw new Error('boom'); }, stop: () => {}, stallMs: STALL_MS });
    const ok = makeTask('ok');

    expect(() => startAll()).not.toThrow();
    expect(ok.start).toBe(1);
  });

  /**
   * The snapshot is what the Background Jobs widget reads, and `running: false`
   * alone cannot be rendered honestly: it covers both a processor that stopped
   * beating (a fault) and one that never started because its integration is
   * unconfigured (normal, and deliberately unwatched). Anything drawing this
   * needs everBeat to tell those apart, or every switched-off integration shows
   * as broken forever.
   */
  describe('supervisorStatus everBeat — "off" is not "broken"', () => {
    it('reports everBeat false for a processor that never beat', () => {
      makeTask('disabled');
      startAll();
      vi.advanceTimersByTime(STALL_MS * 5);

      expect(supervisorStatus()[0]).toMatchObject({
        name: 'disabled', everBeat: false, running: false, lastBeatAgoMs: null, givenUp: false,
      });
    });

    it('reports everBeat true once a processor has beaten', () => {
      makeTask('live');
      startAll();
      heartbeat('live');

      expect(supervisorStatus()[0]).toMatchObject({ everBeat: true, running: true });
    });

    it('keeps everBeat true after a live processor goes quiet', () => {
      // This is the case that must read as a FAULT rather than as "off": it
      // beat once, so the integration is configured and the silence is real.
      makeTask('went-quiet');
      startAll();
      heartbeat('went-quiet');
      vi.advanceTimersByTime(STALL_MS * 2);

      expect(supervisorStatus()[0]).toMatchObject({ everBeat: true, running: false });
    });

    it('separates a never-started processor from a stalled one in one snapshot', () => {
      makeTask('never');
      makeTask('stalled');
      startAll();
      heartbeat('stalled');
      vi.advanceTimersByTime(STALL_MS * 2);

      const byName = Object.fromEntries(supervisorStatus().map(p => [p.name, p]));
      // Both are `running: false`; only everBeat distinguishes them.
      expect(byName.never).toMatchObject({ running: false, everBeat: false });
      expect(byName.stalled).toMatchObject({ running: false, everBeat: true });
    });
  });
});
