/**
 * jobs.ts
 *
 * `runScheduledJob(name, ttlSec, fn)` — the standard wrapper for setInterval-
 * driven background jobs. Records a `JobRun` row before/after the run, takes
 * a Redis lock so two API instances don't process the same work, and turns
 * exceptions into a recorded error rather than an uncaught process crash.
 *
 * Outcome is one of:
 *   - success: lock acquired, fn returned without throwing
 *   - error:   lock acquired, fn threw (errorMessage captured)
 *   - skipped: lock held elsewhere — fn was not invoked
 *
 * The duration is wall-clock from job-row insert to outcome write; for skipped
 * runs that's basically the lock-check round-trip.
 *
 * Slice A: helpers only — callers come in Slice B.
 */

import { prisma } from '../db.js';
import { withLock } from './jobLocks.js';

// Local Prisma client to avoid circular imports with index.ts (matches the
// pattern used in enverusQueueProcessor / approvalAutoProcessor).

export interface JobRunSummary {
  outcome: 'success' | 'error' | 'skipped';
  durationMs: number;
  errorMessage?: string;
}

/**
 * Run `fn` under a named lock and persist the outcome to job_runs.
 *
 * @param name    Stable job identifier (e.g. 'enverus.poll-status'). Becomes
 *                the lock key + jobName column.
 * @param ttlSec  Lock TTL. Set comfortably longer than expected fn duration —
 *                if fn outruns the TTL, another instance can pick up mid-run.
 * @param fn      The job body. Errors are caught + recorded; do NOT swallow
 *                them inside fn unless you want them invisible in job_runs.
 */
export async function runScheduledJob(
  name: string,
  ttlSec: number,
  fn: () => Promise<void>,
): Promise<JobRunSummary> {
  const startedAt = new Date();
  const start = Date.now();

  // Insert a 'running' row first so concurrent operators can see something
  // is in flight even if fn never returns (process crash, hang, etc.).
  const row = await prisma.jobRun
    .create({
      data: { jobName: name, startedAt, status: 'running' },
    })
    .catch(err => {
      console.warn(`[runScheduledJob] failed to insert job_runs row for ${name}:`, err);
      return null;
    });

  let outcome: JobRunSummary['outcome'] = 'skipped';
  let errorMessage: string | undefined;

  try {
    const lockResult = await withLock(name, ttlSec, async () => {
      try {
        await fn();
        outcome = 'success';
      } catch (err) {
        outcome = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    });
    if (!lockResult.acquired) outcome = 'skipped';
  } catch (err) {
    // Errors from withLock itself (Redis transport, etc.) — record them too.
    outcome = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - start;

  if (row) {
    await prisma.jobRun
      .update({
        where: { id: row.id },
        data: {
          finishedAt: new Date(),
          status: outcome,
          durationMs,
          errorMessage: errorMessage?.slice(0, 2000) ?? null,
        },
      })
      .catch(err => {
        console.warn(`[runScheduledJob] failed to finalize job_runs row for ${name}:`, err);
      });
  }

  if (outcome === 'error') {
    console.warn(`[Job ${name}] errored: ${errorMessage}`);
  }

  return { outcome, durationMs, errorMessage };
}
