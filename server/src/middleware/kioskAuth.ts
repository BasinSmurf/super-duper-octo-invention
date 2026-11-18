/**
 * kioskAuth.ts — authentication for kiosk devices.
 *
 * Kiosks have no user login. They carry a provisioned `apiToken` (baked into
 * the kiosk image) and send it as the `X-Kiosk-Token` header.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import type { AuthPayload } from './auth.js';

export interface KioskAuth {
  kioskId: string;
  slug: string;
  siteId: string;
  role: string;
  stationFilter: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      kiosk?: KioskAuth;
    }
  }
}

function extractKioskToken(req: Request): string | null {
  const header = req.headers['x-kiosk-token'];
  return typeof header === 'string' && header.length > 0 ? header : null;
}

async function lookupKiosk(token: string): Promise<KioskAuth | null> {
  const kiosk = await prisma.kiosk.findUnique({ where: { apiToken: token } });
  if (!kiosk || !kiosk.active) return null;
  return { kioskId: kiosk.id, slug: kiosk.slug, siteId: kiosk.siteId, role: kiosk.role, stationFilter: kiosk.stationFilter };
}

/** Require a valid kiosk apiToken (X-Kiosk-Token header). */
export async function authenticateKiosk(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractKioskToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing kiosk token' });
    return;
  }
  const kiosk = await lookupKiosk(token);
  if (!kiosk) {
    res.status(401).json({ error: 'Invalid or inactive kiosk token' });
    return;
  }
  req.kiosk = kiosk;
  next();
}

/**
 * Accept either a logged-in user (JWT) or a kiosk token — used by the board
 * data endpoints, which both managers and wall displays read.
 */
export async function authenticateUserOrKiosk(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const secret = process.env.JWT_SECRET;
  if (authHeader?.startsWith('Bearer ') && secret) {
    try {
      req.user = jwt.verify(authHeader.slice(7), secret) as AuthPayload;
      next();
      return;
    } catch {
      // fall through to kiosk-token check
    }
  }

  const token = extractKioskToken(req);
  if (token) {
    const kiosk = await lookupKiosk(token);
    if (kiosk) {
      req.kiosk = kiosk;
      next();
      return;
    }
  }

  res.status(401).json({ error: 'Authentication required' });
}
