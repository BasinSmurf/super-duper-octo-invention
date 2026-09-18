/**
 * enverusClient.ts
 *
 * Core HTTP client for Enverus OpenInvoice API.  Uses Node's native `https`
 * module with a PFX client certificate for mutual TLS (mTLS) authentication
 * and HMAC-SHA256 `mac` header for request signing.
 *
 * Key facts about the Enverus API:
 *   - Hostname: api.openinvoice.com (production), onboard-api.openinvoice.com (sandbox; source-code default)
 *   - All paths are prefixed with /docp  (e.g. /docp/supply-chain/v2/afes)
 *   - Auth: mTLS cert (PFX) + HMAC `mac` header on every request
 *     - GET:  mac = HMAC-SHA256(secret, '')           (empty string)
 *     - POST: mac = HMAC-SHA256(secret, requestBody)
 *
 * No external HTTP library — the codebase has no axios/got/node-fetch, and
 * mTLS needs the `agent` option on `https.request` which native fetch
 * doesn't support cleanly.
 */

import https from 'https';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface EnverusConfig {
  baseUrl: string;
  pfxPath: string;
  pfxPassphrase: string;
  certPath: string;      // public cert PEM (CA chain if needed)
  supplierDuns: string;
  hmacSecret: string;    // HMAC-SHA256 secret for `mac` header
  timeoutMs: number;
}

function getConfig(): EnverusConfig {
  return {
    baseUrl: process.env.ENVERUS_BASE_URL || 'https://onboard-api.openinvoice.com',
    pfxPath: process.env.ENVERUS_PFX_PATH || './certs/enverus/envkeys.pfx',
    pfxPassphrase: process.env.ENVERUS_PFX_PASSPHRASE || '',
    certPath: process.env.ENVERUS_CERT_PATH || './certs/enverus/BasinSafety_Public.pem',
    supplierDuns: process.env.ENVERUS_SUPPLIER_DUNS || '',
    hmacSecret: process.env.ENVERUS_HMAC_SECRET || '',
    timeoutMs: parseInt(process.env.ENVERUS_TIMEOUT_MS || '30000', 10),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC-SHA256 Token Generation
// Per OpenInvoice API Guide:
//   GET requests  → sign empty string
//   POST requests → sign the JSON request body
// ─────────────────────────────────────────────────────────────────────────────

function generateMacToken(input: string | Buffer = ''): string {
  const config = getConfig();
  if (!config.hmacSecret) return '';
  const hmac = crypto.createHmac('sha256', config.hmacSecret);
  if (Buffer.isBuffer(input)) {
    hmac.update(input);
  } else {
    hmac.update(input, 'utf-8');
  }
  return hmac.digest('base64');
}

export function getSupplierDuns(): string {
  return getConfig().supplierDuns;
}

// ─────────────────────────────────────────────────────────────────────────────
// TLS Agent (lazy singleton — loaded once, reused for connection pooling)
// ─────────────────────────────────────────────────────────────────────────────

let _agent: https.Agent | null = null;

function getAgent(): https.Agent {
  if (_agent) return _agent;
  const config = getConfig();

  const agentOpts: https.AgentOptions = {
    keepAlive: true,
    // PFX bundle (cert + private key)
    pfx: readFileSync(config.pfxPath),
    passphrase: config.pfxPassphrase,
  };

  // If a separate public cert PEM is provided, include it as the CA chain
  // (some Enverus endpoints may need this for intermediate cert validation)
  try {
    if (config.certPath) {
      agentOpts.cert = readFileSync(config.certPath);
    }
  } catch {
    // cert file optional — PFX should be sufficient
  }

  _agent = new https.Agent(agentOpts);
  console.log(`[Enverus] TLS agent initialized (pfx: ${config.pfxPath})`);
  return _agent;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Classification
// ─────────────────────────────────────────────────────────────────────────────

export type EnverusErrorCategory =
  | 'auth_failure'       // 401/403 — cert rejected or IP not whitelisted
  | 'validation_error'   // 400 — bad payload, missing required fields
  | 'not_found'          // 404
  | 'rate_limit'         // 429
  | 'server_error'       // 500/502/503 — transient, retryable
  | 'network_timeout'    // ETIMEDOUT / ECONNREFUSED / timeout
  | 'unknown';

export class EnverusApiError extends Error {
  constructor(
    public category: EnverusErrorCategory,
    public statusCode: number | null,
    message: string,
    public responseBody?: string,
  ) {
    super(message);
    this.name = 'EnverusApiError';
  }

  get isRetryable(): boolean {
    return (
      this.category === 'server_error' ||
      this.category === 'network_timeout' ||
      this.category === 'rate_limit'
    );
  }
}

function classifyError(statusCode: number): EnverusErrorCategory {
  if (statusCode === 401 || statusCode === 403) return 'auth_failure';
  if (statusCode === 400) return 'validation_error';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 429) return 'rate_limit';
  if (statusCode >= 500) return 'server_error';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Request
// ─────────────────────────────────────────────────────────────────────────────

interface EnverusRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  queryParams?: Record<string, string>;
  contentType?: string;
}

export interface EnverusResponse<T = unknown> {
  statusCode: number;
  body: T;
  headers: Record<string, string>;
}

export async function enverusRequest<T = unknown>(
  options: EnverusRequestOptions,
): Promise<EnverusResponse<T>> {
  const config = getConfig();

  // All Enverus API paths get /docp prefix
  const fullPath = `/docp${options.path}`;

  // Build query string manually to preserve OData conventions:
  //   - $ in param names ($filter, $select, $top) must stay literal
  //   - Single quotes in $filter values must stay literal (OData string literals)
  //   - Spaces in $filter must be encoded as %20
  // URLSearchParams doesn't work: encodes $ → %24, breaks OData.
  let pathWithQuery = fullPath;
  if (options.queryParams && Object.keys(options.queryParams).length > 0) {
    const qs = Object.entries(options.queryParams)
      .map(([k, v]) => {
        // For OData params ($filter, $orderby, etc.), encode only spaces & unsafe
        // chars but preserve single quotes which are OData string delimiters
        if (k.startsWith('$')) {
          const encoded = v
            .replace(/%/g, '%25')
            .replace(/ /g, '%20')
            .replace(/#/g, '%23')
            .replace(/&/g, '%26')
            .replace(/\+/g, '%2B');
          return `${k}=${encoded}`;
        }
        return `${k}=${encodeURIComponent(v)}`;
      })
      .join('&');
    pathWithQuery += '?' + qs;
  }

  const parsedBase = new URL(config.baseUrl);
  const agent = getAgent();
  const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
  const contentType = options.contentType || 'application/json';

  // HMAC mac header: GET → sign empty string, POST → sign body
  const macToken = generateMacToken(bodyStr || '');

  console.log(`[Enverus] → ${options.method} ${pathWithQuery}`);

  return new Promise<EnverusResponse<T>>((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsedBase.hostname,
        port: parsedBase.port ? parseInt(parsedBase.port, 10) : 443,
        path: pathWithQuery,
        method: options.method,
        agent,
        headers: {
          'Content-Type': contentType,
          Accept: 'application/json',
          ...(macToken ? { mac: macToken } : {}),
          ...(bodyStr
            ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() }
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

          console.log(
            `[Enverus] ← ${options.method} ${options.path} → ${status} (${raw.length} bytes)`,
          );

          if (status >= 200 && status < 300) {
            let parsed: T;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw as unknown as T;
            }
            resolve({
              statusCode: status,
              body: parsed,
              headers: (res.headers || {}) as Record<string, string>,
            });
          } else {
            reject(
              new EnverusApiError(
                classifyError(status),
                status,
                `Enverus API ${options.method} ${options.path} → ${status}: ${raw.slice(0, 2000)}`,
                raw,
              ),
            );
          }
        });
      },
    );

    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        new EnverusApiError(
          'network_timeout',
          null,
          `Enverus network error on ${options.method} ${options.path}: ${err.message}`,
        ),
      );
    });

    req.on('timeout', () => {
      req.destroy();
      reject(
        new EnverusApiError(
          'network_timeout',
          null,
          `Enverus timeout after ${config.timeoutMs}ms on ${options.method} ${options.path}`,
        ),
      );
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Master Data APIs
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAfes(buyerDuns: string, top = 500) {
  return enverusRequest<{ value?: unknown[] }>({
    method: 'GET',
    path: '/supply-chain/v2/afes',
    queryParams: {
      $filter: `buyerDUNS eq '${buyerDuns}' and status eq 'Active'`,
      $select: '*',
      $top: String(top),
    },
  });
}

export async function fetchCostCenters(buyerDuns: string, top = 500) {
  return enverusRequest<{ value?: unknown[] }>({
    method: 'GET',
    path: '/supply-chain/v2/cost-centers',
    queryParams: {
      $filter: `buyerDUNS eq '${buyerDuns}'`,
      $select: '*',
      $top: String(top),
    },
  });
}

export async function fetchRequisitioners(buyerDuns: string) {
  return enverusRequest<{ value?: unknown[] }>({
    method: 'GET',
    path: '/supply-chain/v1/receipt.ordered-by-names',
    queryParams: {
      $filter: `buyerDUNS eq '${buyerDuns}'`,
      $top: '500',
    },
  });
}

export async function fetchPurchaseOrders(buyerDuns: string, top = 500) {
  return enverusRequest<{ value?: unknown[] }>({
    method: 'GET',
    path: '/supply-chain/v1/purchase-orders',
    queryParams: {
      $filter: `buyerParty/partyDUNS eq '${buyerDuns}' and purchaseOrderStatus eq 'Accepted'`,
      $top: String(top),
    },
  });
}

export async function fetchBuyerFieldRules(buyerDuns: string, ticketType = 'general') {
  return enverusRequest({
    method: 'GET',
    path: `/supply-chain/v1/receipts/buyer-field-rules/${buyerDuns}/type/${ticketType}`,
  });
}

export async function fetchCustomerManagement(buyerDuns: string) {
  return enverusRequest({
    method: 'GET',
    path: '/supply-chain/v1/customer-management',
    queryParams: {
      $filter: `buyerDUNS eq '${buyerDuns}'`,
    },
  });
}

export async function fetchCustomers() {
  return enverusRequest<{ value?: unknown[] }>({
    method: 'GET',
    path: '/supply-chain/v1/customer-management/customers',
  });
}

/** One customer-management row (customer × site × remit-to department). */
export interface CustomerManagementRow {
  customerName?: string;
  customerUuid?: string;
  customerDuns?: string;
  siteName?: string;
  siteUuid?: string;
  departmentName?: string;
  departmentUuid?: string;
  active?: boolean;
  isActive?: boolean;
}

/**
 * Full customer-management list (customer × site × department) for this supplier.
 * NOTE: must be fetched UNFILTERED — the `$filter=buyerDUNS eq …` param returns 0
 * rows on this API, so we pull everything and filter/group in-process. This is the
 * source of truth for buyerDUNS ↔ siteName ↔ siteUuid mappings.
 */
export async function fetchAllCustomerManagement(): Promise<CustomerManagementRow[]> {
  const res = await enverusRequest<unknown>({
    method: 'GET',
    path: '/supply-chain/v1/customer-management',
  });
  const body = res.body as unknown;
  // Body comes back as a bare JSON array.
  return Array.isArray(body) ? (body as CustomerManagementRow[]) : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Multipart Request (for field-ticket.submit — PIDX XML + PDF attachment)
// ─────────────────────────────────────────────────────────────────────────────

interface MultipartField {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
  /** Emit `Content-Transfer-Encoding: base64` and base64-encode the data (multipart/mixed attachments). */
  encoding?: 'base64';
  /** In `mixed` mode, emit `Content-Disposition: attachment; filename="…"` so OpenInvoice ties the part to the receipt's attachments[].fileName. */
  asAttachment?: boolean;
}

interface MultipartOptions {
  /** MIME multipart subtype. `form-data` (legacy) or `mixed` (OpenInvoice receipt+attachment). */
  subtype?: 'form-data' | 'mixed';
}

/** Wrap a base64 string at 76-char lines per RFC 2045 (some MIME parsers are strict). */
function wrapBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

/**
 * Compose a multipart body (pure — no network). Exported so the framing can be
 * unit-verified offline without submitting to OpenInvoice.
 */
export function composeMultipartBody(
  fields: MultipartField[],
  boundary: string,
  subtype: 'form-data' | 'mixed' = 'form-data',
): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const headerLines: string[] = [];
    if (subtype === 'mixed') {
      // OpenInvoice receipt.submit: one application/json part (the event payload, NOT
      // an attachment — so no filename/disposition) plus one base64 part per attachment.
      // OpenInvoice counts a part as an attachment when it carries Content-Disposition: attachment.
      if (field.contentType) headerLines.push(`Content-Type: ${field.contentType}`);
      if (field.encoding === 'base64') headerLines.push('Content-Transfer-Encoding: base64');
      if (field.asAttachment && field.filename) {
        headerLines.push(`Content-Disposition: attachment; filename="${field.filename}"`);
      }
    } else {
      const hasFilename = field.filename;
      headerLines.push(hasFilename
        ? `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"`
        : `Content-Disposition: form-data; name="${field.name}"`);
      // Plain form fields (no filename) omit Content-Type so Enverus doesn't count them as attachments
      if (hasFilename && field.contentType) headerLines.push(`Content-Type: ${field.contentType}`);
    }
    const body = field.encoding === 'base64'
      ? Buffer.from(wrapBase64(field.data.toString('base64')), 'utf-8')
      : field.data;
    parts.push(Buffer.from(`--${boundary}\r\n${headerLines.join('\r\n')}\r\n\r\n`));
    parts.push(body);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

/**
 * Send a multipart POST through the mTLS connection.
 * `form-data` (legacy) builds name-keyed parts; `mixed` builds the
 * OpenInvoice receipt.submit envelope (JSON event payload + Base64 attachments).
 */
export async function enverusMultipartRequest<T = unknown>(
  path: string,
  fields: MultipartField[],
  extraHeaders: Record<string, string> = {},
  opts: MultipartOptions = {},
): Promise<EnverusResponse<T>> {
  const config = getConfig();
  const fullPath = `/docp${path}`;
  const subtype = opts.subtype ?? 'form-data';
  const boundary = `----EnverusBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;

  const bodyBuffer = composeMultipartBody(fields, boundary, subtype);

  // HMAC: sign empty string for multipart (same as GET).
  // The Enverus API guide says POST signs the body, but for multipart
  // the body includes boundaries/headers which aren't signable content.
  const macToken = generateMacToken('');

  const parsedBase = new URL(config.baseUrl);
  const agent = getAgent();

  console.log(`[Enverus] → POST ${fullPath} (multipart, ${bodyBuffer.length} bytes, ${fields.length} parts)`);
  // Log first 500 bytes of multipart body for debugging
  console.log(`[Enverus] Multipart body preview:\n${bodyBuffer.toString('utf-8', 0, Math.min(500, bodyBuffer.length))}`);

  return new Promise<EnverusResponse<T>>((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsedBase.hostname,
        port: parsedBase.port ? parseInt(parsedBase.port, 10) : 443,
        path: fullPath,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': subtype === 'mixed'
            ? `multipart/mixed; boundary="${boundary}"`
            : `multipart/form-data; boundary=${boundary}`,
          Accept: 'application/json, text/xml, application/xml, */*',
          'Content-Length': bodyBuffer.length.toString(),
          ...(macToken ? { mac: macToken } : {}),
          ...extraHeaders,
        },
        timeout: config.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;

          console.log(
            `[Enverus] ← POST ${path} → ${status} (${raw.length} bytes)`,
          );

          if (status >= 200 && status < 300) {
            let parsed: T;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw as unknown as T;
            }
            resolve({
              statusCode: status,
              body: parsed,
              headers: (res.headers || {}) as Record<string, string>,
            });
          } else {
            reject(
              new EnverusApiError(
                classifyError(status),
                status,
                `Enverus API POST ${path} → ${status}: ${raw.slice(0, 2000)}`,
                raw,
              ),
            );
          }
        });
      },
    );

    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        new EnverusApiError(
          'network_timeout',
          null,
          `Enverus network error on POST ${path}: ${err.message}`,
        ),
      );
    });

    req.on('timeout', () => {
      req.destroy();
      reject(
        new EnverusApiError(
          'network_timeout',
          null,
          `Enverus timeout after ${config.timeoutMs}ms on POST ${path}`,
        ),
      );
    });

    req.write(bodyBuffer);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Submission APIs
// ─────────────────────────────────────────────────────────────────────────────

export async function submitReceipt(payload: unknown) {
  return enverusRequest({
    method: 'POST',
    path: '/events/supply-chain/v1/receipt.submit',
    body: payload,
  });
}

/** Pull the numeric receiptID out of a receipt.submit response (for attachment.add).
 *  receipt.submit returns the created receipt under events[0].data.output.receipt;
 *  attachment.add wants that itemID (an int64), not the UUID. */
function extractReceiptId(body: unknown): string | null {
  const events = (body as any)?.events;
  const receipt = events?.[0]?.data?.output?.receipt;
  const id = receipt?.itemID ?? (body as any)?.itemID ?? (body as any)?.id;
  return id != null ? String(id) : null;
}

/**
 * Attach a file to an EXISTING receipt — a separate call after submit.
 *
 * receipt.submit does NOT take attachments inline (that multipart/mixed path 500s
 * their pipeline). Per the OI Swagger, attachments use a dedicated v2 endpoint:
 *   POST /supply-chain/v2/receipt/{receiptID}/attachment.add
 *   - receiptID: numeric int64 (the submit response's itemID), NOT the UUID
 *   - body: multipart/form-data, single `file` field = raw binary (no base64)
 *   - precondition: receipt must already be submitted or disputed
 *   - 404 if the receiptID is wrong
 */
export async function addReceiptAttachment(
  receiptId: string | number,
  fileBuffer: Buffer,
  filename: string,
  contentType: string = 'application/pdf',
): Promise<EnverusResponse> {
  return enverusMultipartRequest(
    `/supply-chain/v2/receipt/${receiptId}/attachment.add`,
    [{ name: 'file', filename, contentType, data: fileBuffer }],
    {},
    { subtype: 'form-data' },
  );
}

/**
 * Submit a receipt, then (optionally) attach a PDF as a SEPARATE second call.
 *
 * The correct flow — proven 2026-06-19: submit the receipt as plain JSON (the
 * multipart/mixed-on-submit path 500s), read the numeric receiptID from the
 * response, then POST the file to /supply-chain/v2/receipt/{id}/attachment.add.
 *
 * Gated behind ENVERUS_RECEIPT_ATTACHMENTS=true (attachments are optional — COP's
 * attachFile has no requiredOn). When off, just submits JSON. Attachment failures
 * are NON-FATAL: the receipt is already created, so we log and return the
 * successful submit response rather than failing the submission.
 */
export async function submitReceiptWithAttachment(
  payload: unknown,
  pdfBuffer?: Buffer,
  pdfFilename: string = 'field-ticket.pdf',
): Promise<EnverusResponse> {
  const submitRes = await submitReceipt(payload);

  const attachmentsEnabled = process.env.ENVERUS_RECEIPT_ATTACHMENTS === 'true';
  if (!attachmentsEnabled || !pdfBuffer || pdfBuffer.length === 0) {
    return submitRes;
  }

  const receiptId = extractReceiptId(submitRes.body);
  if (!receiptId) {
    console.warn('[Enverus] attachment skipped — no receiptID in submit response');
    return submitRes;
  }

  try {
    await addReceiptAttachment(receiptId, pdfBuffer, pdfFilename);
    console.log(`[Enverus] Attached ${pdfFilename} to receipt ${receiptId}`);
  } catch (err) {
    // Receipt is already submitted; a failed attachment must not fail the submit.
    console.warn(
      `[Enverus] attachment.add failed for receipt ${receiptId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return submitRes;
}

export async function cancelReceipt(payload: unknown) {
  return enverusRequest({
    method: 'POST',
    path: '/events/supply-chain/v1/receipt.cancel',
    body: payload,
  });
}

export async function submitInvoice(payload: unknown) {
  return enverusRequest({
    method: 'POST',
    path: '/supply-chain/v3/invoice',
    body: payload,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Polling APIs
// ─────────────────────────────────────────────────────────────────────────────

export async function pollReceiptStatus(receiptNumber: string) {
  return enverusRequest<{ value?: unknown[] }>({
    method: 'GET',
    path: '/supply-chain/v1/receipts',
    queryParams: {
      $filter: `receiptNumber eq '${receiptNumber}'`,
      $select: 'itemID,receiptNumber,status,lastActionDatetime,totalAmount,approvedByName,approvedDatetime,disputedByName,disputedDatetime',
    },
  });
}

export async function pollReceiptById(itemId: string) {
  return enverusRequest({
    method: 'GET',
    path: `/supply-chain/v1/receipts/${itemId}`,
  });
}

export async function pollInvoiceResponses(buyerDuns: string, status = 'received') {
  return enverusRequest<{ value?: unknown[] }>({
    method: 'GET',
    path: '/supply-chain/v1/invoice-responses',
    queryParams: {
      $filter: `buyerDUNS eq '${buyerDuns}' and status eq '${status}'`,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection Test
// ─────────────────────────────────────────────────────────────────────────────

export async function testConnection(): Promise<{
  ok: boolean;
  message: string;
  baseUrl: string;
  supplierDuns: string;
  hmacConfigured: boolean;
  latencyMs?: number;
  details?: unknown;
}> {
  const config = getConfig();
  const start = Date.now();
  try {
    // GET /docp/supply-chain/v2/afes?$top=1 — lightest reliable smoke test.
    // This validates: hostname, /docp prefix, mTLS cert, HMAC mac header.
    const response = await enverusRequest({
      method: 'GET',
      path: '/supply-chain/v2/afes',
      queryParams: { $top: '1' },
    });
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      message: `Connected — ${latencyMs}ms`,
      baseUrl: config.baseUrl,
      supplierDuns: config.supplierDuns,
      hmacConfigured: !!config.hmacSecret,
      latencyMs,
      details: response.body,
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;

    // A 400 "validation_error" from Enverus still proves connectivity:
    // DNS resolved, TLS handshake passed (cert accepted), HMAC accepted,
    // server processed request. The 400 just means the query filter was
    // invalid (e.g. missing required buyerDUNS for suppliers).
    if (err instanceof EnverusApiError && err.category === 'validation_error') {
      return {
        ok: true,
        message: `Connected — cert & HMAC valid (${latencyMs}ms)`,
        baseUrl: config.baseUrl,
        supplierDuns: config.supplierDuns,
        hmacConfigured: !!config.hmacSecret,
        latencyMs,
        details: { note: 'Got 400 (expected for unfiltered supplier query) — auth is working' },
      };
    }

    const msg = err instanceof Error ? err.message : String(err);
    // Provide helpful diagnostic hints
    let hint = '';
    if (err instanceof EnverusApiError) {
      if (err.category === 'auth_failure') hint = ' — check cert, HMAC secret, and IP whitelist';
      if (err.category === 'not_found') hint = ' — check base URL and /docp path prefix';
    }
    return {
      ok: false,
      message: msg + hint,
      baseUrl: config.baseUrl,
      supplierDuns: config.supplierDuns,
      hmacConfigured: !!config.hmacSecret,
      latencyMs,
    };
  }
}
