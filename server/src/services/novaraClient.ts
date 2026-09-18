/**
 * novaraClient.ts
 *
 * HTTP client for Novara Flex — the external system of record for equipment
 * existence and inspection compliance. One-way: we read, we never write.
 *
 *   - Host:  NOVARA_API_URL (default https://api.novaraflex.com). Public
 *            internet, TLS, no mTLS.
 *   - Auth:  a ~41-character token in the JSON BODY as `token` — not a header,
 *            not a query param. Their docs are explicit that a token grants
 *            full read/write on the account and must never reach client-side
 *            code, so this stays server-side and is never logged.
 *   - Shape: JSON-RPC-ish. POST https://api.novaraflex.com/v1/<method> with
 *            `{ token, ...params }`. EVERY response — including auth failures
 *            and rate limiting — is HTTP 200 with `{ ok: false, error,
 *            description }`. The status code proves nothing; `ok` is the only
 *            signal that matters.
 *   - Rate:  ~80 requests/minute for the WHOLE customer account, shared across
 *            every token they have issued (max five per site). Exceeding it
 *            returns errors for ~60s and, per their docs, sustained abuse is
 *            grounds for deactivation. So this module self-throttles (see
 *            `throttle`) at a deliberately conservative rate — we are not
 *            necessarily the only consumer of that budget, and getting the
 *            account's tokens deactivated would take out whatever else uses it.
 *
 * Native `https` (no axios/fetch) to match enverusClient.ts / blueLionClient.ts.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface NovaraConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  /** Minimum gap between requests. 1000ms => 60/min, under their ~80/min cap. */
  minIntervalMs: number;
  maxRetries: number;
}

export function getConfig(): NovaraConfig {
  return {
    baseUrl: process.env.NOVARA_API_URL || 'https://api.novaraflex.com',
    token: process.env.NOVARA_API_TOKEN || '',
    timeoutMs: parseInt(process.env.NOVARA_TIMEOUT_MS || '20000', 10),
    minIntervalMs: parseInt(process.env.NOVARA_MIN_REQUEST_INTERVAL_MS || '1000', 10),
    maxRetries: parseInt(process.env.NOVARA_MAX_RETRIES || '3', 10),
  };
}

/** No token means the whole integration is off — nothing schedules, nothing probes. */
export function isConfigured(): boolean {
  return !!getConfig().token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type NovaraErrorCategory =
  | 'auth_failure' // invalid_token / no permission — a human must fix the token
  | 'rate_limited' // over ~80/min; back off and retry
  | 'bad_request' // malformed params (e.g. unknown equipmentType_id)
  | 'server_error' // 5xx — retryable
  | 'network_timeout' // ETIMEDOUT / ECONNREFUSED / socket timeout — retryable
  | 'unknown';

export class NovaraApiError extends Error {
  constructor(
    public category: NovaraErrorCategory,
    public novaraError: string | null,
    message: string,
    public statusCode: number | null = null,
  ) {
    super(message);
    this.name = 'NovaraApiError';
  }

  get isRetryable(): boolean {
    return (
      this.category === 'rate_limited' ||
      this.category === 'server_error' ||
      this.category === 'network_timeout'
    );
  }
}

/**
 * Map an `error` string from an ok:false body to a category.
 *
 * Their docs publish the envelope but not an exhaustive error list, so this
 * matches on substrings rather than an allowlist: an unrecognised error lands
 * in `unknown` (surfaced, not retried) rather than being optimistically treated
 * as retryable and hammering an account we share with other consumers.
 */
function classifyNovaraError(error: string): NovaraErrorCategory {
  const e = error.toLowerCase();
  if (e.includes('rate') || e.includes('limit') || e.includes('too_many')) return 'rate_limited';
  if (e.includes('token') || e.includes('permission') || e.includes('auth')) return 'auth_failure';
  if (e.includes('invalid') || e.includes('missing') || e.includes('not_found')) return 'bad_request';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Throttle
// ─────────────────────────────────────────────────────────────────────────────

// Process-local serialization: every call queues behind the previous one and
// waits out minIntervalMs. Deliberately NOT a Redis-backed global limiter —
// the sync runs under a single Redis job lock (jobs.ts), so only one instance
// is ever calling Novara on a tick, and an admin probe is a single request.
let chain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const { minIntervalMs } = getConfig();
  const gate = chain.then(async () => {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  // Keep the chain alive even when `fn` rejects, or one failure stalls every
  // later call forever.
  chain = gate.then(
    () => undefined,
    () => undefined,
  );
  return gate.then(fn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

interface RawResponse {
  statusCode: number;
  body: string;
}

function post(url: URL, payload: string, timeoutMs: number): Promise<RawResponse> {
  const isHttps = url.protocol === 'https:';
  const request = isHttps ? https.request : (http.request as typeof https.request);

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : isHttps ? 443 : 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json',
        },
        timeout: timeoutMs,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Invoke a Novara method. Throws NovaraApiError on anything that is not
 * `{ ok: true }`; retryable categories are retried with exponential backoff.
 *
 * The token is injected here and never appears in a thrown message or a log
 * line — errors carry the method name and Novara's own error code only.
 */
export async function call<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const cfg = getConfig();
  if (!cfg.token) {
    throw new NovaraApiError('auth_failure', null, 'Novara is not configured (NOVARA_API_TOKEN unset)');
  }

  const url = new URL(`/v1/${method}`, cfg.baseUrl);
  const payload = JSON.stringify({ token: cfg.token, ...params });

  let lastErr: NovaraApiError | null = null;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) {
      // 2s, 4s, 8s… A rate-limit block clears after ~60s on their side, so a
      // retry after one is floored well above the ordinary backoff.
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 60_000);
      await sleep(lastErr?.category === 'rate_limited' ? Math.max(backoff, 20_000) : backoff);
    }

    let raw: RawResponse;
    try {
      raw = await throttle(() => post(url, payload, cfg.timeoutMs));
    } catch (err) {
      lastErr = new NovaraApiError(
        'network_timeout',
        null,
        `Novara ${method} transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (raw.statusCode >= 500) {
      lastErr = new NovaraApiError(
        'server_error',
        null,
        `Novara ${method} returned HTTP ${raw.statusCode}`,
        raw.statusCode,
      );
      continue;
    }

    let parsed: { ok?: boolean; error?: string; description?: string };
    try {
      parsed = JSON.parse(raw.body);
    } catch {
      // A non-JSON 200 is normally an edge/WAF interstitial rather than Novara.
      lastErr = new NovaraApiError(
        'unknown',
        null,
        `Novara ${method} returned an unparseable body (HTTP ${raw.statusCode})`,
        raw.statusCode,
      );
      continue;
    }

    if (parsed.ok === true) return parsed as T;

    const errCode = parsed.error || 'unknown_error';
    lastErr = new NovaraApiError(
      classifyNovaraError(errCode),
      errCode,
      `Novara ${method} failed: ${errCode}${parsed.description ? ` — ${parsed.description}` : ''}`,
      raw.statusCode,
    );
    if (!lastErr.isRetryable) throw lastErr;
  }

  throw lastErr ?? new NovaraApiError('unknown', null, `Novara ${method} failed`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed methods
// ─────────────────────────────────────────────────────────────────────────────

/** A schedule as DEFINED on the type (equipmenttypes.list). */
export interface NovaraTypeSchedule {
  id: string;
  name?: string;
  form_id?: number;
  instructions?: string;
  doRequireAttachments?: boolean;
  trigger?: Record<string, unknown>;
}

export interface NovaraEquipmentType {
  id: string;
  title: string;
  created?: number;
  metafields?: { id: string; name: string; type: string; list_id?: number }[];
  schedules?: NovaraTypeSchedule[];
}

/** A schedule's STATE on one unit (equipments.list). Dates are epoch millis. */
export interface NovaraEquipmentSchedule {
  schedule_id: string;
  status?: 'uptodate' | 'expiring' | 'expired';
  expiresOn?: number | null;
  expiringOn?: number | null;
  lastCompletedOn?: number | null;
}

export interface NovaraEquipment {
  id: string;
  serialNumber?: string | null;
  equipmentType_id: string;
  created?: number;
  parent_id?: string | null;
  fieldOffice_id?: string[];
  lineOfBusiness_id?: string | null;
  clients_id?: string[];
  assignedUsers_id?: string[];
  title?: string | null;
  notes?: string | null;
  isInService?: boolean;
  metavalues?: Record<string, unknown>;
  status?: 'uptodate' | 'expiring' | 'expired';
  schedules?: NovaraEquipmentSchedule[];
  projects?: { id: number; name: string }[];
}

export async function listEquipmentTypes(): Promise<NovaraEquipmentType[]> {
  const res = await call<{ equipmenttypes?: NovaraEquipmentType[] }>('equipmenttypes.list');
  return res.equipmenttypes ?? [];
}

/**
 * List every unit of one type.
 *
 * `service_type: 'all'` is not their default — Novara returns ONLY in-service
 * units unless asked. We always ask for both, because a unit dropping
 * out-of-service is exactly the event this sync exists to notice; filtered out,
 * it would silently stop being updated and go on looking current in SP.
 */
export async function listEquipment(
  equipmentTypeId: string,
  opts: { serviceType?: 'in' | 'out' | 'all' } = {},
): Promise<NovaraEquipment[]> {
  const res = await call<{ equipments?: NovaraEquipment[] }>('equipments.list', {
    equipmentType_id: equipmentTypeId,
    service_type: opts.serviceType ?? 'all',
  });
  return res.equipments ?? [];
}

/**
 * Liveness + credential probe for the admin page. `api.ping` still requires a
 * valid token, so a green result proves reachability AND credentials; the
 * type count then confirms the token can actually see equipment data.
 */
export async function testConnection(): Promise<{ ok: true; equipmentTypes: number }> {
  await call('api.ping');
  const types = await listEquipmentTypes();
  return { ok: true, equipmentTypes: types.length };
}
