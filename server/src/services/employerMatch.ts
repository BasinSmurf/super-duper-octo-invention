/**
 * employerMatch.ts — silent employer→Company matching for training rosters.
 *
 * Students type their employer as free text ("kraken") on the QR self-sign-in
 * and on session pre-registration; billing splits invoices per employer via
 * TrainingRosterRecord.employerCompanyId, so unmatched text means a wrong
 * invoice split. Two layers fix that:
 *
 *   1. matchEmployer — HIGH-CONFIDENCE ONLY, called silently at write time:
 *      a confirmed alias (training_employer_aliases, normalized) or an exact
 *      normalized-name hit on an active Company. Never fuzzy — a wrong silent
 *      match is worse than no match. Never throws (bad-divorce: a DB hiccup
 *      degrades to unmatched, which the reconcile pane catches later).
 *
 *   2. suggestForNames — fuzzy candidates for the trainer-admin reconcile
 *      pane, using the same core-name comparison as company dedupe
 *      ("kraken" ~ "Kraken Oil & Gas LLC"). Human confirms; confirmation
 *      writes an alias so layer 1 catches it silently next time.
 */

import { prisma } from '../index.js';
import { normalizeName, coreName } from './companyMerge.js';

export interface EmployerMatch {
  companyId: string;
  companyName: string;
}

/** Alias or exact normalized-name match against active companies. Never throws. */
export async function matchEmployer(name: string | null | undefined): Promise<EmployerMatch | null> {
  const norm = normalizeName(name ?? null);
  if (!norm) return null;
  try {
    const alias = await prisma.trainingEmployerAlias.findUnique({
      where: { alias: norm },
      select: { company: { select: { id: true, name: true, isActive: true } } },
    });
    if (alias?.company.isActive) return { companyId: alias.company.id, companyName: alias.company.name };

    // Exact match on the normalized name. `equals insensitive` misses collapsed
    // whitespace, so compare normalized forms over a narrowed candidate set.
    const candidates = await prisma.company.findMany({
      where: { isActive: true, name: { contains: norm.split(' ')[0], mode: 'insensitive' } },
      select: { id: true, name: true },
      take: 50,
    });
    const exact = candidates.find(c => normalizeName(c.name) === norm);
    return exact ? { companyId: exact.id, companyName: exact.name } : null;
  } catch (err) {
    console.warn('[employerMatch] lookup failed, leaving unmatched:', (err as Error).message);
    return null;
  }
}

export interface EmployerSuggestion {
  companyId: string;
  companyName: string;
  /** 3 = exact normalized name, 2 = same core name, 1 = core-name overlap. */
  strength: 1 | 2 | 3;
}

/**
 * Fuzzy suggestions for a batch of employer names (the reconcile pane calls
 * this once for its whole unmatched list — companies load once, score in JS).
 */
export async function suggestForNames(names: string[], perName = 5): Promise<Map<string, EmployerSuggestion[]>> {
  const out = new Map<string, EmployerSuggestion[]>();
  if (names.length === 0) return out;

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const scored = companies.map(c => ({ id: c.id, name: c.name, norm: normalizeName(c.name), core: coreName(c.name) }));

  for (const name of names) {
    const qNorm = normalizeName(name);
    const qCore = coreName(name);
    if (!qNorm) {
      out.set(name, []);
      continue;
    }
    const matches: EmployerSuggestion[] = [];
    for (const c of scored) {
      let strength: 1 | 2 | 3 | 0 = 0;
      if (c.norm === qNorm) strength = 3;
      else if (qCore && c.core === qCore) strength = 2;
      else if (
        qCore.length >= 4 && c.core.length >= 4 &&
        (c.core.includes(qCore) || qCore.includes(c.core))
      ) strength = 1;
      if (strength) matches.push({ companyId: c.id, companyName: c.name, strength });
    }
    matches.sort((a, b) => b.strength - a.strength || a.companyName.localeCompare(b.companyName));
    out.set(name, matches.slice(0, perName));
  }
  return out;
}
