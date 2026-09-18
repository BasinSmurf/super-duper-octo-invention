/**
 * Startup environment variable validation.
 * Logs warnings for missing optional vars, throws for missing required vars.
 * Call once at server boot (before routes are registered).
 */

interface EnvVar {
  name: string;
  required: boolean;
  /** Only required in this NODE_ENV (omit = all environments) */
  envOnly?: 'production' | 'development';
  /** Human-readable hint about what this does */
  hint: string;
}

const ENV_VARS: EnvVar[] = [
  // ── Required everywhere ──
  { name: 'DATABASE_URL',        required: true,  hint: 'PostgreSQL connection string' },
  { name: 'JWT_SECRET',          required: true,  hint: 'JWT signing secret (openssl rand -hex 32)' },

  // ── Required in production ──
  { name: 'REDIS_URL',           required: false, hint: 'Redis connection string' },

  // ── QBWC ──
  // Required in production: the SOAP endpoint is internet-reachable and a blank
  // password would let any client in with the default username (see qbwc.ts).
  { name: 'QBWC_USERNAME',       required: true,  envOnly: 'production', hint: 'QuickBooks Web Connector username' },
  { name: 'QBWC_PASSWORD',       required: true,  envOnly: 'production', hint: 'QuickBooks Web Connector password' },
  { name: 'QBWC_FILE_ID',        required: false, hint: 'QuickBooks company file ID' },

  // ── Enverus ──
  { name: 'ENVERUS_BASE_URL',    required: false, hint: 'Enverus API base (sandbox or production)' },
  { name: 'ENVERUS_PFX_PATH',    required: false, hint: 'Path to Enverus PFX client certificate' },
  { name: 'ENVERUS_PFX_PASSPHRASE', required: false, hint: 'Enverus PFX passphrase' },
  { name: 'ENVERUS_SUPPLIER_DUNS',   required: false, hint: 'Basin Safety supplier DUNS number' },
  { name: 'ENVERUS_HMAC_SECRET',     required: false, hint: 'Enverus HMAC signing secret' },

  // ── Google SSO ──
  { name: 'GOOGLE_CLIENT_ID',    required: false, hint: 'Google OAuth client ID (for SSO)' },
  { name: 'GOOGLE_SA_KEY_PATH',  required: false, hint: 'Google service account key file (Groups API + Gmail send)' },
  { name: 'GOOGLE_MAIL_FROM',    required: false, hint: 'Workspace mailbox to send app email from (e.g. notifications@basinsafetyus.com)' },

  // ── Stripe ──
  { name: 'STRIPE_SECRET_KEY',       required: false, hint: 'Stripe secret key (sk_test_ or sk_live_)' },
  { name: 'STRIPE_PUBLISHABLE_KEY',  required: false, hint: 'Stripe publishable key (pk_test_ or pk_live_)' },
];

export function checkEnvironment(): void {
  const env = process.env.NODE_ENV || 'development';
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const v of ENV_VARS) {
    // Skip vars that are only for a different environment
    if (v.envOnly && v.envOnly !== env) continue;

    const val = process.env[v.name];
    const isEmpty = !val || val.trim() === '';

    if (isEmpty) {
      if (v.required) {
        missing.push(`  ${v.name} — ${v.hint}`);
      } else {
        warnings.push(`  ${v.name} — ${v.hint}`);
      }
    }
  }

  // ── Dev-only safety checks ──
  if (env !== 'production') {
    const sk = process.env.STRIPE_SECRET_KEY || '';
    if (sk.startsWith('sk_live_')) {
      console.error('\n\x1b[41m\x1b[37m DANGER \x1b[0m Live Stripe secret key detected in dev environment!');
      console.error('  Replace with sk_test_ key in server/.env\n');
    }
  }

  // ── Prod-only safety checks ──
  if (env === 'production') {
    const jwt = process.env.JWT_SECRET || '';
    if (jwt.length < 32 || jwt.includes('change') || jwt.includes('dev-secret')) {
      missing.push('  JWT_SECRET — Must be a strong random secret in production');
    }

    const enverusUrl = process.env.ENVERUS_BASE_URL || '';
    if (enverusUrl.includes('onboard-api')) {
      warnings.push('  ENVERUS_BASE_URL — Currently pointing to SANDBOX. Set to https://api.openinvoice.com for production.');
    }

    const sk = process.env.STRIPE_SECRET_KEY || '';
    if (sk.startsWith('sk_test_')) {
      warnings.push('  STRIPE_SECRET_KEY — Using TEST key in production. Set sk_live_ for real payments.');
    }
  }

  // ── Report ──
  if (warnings.length > 0) {
    console.warn(`\n\x1b[33m⚠ Missing optional env vars (features may be disabled):\x1b[0m`);
    warnings.forEach(w => console.warn(`\x1b[33m${w}\x1b[0m`));
    console.warn('');
  }

  if (missing.length > 0) {
    console.error(`\n\x1b[31m✖ Missing REQUIRED env vars:\x1b[0m`);
    missing.forEach(m => console.error(`\x1b[31m${m}\x1b[0m`));
    console.error('');
    if (env === 'production') {
      throw new Error(`Server cannot start: ${missing.length} required env var(s) missing. Check .env.production.`);
    }
  }

  // ── Summary ──
  const total = ENV_VARS.filter(v => !v.envOnly || v.envOnly === env).length;
  const set = total - missing.length - warnings.length;
  console.log(`\x1b[32m✓ Environment: ${env} — ${set}/${total} vars configured\x1b[0m`);
}
