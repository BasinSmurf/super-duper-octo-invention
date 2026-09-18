/**
 * Dump Enverus buyer rules for every customer DUNS.
 *
 * SELF-CONTAINED — no project-relative imports. You can `docker cp` this
 * single file into the prod API container and run it with `tsx` directly,
 * even though the container doesn't ship `src/` or `scripts/`.
 *
 * Source:  the customer hot-roll JSON (Enverus swagger output, list of
 *          { customerName, customerDuns, ... }).
 * Action:  for each unique DUNS, GET /docp/api/supply-chain/v1/receipts/buyers/{duns}/type/{type}
 *          and stash the response.
 * Output:  by default, alongside the input file:
 *            <input-dir>/enverus-buyer-rules-{type}-{timestamp}.json
 *
 * Run on dev box (sandbox creds in server/.env):
 *   cd server
 *   ENVERUS_BASE_URL=https://api.openinvoice.com \
 *     npx tsx scripts/dump-enverus-buyer-rules.ts <input.json>
 *
 * Run on prod (preferred — IP whitelisted, real PFX + HMAC):
 *   # on dev box
 *   scp server/scripts/dump-enverus-buyer-rules.ts sundog@servpro:/tmp/
 *   # on servpro
 *   docker cp /tmp/dump-enverus-buyer-rules.ts servicepro-api:/tmp/dump.ts
 *   docker cp /tmp/customer-list.json servicepro-api:/tmp/customer-list.json
 *   docker exec -it servicepro-api npx tsx /tmp/dump.ts /tmp/customer-list.json
 *   docker cp servicepro-api:/tmp/. ./enverus-output/
 *
 * Required env (prod container has these baked from .env.production):
 *   ENVERUS_BASE_URL          (e.g. https://api.openinvoice.com)
 *   ENVERUS_PFX_PATH          path to client cert PFX
 *   ENVERUS_PFX_PASSPHRASE    PFX passphrase
 *   ENVERUS_HMAC_SECRET       HMAC signing secret for `mac` header
 * Optional:
 *   ENVERUS_CERT_PATH         public PEM (CA chain), if needed
 *   ENVERUS_TIMEOUT_MS        per-request timeout (default 30000)
 *
 * Flags:
 *   --concurrency N        parallel requests (default 3)
 *   --type lem             ticket type segment (default lem)
 *   --out path             override output file
 *   --path-template "..."  override URL path; {duns} and {type} get substituted.
 *                          default: /supply-chain/v1/receipts/buyers/{duns}/type/{type}
 *                          (the original swagger curl had /api/supply-chain/... but that
 *                           prefix is app.openinvoice.com-only; api.openinvoice.com drops it)
 */

import https from 'https';
import crypto from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

// Best-effort dotenv (only needed when running outside a container)
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv/config');
} catch {
  /* fine — env vars expected from container or shell */
}

interface CustomerRow {
  customerName: string;
  customerDuns: string;
}

interface DumpEntry {
  duns: string;
  customerNames: string[];
  status: 'ok' | 'error';
  httpStatus?: number;
  errorMessage?: string;
  body?: unknown;
}

const DEFAULT_PATH_TEMPLATE = '/supply-chain/v1/receipts/buyers/{duns}/type/{type}';

function parseArgs() {
  const args = process.argv.slice(2);
  let inputFile = '';
  let concurrency = 3;
  let ticketType = 'lem';
  let outFile = '';
  let pathTemplate = DEFAULT_PATH_TEMPLATE;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--concurrency') concurrency = parseInt(args[++i], 10) || 3;
    else if (a === '--type') ticketType = args[++i];
    else if (a === '--out') outFile = args[++i];
    else if (a === '--path-template') pathTemplate = args[++i];
    else if (!a.startsWith('--')) inputFile = a;
  }

  if (!inputFile) {
    console.error(
      'usage: tsx dump-enverus-buyer-rules.ts <customer-list.json> [--concurrency N] [--type lem] [--out path] [--path-template "/foo/{duns}/{type}"]',
    );
    process.exit(1);
  }
  return { inputFile, concurrency, ticketType, outFile, pathTemplate };
}

// ── Inline mTLS + HMAC GET helper (kept tiny on purpose) ──────────────

function getEnv(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

let _agent: https.Agent | null = null;
function getAgent(): https.Agent {
  if (_agent) return _agent;
  const pfxPath = getEnv('ENVERUS_PFX_PATH');
  if (!pfxPath) throw new Error('ENVERUS_PFX_PATH not set');

  const opts: https.AgentOptions = {
    keepAlive: true,
    pfx: readFileSync(pfxPath),
    passphrase: getEnv('ENVERUS_PFX_PASSPHRASE'),
  };
  const certPath = getEnv('ENVERUS_CERT_PATH');
  if (certPath) {
    try {
      opts.cert = readFileSync(certPath);
    } catch {
      /* optional */
    }
  }
  _agent = new https.Agent(opts);
  return _agent;
}

function macHeader(body: string): string {
  const secret = getEnv('ENVERUS_HMAC_SECRET');
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(body, 'utf-8').digest('base64');
}

interface FetchResult {
  statusCode: number;
  body: unknown;
  raw: string;
}

function enverusGet(pathSuffix: string): Promise<FetchResult> {
  const baseUrl = getEnv('ENVERUS_BASE_URL', 'https://onboard-api.openinvoice.com');
  const timeoutMs = parseInt(getEnv('ENVERUS_TIMEOUT_MS', '30000'), 10);
  const url = new URL(baseUrl);
  const fullPath = `/docp${pathSuffix}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 443,
        path: fullPath,
        method: 'GET',
        agent: getAgent(),
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          mac: macHeader(''),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* keep raw */
          }
          resolve({ statusCode: res.statusCode || 0, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.end();
  });
}

// ── Concurrency-limited map ───────────────────────────────────────────

async function pmap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const { inputFile, concurrency, ticketType, outFile, pathTemplate } = parseArgs();

  const raw = readFileSync(inputFile, 'utf-8');
  const rows = JSON.parse(raw) as CustomerRow[];
  if (!Array.isArray(rows)) throw new Error('Input is not a JSON array');

  const dunsMap = new Map<string, Set<string>>();
  for (const r of rows) {
    const duns = (r.customerDuns || '').trim();
    if (!duns) continue;
    if (!dunsMap.has(duns)) dunsMap.set(duns, new Set());
    if (r.customerName) dunsMap.get(duns)!.add(r.customerName);
  }

  const unique = [...dunsMap.entries()].map(([duns, names]) => ({
    duns,
    names: [...names],
  }));

  console.log(`[dump] ${rows.length} rows → ${unique.length} unique DUNS`);
  console.log(`[dump] type=${ticketType}, concurrency=${concurrency}`);
  console.log(`[dump] base = ${getEnv('ENVERUS_BASE_URL', '(default sandbox)')}`);
  console.log(`[dump] path = ${pathTemplate}`);
  console.log(`[dump] pfx  = ${getEnv('ENVERUS_PFX_PATH', '(none)')}`);
  console.log(`[dump] hmac = ${getEnv('ENVERUS_HMAC_SECRET') ? '(set)' : '(off)'}`);

  const start = Date.now();
  const results = await pmap(unique, concurrency, async ({ duns, names }) => {
    const entry: DumpEntry = { duns, customerNames: names, status: 'ok' };
    try {
      const requestPath = pathTemplate
        .replace('{duns}', duns)
        .replace('{type}', ticketType);
      const resp = await enverusGet(requestPath);
      entry.httpStatus = resp.statusCode;
      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        entry.body = resp.body;
        console.log(`[ok ] ${duns}  ${names.join(' / ')}`);
      } else {
        entry.status = 'error';
        entry.body = resp.body;
        entry.errorMessage = resp.raw.slice(0, 400);
        console.warn(
          `[err] ${duns}  ${names.join(' / ')}  → ${resp.statusCode}  ${resp.raw.slice(0, 160)}`,
        );
      }
    } catch (err) {
      entry.status = 'error';
      entry.errorMessage = err instanceof Error ? err.message : String(err);
      console.warn(`[err] ${duns}  ${names.join(' / ')}  → ${entry.errorMessage}`);
    }
    return entry;
  });

  const elapsedMs = Date.now() - start;
  const ok = results.filter((r) => r.status === 'ok').length;
  const fail = results.length - ok;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const finalOut =
    outFile ||
    path.join(
      path.dirname(path.resolve(inputFile)),
      `enverus-buyer-rules-${ticketType}-${ts}.json`,
    );

  writeFileSync(
    finalOut,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceFile: inputFile,
        ticketType,
        baseUrl: getEnv('ENVERUS_BASE_URL', null),
        totalDuns: unique.length,
        ok,
        fail,
        elapsedMs,
        results,
      },
      null,
      2,
    ),
    'utf-8',
  );

  console.log('');
  console.log(`[dump] wrote ${finalOut}`);
  console.log(`[dump] ${ok} ok / ${fail} fail / ${elapsedMs}ms`);

  console.log('');
  console.log('=== rule-shape summary ===');
  for (const r of results) {
    if (r.status !== 'ok' || !r.body || typeof r.body !== 'object') continue;
    const body = r.body as Record<string, unknown>;
    const topKeys = Object.keys(body).sort();
    const fingerprint = topKeys.join(',');
    console.log(`${r.duns}  [${fingerprint.slice(0, 120)}]  ${r.customerNames[0] ?? ''}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
