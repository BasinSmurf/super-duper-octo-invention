/**
 * redis.ts
 *
 * Single ioredis client for the API process. Connects on first use; lazy.
 * If `REDIS_URL` is unset, returns null and downstream features (job locks,
 * future pub/sub) silently degrade to in-process fallbacks. This keeps dev
 * boxes without Redis from breaking.
 *
 * Redis IS provisioned in docker-compose (sundog-redis), so production paths
 * should always set REDIS_URL.
 */

import IORedis, { type Redis } from 'ioredis';

let client: Redis | null = null;
let attempted = false;

export function getRedis(): Redis | null {
  if (attempted) return client;
  attempted = true;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[Redis] REDIS_URL not set — Redis-backed features disabled');
    return null;
  }

  try {
    client = new IORedis(url, {
      // Don't keep retrying forever — fail fast so callers fall back.
      maxRetriesPerRequest: 2,
      // We want errors thrown immediately if Redis is down, not silently queued.
      enableOfflineQueue: false,
      // Surface connection errors via the error event, don't crash boot.
      lazyConnect: false,
    });

    client.on('error', err => {
      // Don't spam — ioredis re-emits on every retry. Log once per minute max.
      const key = `redis-err:${err.message}`;
      if (recentErrors.has(key)) return;
      recentErrors.add(key);
      setTimeout(() => recentErrors.delete(key), 60_000);
      console.warn('[Redis] error:', err.message);
    });

    client.on('connect', () => {
      console.log('[Redis] connected');
    });

    return client;
  } catch (err) {
    console.warn('[Redis] failed to init:', err instanceof Error ? err.message : err);
    client = null;
    return null;
  }
}

const recentErrors = new Set<string>();

/** Close the Redis connection cleanly — called by graceful shutdown. */
export async function shutdownRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
    attempted = false;
  }
}
