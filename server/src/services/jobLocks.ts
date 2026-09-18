/**
 * jobLocks.ts
 *
 * `withLock(key, ttlSec, fn)` — atomic lock for background jobs so two API
 * instances (or two overlapping fires of the same setInterval) don't process
 * the same work twice.
 *
 * Backed by Redis SET NX EX when REDIS_URL is set; falls back to an in-process
 * Set<string> otherwise so dev boxes without Redis still get overlap protection
 * within a single instance.
 *
 * Returns { acquired: true, result } when the body ran, or { acquired: false }
 * when the lock was held by someone else. Errors thrown by `fn` propagate.
 */

import { getRedis } from './redis.js';

type LockResult<T> = { acquired: true; result: T } | { acquired: false };

const localLocks = new Set<string>();

// Atomic release: only delete if we still own the token. Avoids freeing
// someone else's lock if our TTL expired mid-run.
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export async function withLock<T>(
  key: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<LockResult<T>> {
  const redis = getRedis();
  const lockKey = `sundog:lock:${key}`;

  if (redis) {
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let acquired: 'OK' | null = null;
    try {
      acquired = await redis.set(lockKey, token, 'EX', ttlSec, 'NX');
    } catch (err) {
      // Redis unreachable — fall through to local fallback so jobs still run.
      console.warn(
        `[withLock] redis SET failed for ${key} — falling back to in-process lock:`,
        err instanceof Error ? err.message : err,
      );
      return runWithLocalLock(lockKey, fn);
    }

    if (acquired !== 'OK') return { acquired: false };

    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      // Best-effort release. If Redis is down by now, the TTL will eventually
      // free the key.
      await redis
        .eval(RELEASE_LUA, 1, lockKey, token)
        .catch(() => {});
    }
  }

  return runWithLocalLock(lockKey, fn);
}

async function runWithLocalLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<LockResult<T>> {
  if (localLocks.has(lockKey)) return { acquired: false };
  localLocks.add(lockKey);
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    localLocks.delete(lockKey);
  }
}
