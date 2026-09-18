/**
 * trainingEmployers.ts — the trainer-admin "kraken = Kraken Oil and Gas" pane.
 *
 * Training roster rows (QR self-sign-in, imports, pre-registrations) carry
 * free-text employer names; billing splits invoices per employer via
 * employerCompanyId, so unmatched text = wrong invoice split. This surfaces
 * every distinct unmatched employer name (across ticket roster records AND
 * ClassPRO session pre-registrations) with fuzzy Company suggestions; a
 * confirm backfills every row with that name and writes a normalized alias
 * so the silent matcher catches the same text forever after.
 *
 * Lives outside the classpro router because roster records are core Sundog —
 * ClassPRO stays bounded (ADR-0002).
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../index.js';
import { AppError } from '../middleware/errorHandler.js';
import { requirePermission } from '../middleware/rbac.js';
import { normalizeName } from '../services/companyMerge.js';
import { suggestForNames } from '../services/employerMatch.js';

export const trainingEmployersRouter = Router();

/** Every unmatched (companyId-less, non-blank) employer string, grouped by
 *  normalized form, across roster records + session registrations. */
async function loadUnmatchedGroups() {
  const [roster, regs] = await Promise.all([
    prisma.trainingRosterRecord.findMany({
      where: { employerCompanyId: null, employerName: { not: null } },
      select: { employerName: true, trainedAt: true },
    }),
    prisma.cpSessionRegistration.findMany({
      where: { employerCompanyId: null, employerName: { not: null } },
      select: { employerName: true, createdAt: true },
    }),
  ]);

  const groups = new Map<string, {
    norm: string;
    variants: Map<string, number>; // raw text → occurrences (display = most common)
    rosterCount: number;
    registrationCount: number;
    lastSeen: Date;
  }>();

  const add = (raw: string | null, seenAt: Date, kind: 'roster' | 'registration') => {
    const norm = normalizeName(raw);
    if (!norm) return;
    const g = groups.get(norm) ?? { norm, variants: new Map(), rosterCount: 0, registrationCount: 0, lastSeen: seenAt };
    g.variants.set(raw!.trim(), (g.variants.get(raw!.trim()) ?? 0) + 1);
    if (kind === 'roster') g.rosterCount++;
    else g.registrationCount++;
    if (seenAt > g.lastSeen) g.lastSeen = seenAt;
    groups.set(norm, g);
  };
  for (const r of roster) add(r.employerName, r.trainedAt, 'roster');
  for (const r of regs) add(r.employerName, r.createdAt, 'registration');
  return groups;
}

// GET /api/training/employers/unmatched — distinct unmatched employer names,
// most frequent first, each with fuzzy Company suggestions.
trainingEmployersRouter.get('/unmatched', requirePermission('training:schedule'), async (_req: Request, res: Response, next) => {
  try {
    const groups = await loadUnmatchedGroups();
    const displayOf = (g: { variants: Map<string, number> }) =>
      [...g.variants.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const list = [...groups.values()].map(g => ({ ...g, display: displayOf(g) }));
    const suggestions = await suggestForNames(list.map(g => g.display));

    list.sort((a, b) => (b.rosterCount + b.registrationCount) - (a.rosterCount + a.registrationCount));
    res.json({
      unmatched: list.map(g => ({
        employerName: g.display,
        variants: [...g.variants.keys()],
        rosterCount: g.rosterCount,
        registrationCount: g.registrationCount,
        lastSeen: g.lastSeen,
        suggestions: suggestions.get(g.display) ?? [],
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/training/employers/match { employerName, companyId }
// Confirm "this text = this customer": backfills every unmatched roster row +
// registration whose normalized name matches, and saves the alias so the
// silent matcher handles the same text from now on.
trainingEmployersRouter.post('/match', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    const { employerName, companyId } = req.body ?? {};
    const norm = normalizeName(typeof employerName === 'string' ? employerName : null);
    if (!norm) throw new AppError(400, 'employerName is required');
    if (typeof companyId !== 'string' || !companyId) throw new AppError(400, 'companyId is required');

    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, isActive: true } });
    if (!company) throw new AppError(404, 'Company not found');
    if (!company.isActive) throw new AppError(400, 'That company is inactive (merged or retired) — pick the surviving record');

    // Normalized-name matching can't be expressed in a Prisma where — pull the
    // unmatched candidates (id + name only) and filter in JS.
    const [rosterRows, regRows] = await Promise.all([
      prisma.trainingRosterRecord.findMany({
        where: { employerCompanyId: null, employerName: { not: null } },
        select: { id: true, employerName: true },
      }),
      prisma.cpSessionRegistration.findMany({
        where: { employerCompanyId: null, employerName: { not: null } },
        select: { id: true, employerName: true },
      }),
    ]);
    const rosterIds = rosterRows.filter(r => normalizeName(r.employerName) === norm).map(r => r.id);
    const regIds = regRows.filter(r => normalizeName(r.employerName) === norm).map(r => r.id);

    const [rosterUpdated, registrationsUpdated] = await prisma.$transaction(async (tx) => {
      const a = rosterIds.length
        ? await tx.trainingRosterRecord.updateMany({ where: { id: { in: rosterIds } }, data: { employerCompanyId: companyId } })
        : { count: 0 };
      const b = regIds.length
        ? await tx.cpSessionRegistration.updateMany({ where: { id: { in: regIds } }, data: { employerCompanyId: companyId } })
        : { count: 0 };
      await tx.trainingEmployerAlias.upsert({
        where: { alias: norm },
        create: { alias: norm, companyId },
        update: { companyId },
      });
      return [a.count, b.count];
    });

    res.json({ ok: true, companyName: company.name, rosterUpdated, registrationsUpdated, alias: norm });
  } catch (err) {
    next(err);
  }
});

// GET /api/training/employers/aliases — the learned dictionary, for review.
trainingEmployersRouter.get('/aliases', requirePermission('training:schedule'), async (_req: Request, res: Response, next) => {
  try {
    const aliases = await prisma.trainingEmployerAlias.findMany({
      include: { company: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ aliases });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/training/employers/aliases/:id — un-learn a bad alias (does not
// un-match rows already backfilled; fix those on the ticket if needed).
trainingEmployersRouter.delete('/aliases/:id', requirePermission('training:schedule'), async (req: Request, res: Response, next) => {
  try {
    await prisma.trainingEmployerAlias.delete({ where: { id: req.params.id as string } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
