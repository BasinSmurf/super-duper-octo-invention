/**
 * v1/apiKeyStore.ts — API-key store for the v1 surface.
 *
 * Mirrors BlueLion's token model (sha256-hashed, plaintext shown once at
 * issue). Two backing stores, checked in order:
 *
 *   1. DB `ApiKey` rows — issued/revoked from the /admin/api-keys UI. This is
 *      the primary store; it's how BlueLion's card-flag token gets minted.
 *   2. env `V1_API_KEYS` — the original config-backed store, kept so existing
 *      prod keys keep working with no re-issue. JSON array of records:
 *      [{ "id":"k1", "label":"acme-readonly", "keyHash":"<sha256hex>",
 *         "scopes":["tickets:read"], "allowedIps":["203.0.113.5"], "revoked":false }]
 *
 * Issue a key from the UI (/admin/api-keys) or the CLI (`npm run v1:key`).
 */
import crypto from 'crypto';
import { prisma } from '../db.js';

export interface ApiKeyRecord {
  id: string;
  label?: string;
  keyHash: string;        // sha256 hex of the plaintext key
  scopes: string[];       // e.g. ['tickets:read'] or ['*'] for all read scopes
  allowedIps?: string[];  // optional exact-IP allowlist; empty/absent = any
  revoked?: boolean;
}

/**
 * The valid v1 scopes — what the issue UI offers and validates against.
 * `bluelion:write` is the scope the BlueLion card.issued receiver requires.
 */
export const V1_SCOPES = [
  'tickets:read',
  'invoices:read',
  'equipment:read',
  'inspections:read',
  'rentals:read',
  'locations:read',
  'companies:read',
  'trainings:read',
  'bluelion:read',
  'bluelion:write',
  '*',
] as const;

let cache: ApiKeyRecord[] | null = null;

export function loadApiKeys(): ApiKeyRecord[] {
  if (cache) return cache;
  const raw = process.env.V1_API_KEYS;
  if (!raw) {
    cache = [];
    return cache;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    cache = Array.isArray(parsed) ? (parsed as ApiKeyRecord[]) : [];
    if (!Array.isArray(parsed)) console.error('[v1] V1_API_KEYS must be a JSON array — ignoring.');
  } catch {
    console.error('[v1] V1_API_KEYS is not valid JSON — no API keys loaded.');
    cache = [];
  }
  return cache;
}

export function hashKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

const toStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

// lastUsedAt is informational — stamp at most once a minute per key so hot
// callers don't turn every request into a write.
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedStamped = new Map<string, number>();
function stampLastUsed(id: string): void {
  const now = Date.now();
  if ((lastUsedStamped.get(id) ?? 0) > now - LAST_USED_THROTTLE_MS) return;
  lastUsedStamped.set(id, now);
  void prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => {});
}

/** Look up a plaintext key against the DB store, then the env store. */
export async function verifyApiKey(plaintext: string): Promise<ApiKeyRecord | null> {
  const hash = hashKey(plaintext);

  const dbKey = await prisma.apiKey
    .findUnique({ where: { keyHash: hash } })
    .catch(() => null); // table may not exist yet mid-migration — fall through to env
  if (dbKey) {
    if (dbKey.revoked) return null;
    stampLastUsed(dbKey.id);
    return {
      id: dbKey.id,
      label: dbKey.label,
      keyHash: dbKey.keyHash,
      scopes: toStringArray(dbKey.scopes),
      allowedIps: dbKey.allowedIps ? toStringArray(dbKey.allowedIps) : undefined,
      revoked: dbKey.revoked,
    };
  }

  // env store — constant-time compare, matching the original behavior
  const target = Buffer.from(hash);
  for (const k of loadApiKeys()) {
    if (k.revoked) continue;
    const candidate = Buffer.from(k.keyHash);
    if (candidate.length === target.length && crypto.timingSafeEqual(candidate, target)) {
      return k;
    }
  }
  return null;
}

export interface IssuedKey {
  plaintext: string; // shown once, never stored
  id: string;
  label: string;
  prefixHint: string;
  scopes: string[];
}

/** Mint a new DB-backed key. The caller must surface `plaintext` exactly once. */
export async function issueApiKey(args: {
  label: string;
  scopes: string[];
  allowedIps?: string[];
  createdById?: string;
}): Promise<IssuedKey> {
  const plaintext = `sp_${crypto.randomBytes(24).toString('base64url')}`;
  const prefixHint = plaintext.slice(0, 8);
  const row = await prisma.apiKey.create({
    data: {
      label: args.label,
      keyHash: hashKey(plaintext),
      prefixHint,
      scopes: args.scopes,
      allowedIps: args.allowedIps && args.allowedIps.length ? args.allowedIps : undefined,
      createdById: args.createdById,
    },
  });
  return { plaintext, id: row.id, label: row.label, prefixHint, scopes: args.scopes };
}
