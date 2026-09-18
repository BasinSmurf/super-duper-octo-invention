/**
 * blueLionClient.ts
 *
 * HTTP client for the BlueLion training-cert recordkeeping system. BlueLion is
 * a deliberately-separate ("bad divorce") system: no shared DB/auth, one-way
 * push from us into them over a single LAN-only HTTPS channel.
 *
 *   - Host:  BLUELION_URL (e.g. https://bluelion.lan:8443). LAN-only — never
 *            routed through Cloudflare. The scheme in the URL picks the
 *            transport: https for a TLS vhost (BLUELION_TLS_INSECURE=1 skips
 *            cert validation for a self-signed one), http for a plaintext
 *            LAN listener behind its own firewall.
 *   - Auth:  Authorization: Bearer <BLUELION_TOKEN>. The token carries the
 *            `ingest` role and can do nothing else.
 *   - Idempotency: every record carries an `externalId`; re-sends are deduped
 *            on BlueLion's side and return status `skipped`.
 *
 * Native `https` (no axios/fetch) to match enverusClient.ts. Endpoints respond
 * 202 Accepted with a per-record results array; callers must read the
 * per-record status, not just the HTTP code.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface BlueLionConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  tlsInsecure: boolean;
}

function getConfig(): BlueLionConfig {
  return {
    baseUrl: process.env.BLUELION_URL || '',
    token: process.env.BLUELION_TOKEN || '',
    timeoutMs: parseInt(process.env.BLUELION_TIMEOUT_MS || '10000', 10),
    tlsInsecure: process.env.BLUELION_TLS_INSECURE === '1',
  };
}

export function isConfigured(): boolean {
  const c = getConfig();
  return !!c.baseUrl && !!c.token;
}

/**
 * Transport for a base URL. BlueLion's vhost is https in some deployments and
 * plain http in others (firewalled LAN, no TLS in the stack) — the scheme in
 * BLUELION_URL decides, since a TLS handshake against a plaintext listener
 * fails as an opaque socket error. `rejectUnauthorized` is https-only.
 */
function transportFor(base: URL, tlsInsecure: boolean): {
  request: typeof https.request;
  port: number;
  tlsOptions: { rejectUnauthorized?: boolean };
} {
  const isHttps = base.protocol === 'https:';
  return {
    request: isHttps ? https.request : (http.request as typeof https.request),
    port: base.port ? parseInt(base.port, 10) : isHttps ? 443 : 80,
    tlsOptions: isHttps ? { rejectUnauthorized: !tlsInsecure } : {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

export type BlueLionErrorCategory =
  | 'auth_failure' // 401/403 — bad/missing token or token lacks `ingest` role
  | 'bad_request' // 400 — malformed batch (the whole POST is rejected)
  | 'not_found' // 404 — wrong path (e.g. hit the Cloudflare vhost by mistake)
  | 'server_error' // 5xx — retryable
  | 'network_timeout' // ETIMEDOUT / ECONNREFUSED / timeout — retryable
  | 'unknown';

export class BlueLionApiError extends Error {
  constructor(
    public category: BlueLionErrorCategory,
    public statusCode: number | null,
    message: string,
    public responseBody?: string,
  ) {
    super(message);
    this.name = 'BlueLionApiError';
  }

  get isRetryable(): boolean {
    return this.category === 'server_error' || this.category === 'network_timeout';
  }
}

function classifyError(statusCode: number): BlueLionErrorCategory {
  if (statusCode === 401 || statusCode === 403) return 'auth_failure';
  if (statusCode === 400) return 'bad_request';
  if (statusCode === 404) return 'not_found';
  if (statusCode >= 500) return 'server_error';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Core request
// ─────────────────────────────────────────────────────────────────────────────

interface BlueLionRequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface BlueLionResponse<T = unknown> {
  statusCode: number;
  body: T;
}

export async function blueLionRequest<T = unknown>(
  options: BlueLionRequestOptions,
): Promise<BlueLionResponse<T>> {
  const config = getConfig();
  if (!config.baseUrl) {
    throw new BlueLionApiError('unknown', null, 'BlueLion not configured (BLUELION_URL missing)');
  }

  const parsedBase = new URL(config.baseUrl);
  const { request, port, tlsOptions } = transportFor(parsedBase, config.tlsInsecure);
  const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise<BlueLionResponse<T>>((resolve, reject) => {
    const req = request(
      {
        hostname: parsedBase.hostname,
        port,
        path: options.path,
        method: options.method,
        ...tlsOptions,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/json',
          ...(bodyStr
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr).toString(),
              }
            : {}),
        },
        timeout: config.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;
          console.log(`[BlueLion] ← ${options.method} ${options.path} → ${status} (${raw.length} bytes)`);

          if (status >= 200 && status < 300) {
            let parsed: T;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw as unknown as T;
            }
            resolve({ statusCode: status, body: parsed });
          } else {
            reject(
              new BlueLionApiError(
                classifyError(status),
                status,
                `BlueLion ${options.method} ${options.path} → ${status}: ${raw.slice(0, 2000)}`,
                raw,
              ),
            );
          }
        });
      },
    );

    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        new BlueLionApiError(
          'network_timeout',
          null,
          `BlueLion network error on ${options.method} ${options.path}: ${err.message}`,
        ),
      );
    });

    req.on('timeout', () => {
      req.destroy();
      reject(
        new BlueLionApiError(
          'network_timeout',
          null,
          `BlueLion timeout after ${config.timeoutMs}ms on ${options.method} ${options.path}`,
        ),
      );
    });

    console.log(`[BlueLion] → ${options.method} ${options.path}`);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Trainings endpoint
// ─────────────────────────────────────────────────────────────────────────────

export interface BlueLionTrainingPerson {
  blueLionId?: string;
  firstName?: string;
  lastName?: string;
  employer?: string;
}

export interface BlueLionTrainingRecord {
  externalId: string;
  person: BlueLionTrainingPerson;
  classCode: string;
  issuedOn: string; // YYYY-MM-DD
  expiresOn?: string; // YYYY-MM-DD
  certNumber?: string;
  notes?: string;
  /**
   * Card-type-specific fields (docs/bluelion/SERVICEPRO-CARD-FLAG.md §4) —
   * BlueLion stores these verbatim on the training and card templates bind to
   * `attributes.<key>`. Stable snake_case keys per classCode; every key we
   * send is a field nobody re-keys at print time. Dates as YYYY-MM-DD.
   */
  attributes?: Record<string, string | number>;
}

export interface BlueLionPersonCandidate {
  id: string;
  full_name: string;
  employer?: string | null;
  last_trained_on?: string | null;
}

export interface BlueLionTrainingResult {
  externalId: string;
  status: 'added' | 'skipped' | 'ambiguous' | 'invalid';
  personId?: string;
  personCreated?: boolean;
  trainingSeq?: number;
  candidates?: BlueLionPersonCandidate[];
  error?: string;
}

export interface BlueLionTrainingsResponse {
  added: number;
  skipped: number;
  failed: number;
  results: BlueLionTrainingResult[];
}

export async function pushTrainings(
  records: BlueLionTrainingRecord[],
): Promise<BlueLionResponse<BlueLionTrainingsResponse>> {
  return blueLionRequest<BlueLionTrainingsResponse>({
    method: 'POST',
    path: '/api/integrations/servicepro/trainings',
    body: { records },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Assets + services endpoints (docs/bluelion/SERVICEPRO-INTEGRATION.md §3.2/§3.3)
// ─────────────────────────────────────────────────────────────────────────────
//
// The Wave-3 "equipment-inspections" endpoint was an SP-side proposal BlueLion
// never built. The real contract (handoff 2026-07-08): register the UNIT once
// via /assets (kind + serial → assetId), then push each inspection/service
// event via /services with that assetId as unitId. Condemn outcomes instead go
// through /documents (docType=condemnation, retire=true) — see below.

/** Governed enum — off-list values are rejected per-record as `invalid`. */
export type BlueLionAssetKind = 'fire_extinguisher' | 'scba' | 'harness' | 'gas_monitor' | 'other';

export interface BlueLionAssetRecord {
  externalId: string;
  kind: BlueLionAssetKind;
  serial: string;
  label?: string;
  purchasedOn?: string; // YYYY-MM-DD
}

export interface BlueLionAssetResult {
  externalId: string;
  // added = new asset; found = kind+serial matched an existing one;
  // skipped = externalId already ingested (original assetId returned)
  status: 'added' | 'found' | 'skipped' | 'invalid';
  assetId?: string;
  assetCreated?: boolean;
  error?: string;
}

export interface BlueLionAssetsResponse {
  added: number;
  foundExisting: number;
  skipped: number;
  failed: number;
  results: BlueLionAssetResult[];
}

export async function pushAssets(
  records: BlueLionAssetRecord[],
): Promise<BlueLionResponse<BlueLionAssetsResponse>> {
  return blueLionRequest<BlueLionAssetsResponse>({
    method: 'POST',
    path: '/api/integrations/servicepro/assets',
    body: { records },
  });
}

/**
 * One QA checkpoint as BlueLion stores it (SERVICEPRO-INTEGRATION.md §3.3).
 *
 * `label` is frozen into the record exactly as sent — BlueLion never resolves a
 * key against a catalog. That is the property that makes the record readable in
 * 2031: a later revision of our criteria set cannot change what a stored record
 * says was checked.
 *
 * `result` is a three-state STRING, not a boolean. `unanswered` is a real
 * outcome — "we did not check this" is different from "we checked it and it
 * failed" — and BlueLion rejects raw booleans rather than guessing which one an
 * absent value meant.
 */
export interface BlueLionServiceChecklistItem {
  key: string;
  label: string;
  required: boolean;
  result: 'pass' | 'fail' | 'unanswered';
}

export interface BlueLionServiceRecord {
  externalId: string;
  /** The BlueLion assetId from /assets — NOT our serial or equipment id. */
  unitId: string;
  servicedOn: string; // YYYY-MM-DD
  serviceType: string; // free text ('recharge', 'inspection', …)
  nextDueOn?: string; // YYYY-MM-DD
  technician?: string;
  notes?: string;
  /**
   * The QA checklist, structured. Omitted entirely on a service that had no QA
   * — BlueLion REJECTS `checklist: []` rather than storing it, so an empty
   * array is not a legal way to say "nothing was checked".
   */
  checklist?: BlueLionServiceChecklistItem[];
  /** Opaque to BlueLion: stored and displayed, never interpreted. */
  checklistVersion?: string;
}

/**
 * BlueLion's published limits for a service record (§3.3). Enforced HERE, before
 * the push, because a Vault record is immutable: a checklist rejected on arrival
 * cannot be added to the record afterwards, and a record that went without one
 * stays thin forever.
 */
export const SERVICE_CHECKLIST_LIMITS = {
  maxCheckpoints: 64,
  keyPattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
  maxKeyLength: 64,
  maxLabelLength: 240,
  maxVersionLength: 128,
} as const;

export interface BlueLionServiceResult {
  externalId: string;
  status: 'added' | 'skipped' | 'invalid';
  assetId?: string;
  eventSeq?: number;
  error?: string;
}

/**
 * `/services` gained per-record `results` on 2026-08-31, matching /trainings and
 * /assets, so a malformed record no longer discards the healthy ones beside it.
 *
 * `results` stays OPTIONAL on purpose. A BlueLion that has not been upgraded
 * still answers with the counts alone, and a caller reading only the counts was
 * explicitly promised it would keep working — so the absence of the array is a
 * legal response, not a parse failure. See the fallback in markServiceRowsSynced.
 */
export interface BlueLionServicesResponse {
  added: number;
  skipped: number;
  failed?: number;
  results?: BlueLionServiceResult[];
}

export async function pushServices(
  records: BlueLionServiceRecord[],
): Promise<BlueLionResponse<BlueLionServicesResponse>> {
  return blueLionRequest<BlueLionServicesResponse>({
    method: 'POST',
    path: '/api/integrations/servicepro/services',
    body: { records },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents endpoint — multipart/form-data, one file per request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BlueLion's document vocabulary — a CLOSED enum, global to the instance
 * (SERVICEPRO-INTEGRATION.md §3.4). Deliberately not a synced catalog the way
 * class types and asset types are: it is six values both sides hard-code
 * against, and an ingest typo must not be able to mint a category nothing knows
 * how to display. An unknown value is rejected with `allowedDocTypes` echoed
 * back, so the vocabulary is discoverable from a 400.
 *
 * A seventh value is a BlueLion-side change — ask, do not invent one.
 */
export type BlueLionDocType =
  | 'ultrasonic_exam'
  | 'condemnation'
  | 'condition_photo'
  | 'flow_test'
  | 'test_paperwork'
  | 'vendor_invoice';

export interface BlueLionDocumentUpload {
  externalId: string;
  docType: BlueLionDocType;
  file: Buffer;
  filename: string;
  contentType: string;
  /** Resolve the asset by BlueLion id (preferred — use the assetId from pushAssets). */
  blueLionId?: string;
  /** …or resolve/create by kind + serial (same rules as /assets). */
  kind?: string;
  serial?: string;
  title?: string;
  issuedOn?: string;
  retire?: boolean;
  reason?: string;
}

export interface BlueLionDocumentResult {
  status: 'added' | 'skipped' | 'invalid';
  externalId: string;
  assetId?: string;
  docId?: string;
  retired?: boolean;
  error?: string;
  /** Echoed on an unknown docType — surfaced in the queue row so the fix is legible. */
  allowedDocTypes?: string[];
}

function buildMultipartBody(
  fields: Record<string, string | undefined>,
  file: { fieldName: string; filename: string; contentType: string; buffer: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----BlueLion${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf-8',
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      'utf-8',
    ),
  );
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'));

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function uploadDocument(
  upload: BlueLionDocumentUpload,
): Promise<BlueLionResponse<BlueLionDocumentResult>> {
  const config = getConfig();
  if (!config.baseUrl) {
    throw new BlueLionApiError('unknown', null, 'BlueLion not configured (BLUELION_URL missing)');
  }

  const { body, contentType } = buildMultipartBody(
    {
      externalId: upload.externalId,
      docType: upload.docType,
      blueLionId: upload.blueLionId,
      kind: upload.kind,
      serial: upload.serial,
      title: upload.title,
      issuedOn: upload.issuedOn,
      retire: upload.retire ? 'true' : undefined,
      reason: upload.reason,
    },
    { fieldName: 'file', filename: upload.filename, contentType: upload.contentType, buffer: upload.file },
  );

  const parsedBase = new URL(config.baseUrl);
  const { request, port, tlsOptions } = transportFor(parsedBase, config.tlsInsecure);

  return new Promise<BlueLionResponse<BlueLionDocumentResult>>((resolve, reject) => {
    const req = request(
      {
        hostname: parsedBase.hostname,
        port,
        path: '/api/integrations/servicepro/documents',
        method: 'POST',
        ...tlsOptions,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/json',
          'Content-Type': contentType,
          'Content-Length': body.length.toString(),
        },
        timeout: config.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;
          console.log(`[BlueLion] ← POST /api/integrations/servicepro/documents → ${status} (${raw.length} bytes)`);

          if (status >= 200 && status < 300) {
            let parsed: BlueLionDocumentResult;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw as unknown as BlueLionDocumentResult;
            }
            resolve({ statusCode: status, body: parsed });
          } else {
            reject(
              new BlueLionApiError(
                classifyError(status),
                status,
                `BlueLion POST /api/integrations/servicepro/documents → ${status}: ${raw.slice(0, 2000)}`,
                raw,
              ),
            );
          }
        });
      },
    );

    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        new BlueLionApiError(
          'network_timeout',
          null,
          `BlueLion network error on POST /api/integrations/servicepro/documents: ${err.message}`,
        ),
      );
    });

    req.on('timeout', () => {
      req.destroy();
      reject(
        new BlueLionApiError(
          'network_timeout',
          null,
          `BlueLion timeout after ${config.timeoutMs}ms on POST /api/integrations/servicepro/documents`,
        ),
      );
    });

    console.log('[BlueLion] → POST /api/integrations/servicepro/documents');
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cert-type catalog (the valid classCodes)
// ─────────────────────────────────────────────────────────────────────────────

export interface BlueLionCertType {
  code: string;
  name: string;
  expiry_months: number | null;
  issuing_authority: string | null;
}

export async function fetchCertTypes(): Promise<BlueLionResponse<BlueLionCertType[]>> {
  return blueLionRequest<BlueLionCertType[]>({
    method: 'GET',
    path: '/api/cert-types',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection test
// ─────────────────────────────────────────────────────────────────────────────

export async function testConnection(): Promise<{
  ok: boolean;
  message: string;
  baseUrl: string;
  tokenConfigured: boolean;
  certTypeCount?: number;
  latencyMs?: number;
}> {
  const config = getConfig();
  const start = Date.now();
  if (!isConfigured()) {
    return {
      ok: false,
      message: 'BlueLion not configured — set BLUELION_URL and BLUELION_TOKEN',
      baseUrl: config.baseUrl,
      tokenConfigured: !!config.token,
    };
  }
  try {
    const res = await fetchCertTypes();
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      message: `Connected — ${latencyMs}ms`,
      baseUrl: config.baseUrl,
      tokenConfigured: true,
      certTypeCount: Array.isArray(res.body) ? res.body.length : undefined,
      latencyMs,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    let hint = '';
    if (err instanceof BlueLionApiError) {
      if (err.category === 'auth_failure') hint = ' — check BLUELION_TOKEN (needs ingest role)';
      if (err.category === 'not_found') hint = ' — check BLUELION_URL (LAN vhost, not Cloudflare)';
      if (err.category === 'network_timeout') hint = ' — host unreachable on the LAN';
    }
    return {
      ok: false,
      message: (err instanceof Error ? err.message : String(err)) + hint,
      baseUrl: config.baseUrl,
      tokenConfigured: !!config.token,
      latencyMs,
    };
  }
}
