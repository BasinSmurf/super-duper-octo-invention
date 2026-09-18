/**
 * enverusMasterDataCache.ts
 *
 * Simple in-memory TTL cache for Enverus master data (AFEs, cost centers,
 * requisitioners, POs).  Keys are namespaced: `afes:{duns}`, etc.
 *
 * No Redis — master data is small (tens of records per buyer) and only
 * accessed by billing users.  Consistent with QBWC's in-memory session map.
 */

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

const DEFAULT_TTL_MS = parseInt(
  process.env.ENVERUS_MASTER_DATA_TTL_MS || '3600000', // 1 hour
  10,
);

/** Get a cached value.  Returns null if missing or expired. */
export function getCached<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > DEFAULT_TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry.data as T;
}

/** Store a value in the cache with the current timestamp. */
export function setCached<T>(key: string, data: T): void {
  store.set(key, { data, fetchedAt: Date.now() });
}

/** Invalidate all cache keys starting with `prefix`. */
export function invalidate(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Get cache stats for diagnostics. */
export function getStats(): { size: number; keys: string[] } {
  return { size: store.size, keys: Array.from(store.keys()) };
}
