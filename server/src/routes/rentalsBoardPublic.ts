/**
 * Rentals Kanban board endpoint (Scheduled / Active / Recently Closed).
 *
 * Served at /api/rentals-board. View-only — no actions live here. Gated by
 * authenticateUserOrKiosk so a wall tablet can render it with a provisioned
 * kiosk token (X-Kiosk-Token) and staff with their JWT. Mirrors the shop
 * board's public-endpoint shape (see shopBoardPublic.ts).
 *
 * One endpoint, two filters — deliberately not a second per-site route. The
 * shop board grew a parallel /api/boards/:siteSlug surface; doing that again
 * here would mean two implementations of the same three columns.
 *
 *   ?site=<shortCode>   one shop, or every site when omitted
 *   ?pickupType=        dispatch | walk_in, or both when omitted
 *
 * WHO DECIDES: a kiosk does not get to pick. Its provisioned role and site
 * win, and query params are ignored for kiosk callers — a wall display must
 * not be repointable at another shop's board by someone editing the URL in
 * the address bar. Staff on a JWT can filter freely; that's the in-app board.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { authenticateUserOrKiosk } from '../middleware/kioskAuth.js';
import {
  buildRentalsBoard, parsePickupType, kioskBoardFilter,
  type RentalsBoardFilter,
} from '../services/rentalsBoard.js';

export const rentalsBoardPublicRouter = Router();

rentalsBoardPublicRouter.get('/', authenticateUserOrKiosk, async (req: Request, res: Response, next) => {
  try {
    let filter: RentalsBoardFilter;

    if (req.kiosk) {
      // Pinned by provisioning — see kioskBoardFilter.
      filter = kioskBoardFilter(req.kiosk);
    } else {
      const siteCode = typeof req.query.site === 'string' ? req.query.site.trim() : '';
      let siteId: string | null = null;
      if (siteCode) {
        const site = await prisma.site.findUnique({
          where: { shortCode: siteCode.toUpperCase() },
          select: { id: true },
        });
        if (!site) throw new AppError(404, `No site with code "${siteCode}"`);
        siteId = site.id;
      }
      filter = { siteId, pickupType: parsePickupType(req.query.pickupType) };
    }

    const board = await buildRentalsBoard(filter);
    res.json({
      generatedAt: new Date().toISOString(),
      pickupType: filter.pickupType,
      siteId: filter.siteId ?? null,
      ...board,
    });
  } catch (err) {
    next(err);
  }
});
