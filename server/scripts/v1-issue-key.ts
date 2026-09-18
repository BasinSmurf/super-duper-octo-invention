/**
 * v1-issue-key.ts — generate a v1 API key.
 *
 * Mirrors BlueLion's `npm run token` issuance: prints the PLAINTEXT key once,
 * plus the JSON record (with sha256 hash) to append to the `V1_API_KEYS` env
 * array. The plaintext is never stored — copy it now.
 *
 * Usage:
 *   npm run v1:key -- <label> <scope[,scope...]> [--ip 1.2.3.4,5.6.7.8]
 *
 * Examples:
 *   npm run v1:key -- acme-readonly tickets:read,invoices:read
 *   npm run v1:key -- partner-all "*" --ip 203.0.113.5
 *
 * Known scopes: tickets:read invoices:read equipment:read inspections:read
 *   rentals:read locations:read companies:read trainings:read
 *   bluelion:read bluelion:write   ('*' = all)
 */
import crypto from 'crypto';

const args = process.argv.slice(2);
const ipFlag = args.indexOf('--ip');
const allowedIps = ipFlag >= 0 ? (args[ipFlag + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];
const positional = (ipFlag >= 0 ? args.slice(0, ipFlag) : args).filter(Boolean);

const [label, scopeArg] = positional;
if (!label || !scopeArg) {
  console.error('Usage: npm run v1:key -- <label> <scope[,scope...]> [--ip a,b]');
  process.exit(1);
}

const scopes = scopeArg.split(',').map((s) => s.trim()).filter(Boolean);
const plaintext = `sp_${crypto.randomBytes(24).toString('base64url')}`;
const keyHash = crypto.createHash('sha256').update(plaintext).digest('hex');
const id = `k_${crypto.randomBytes(4).toString('hex')}`;

const record = { id, label, keyHash, scopes, ...(allowedIps.length ? { allowedIps } : {}), revoked: false };

console.log('\n=== v1 API key issued — copy the plaintext NOW (not recoverable) ===\n');
console.log(`  KEY:  ${plaintext}\n`);
console.log('Append this record to the V1_API_KEYS JSON array in the server env:\n');
console.log(JSON.stringify(record, null, 2));
console.log('\nExample (single key):');
console.log(`  V1_API_KEYS='[${JSON.stringify(record)}]'\n`);
