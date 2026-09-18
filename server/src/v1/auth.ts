/**
 * v1/auth.ts — the v1 authentication layer.
 *
 * Two-gate, BlueLion-consistent model:
 *   1. PRIMARY: scoped API key (`Authorization: Bearer sp_…`) — hashed,
 *      revocable, read-only per-resource scopes. This is the OG-data firewall.
 *   2. Staff JWT also accepted (full read, scope '*') so internal callers work.
 *   3. SECONDARY (per-key): optional IP allowlist — defense-in-depth. NB only
 *      trustworthy once `app.set('trust proxy', …)` is correct, since we sit
 *      behind nginx/Cloudflare (raw req.ip would otherwise be the proxy's).
 *   + per-principal rate limit + lightweight access log.
 *
 * Portal ('customer') JWTs are explicitly rejected — they belong on /api/portal.
 */
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyApiKey, type ApiKeyRecord } from './apiKeyStore.js';
import { V1Error } from './respond.js';

export interface V1Principal {
  type: 'user' | 'apiKey';
  id: string;
  role?: string;     // user role (for ticket transitions); undefined for keys
  scopes: string[];  // apiKey scopes; users get ['*']
  label?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      v1?: V1Principal;
    }
  }
}

const API_KEY_PREFIX = 'sp_';

// crude in-memory fixed-window limiter, per principal id. Swap for Redis if v1
// ever runs multi-instance — jobLocks.ts already wires ioredis.
const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();
function withinRate(id: string, max: number): boolean {
  const now = Date.now();
  const b = buckets.get(id);
  if (!b || now >= b.resetAt) {
    buckets.set(id, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}

function ipAllowed(record: ApiKeyRecord, req: Request): boolean {
  if (!record.allowedIps || record.allowedIps.length === 0) return true;
  return record.allowedIps.includes(req.ip ?? '');
}

/**
 * Returns middleware enforcing auth + (optional) a required scope.
 * Usage: `router.get('/tickets', v1Auth('tickets:read'), handler)`.
 */
export function v1Auth(requiredScope?: string) {
  // async is safe here — express-async-errors forwards rejections to the
  // error middleware (same mechanism the v1 route handlers rely on).
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new V1Error(401, 'unauthorized', 'Missing or invalid Authorization header');
    }
    const token = header.slice(7);

    let principal: V1Principal;

    if (token.startsWith(API_KEY_PREFIX)) {
      const rec = await verifyApiKey(token);
      if (!rec) throw new V1Error(401, 'unauthorized', 'Invalid API key');
      if (!ipAllowed(rec, req)) throw new V1Error(403, 'ip_not_allowed', 'Source IP not permitted for this key');
      principal = { type: 'apiKey', id: rec.id, scopes: rec.scopes ?? [], label: rec.label };
    } else {
      const secret = process.env.JWT_SECRET;
      if (!secret) throw new V1Error(500, 'config_error', 'JWT_SECRET not configured');
      try {
        const payload = jwt.verify(token, secret) as { userId: string; role?: string };
        if (payload.role === 'customer') {
          throw new V1Error(403, 'forbidden', 'Portal accounts cannot access the API');
        }
        principal = { type: 'user', id: payload.userId, role: payload.role, scopes: ['*'] };
      } catch (e) {
        if (e instanceof V1Error) throw e;
        throw new V1Error(401, 'unauthorized', 'Invalid or expired token');
      }
    }

    if (requiredScope && !principal.scopes.includes('*') && !principal.scopes.includes(requiredScope)) {
      throw new V1Error(403, 'forbidden', `Missing required scope: ${requiredScope}`);
    }

    const max = principal.type === 'apiKey' ? 300 : 1000;
    if (!withinRate(principal.id, max)) {
      throw new V1Error(429, 'rate_limited', 'Rate limit exceeded — slow down');
    }

    req.v1 = principal;
    console.log(`[v1] ${principal.type}:${principal.label ?? principal.id} ${req.method} ${req.originalUrl}`);
    next();
  };
}
