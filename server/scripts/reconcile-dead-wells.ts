/**
 * Reconcile "dead" ServicePRO wells against dead_wells_matched.csv — an
 * external fuzzy-match pass of orphaned wells (name only, no api/status)
 * against the DMR reference table (dmr_reference_wells).
 *
 * Per row: find the ServicePRO well by exact name match, then backfill its
 * apiNumber + wellStatus from the matched DMR row, and — only when the
 * suggested action is DEACTIVATE — set isActiveForService = false. Operator
 * is updated (with an OperatorHistory record, same pattern as the admin
 * operator-reassign flow) only when it resolves to a known Company; unknown
 * operators are left alone rather than guessed.
 *
 * Scope, per user direction 2026-07-31 ("anything with a matching score
 * above 80 is ready to rock"):
 *   - Only rows with best_score > 80 are processed.
 *   - Rows flagged ambiguous_name=YES are held back regardless of score —
 *     a high score there just means "clearly better than the OTHER
 *     look-alikes," not "confidently the right well." Reported separately.
 *
 * Usage: npx tsx scripts/reconcile-dead-wells.ts [--dry-run] [--csv <path>]
 */

import 'dotenv/config';
import fs from 'node:fs';
import { prisma } from '../src/db.js';

const SCORE_THRESHOLD = 80;

// Same alias map as bulk-activate-dmr.ts — DMR operatorName -> Sundog Company name.
const OPERATOR_ALIASES: Record<string, string> = {
  'CONTINENTAL RESOURCES, INC.': 'Continental Resources, Inc',
  'HESS BAKKEN INVESTMENTS II, LLC': 'Hess Bakken Investments',
  'EOG RESOURCES, INC.': 'EOG Resources Inc.',
  'PETRO-HUNT, L.L.C.': 'Petro-Hunt, LLC',
  'PETRO-HUNT DAKOTA, LLC': 'Petro-Hunt Dakota, LLC',
  'XTO ENERGY INC': 'XTO Energy Inc',
  'KRAKEN OPERATING, LLC': 'Kraken Oil & Gas',
  'KODA RESOURCES OPERATING, LLC': 'KODA Resources LLC',
  'WHITING OIL AND GAS CORPORATION': 'Whiting Petroleum',
  'OASIS PETROLEUM NORTH AMERICA LLC': 'Oasis Petroleum',
  'MARATHON OIL COMPANY': 'Marathon Oil',
  'ENERPLUS RESOURCES USA CORPORATION': 'Enerplus Resources Corporation',
  'WHITE ROCK OIL & GAS, LLC': 'White Rock Oil & Gas',
  'MORNINGSTAR OPERATING LLC': 'MorningStar Operating',
  'HYDRA SERVICES LLC': 'Hydra Services LLC - Kraken',
};

interface Row {
  dead_well: string;
  confidence: string;
  best_score: string;
  matched_name: string;
  api: string;
  status: string;
  operator: string;
  county: string;
  suggested_action: string;
  ambiguous_name: string;
}

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const header = splitCsvLine(lines[0]);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]);
    if (fields.length === 1 && fields[0] === '') continue;
    const row: any = {};
    header.forEach((h, idx) => { row[h] = fields[idx] ?? ''; });
    rows.push(row as Row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function resolveOperatorId(rawName: string, companyByName: Map<string, string>): string | null {
  if (!rawName) return null;
  const alias = OPERATOR_ALIASES[rawName];
  if (alias) return companyByName.get(alias) ?? null;
  return companyByName.get(rawName) ?? null;
}

// Same repoint-then-delete pattern used for the Rink 13x-4 duplicate in
// promote-pads.ts, generalized: fold a "dead" duplicate well's history onto
// the real, already-identified well and remove the duplicate.
async function mergeWellInto(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], fromWellId: string, toWellId: string) {
  await tx.workPoint.updateMany({ where: { wellId: fromWellId }, data: { wellId: toWellId } });
  await tx.serviceTicket.updateMany({ where: { wellId: fromWellId }, data: { wellId: toWellId } });
  await tx.operatorHistory.updateMany({ where: { wellId: fromWellId }, data: { wellId: toWellId } });
  await tx.routeStop.updateMany({ where: { wellId: fromWellId }, data: { wellId: toWellId } });
  await tx.rentalAgreement.updateMany({ where: { wellId: fromWellId }, data: { wellId: toWellId } });
  await tx.serializedEquipment.updateMany({ where: { currentWellId: fromWellId }, data: { currentWellId: toWellId } });
  await tx.ticketLineItem.updateMany({ where: { wellIdOverride: fromWellId }, data: { wellIdOverride: toWellId } });
  await tx.fitTestRecord.updateMany({ where: { wellId: fromWellId }, data: { wellId: toWellId } });
  await tx.dmrReferenceWell.updateMany({ where: { matchedWellId: fromWellId }, data: { matchedWellId: toWellId } });
  await tx.well.delete({ where: { id: fromWellId } });
}

async function assertNoJsonArrayReferences(wellId: string) {
  const rows = await prisma.$queryRaw<{ id: string; agreement_number: string }[]>`
    SELECT id, agreement_number FROM rental_agreements
    WHERE well_ids::text LIKE ${'%"' + wellId + '"%'}
  `;
  if (rows.length > 0) {
    throw new Error(
      `Well ${wellId} appears in rental_agreements.well_ids JSON array for: ${rows.map(r => r.agreement_number).join(', ')}. ` +
      `Resolve manually before merging — refusing to guess.`
    );
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const csvArgIdx = process.argv.indexOf('--csv');
  const csvPath = csvArgIdx >= 0 ? process.argv[csvArgIdx + 1] : 'C:/Users/mbart/Downloads/dead_wells_matched.csv';

  const text = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCsv(text);

  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  const companyByName = new Map(companies.map(c => [c.name, c.id]));

  const eligible = rows.filter(r => parseFloat(r.best_score) > SCORE_THRESHOLD);
  const ambiguousHeld = eligible.filter(r => r.ambiguous_name === 'YES');
  const candidates = eligible.filter(r => r.ambiguous_name !== 'YES');

  // Multiple distinct dead_well rows targeting the same api is a matcher
  // artifact risk, not just "these are duplicates of each other" — e.g. 8
  // differently-numbered "Hereford 1-N" wells all fuzzy-matched to the same
  // single real well. Processing these in file order would non-deterministically
  // cascade-merge them (api collides -> looks like a duplicate -> merges) even
  // though they may be genuinely distinct wells the DMR reference table just
  // doesn't have separate entries for. Hold the whole group back.
  const byApi = new Map<string, Row[]>();
  for (const r of candidates) {
    if (!byApi.has(r.api)) byApi.set(r.api, []);
    byApi.get(r.api)!.push(r);
  }
  const apiCollisionHeld = [...byApi.values()].filter(group => group.length > 1).flat();
  const collisionApis = new Set(apiCollisionHeld.map(r => r.api));
  const toProcess = candidates.filter(r => !collisionApis.has(r.api));

  console.log(`Dead Well Reconciliation${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`  Total rows:              ${rows.length}`);
  console.log(`  Score > ${SCORE_THRESHOLD}:              ${eligible.length}`);
  console.log(`  Held back (ambiguous):   ${ambiguousHeld.length}`);
  console.log(`  Held back (api collision): ${apiCollisionHeld.length}`);
  console.log(`  To process:              ${toProcess.length}\n`);

  const stats = { reconciled: 0, deactivated: 0, merged: 0 };
  const notFound: string[] = [];
  const statusMismatch: string[] = [];
  const operatorUnresolved: string[] = [];

  for (const row of toProcess) {
    const well = await prisma.well.findFirst({
      where: { wellName: { equals: row.dead_well, mode: 'insensitive' } },
    });
    if (!well) { notFound.push(row.dead_well); continue; }

    if (well.apiNumber && well.apiNumber !== row.api) {
      statusMismatch.push(`${row.dead_well}: well already has api ${well.apiNumber}, csv says ${row.api} — not overwriting`);
      continue;
    }

    const apiOwner = await prisma.well.findUnique({ where: { apiNumber: row.api } });

    // The matched api already belongs to a different, real well — the
    // dead_well row is a duplicate under a messier name. Merge its history
    // onto the real well and remove the duplicate.
    if (apiOwner && apiOwner.id !== well.id) {
      console.log(`  [${row.dead_well}] MERGE -> into ${apiOwner.wellName} (${apiOwner.id})`);
      if (!dryRun) {
        await assertNoJsonArrayReferences(well.id);
        await prisma.$transaction((tx) => mergeWellInto(tx, well.id, apiOwner.id));
      }
      stats.merged++;
      continue;
    }

    const isDeactivate = row.suggested_action.startsWith('DEACTIVATE');
    const operatorId = resolveOperatorId(row.operator, companyByName);
    if (!operatorId) operatorUnresolved.push(`${row.dead_well}: operator "${row.operator}" not found in Companies`);

    console.log(`  [${row.dead_well}] -> api=${row.api} status=${row.status}${isDeactivate ? ' DEACTIVATE' : ''}${operatorId && operatorId !== well.currentOperatorId ? ` operator->${row.operator}` : ''}`);

    if (!dryRun) {
      await prisma.$transaction(async (tx) => {
        const data: Record<string, unknown> = {
          apiNumber: row.api,
          wellStatus: row.status as any,
        };
        if (isDeactivate) data.isActiveForService = false;

        if (operatorId && operatorId !== well.currentOperatorId) {
          await tx.operatorHistory.create({
            data: {
              wellId: well.id,
              previousOperatorId: well.currentOperatorId || operatorId,
              newOperatorId: operatorId,
              effectiveDate: new Date(),
              source: 'dmr_import',
              notes: `Dead-well reconciliation match (${row.confidence}, score ${row.best_score})`,
            },
          });
          data.currentOperatorId = operatorId;
        }

        await tx.well.update({ where: { id: well.id }, data });
      });
    }

    if (isDeactivate) stats.deactivated++; else stats.reconciled++;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Summary${dryRun ? ' (dry run)' : ''}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  Reconciled (kept active): ${stats.reconciled}`);
  console.log(`  Reconciled + deactivated: ${stats.deactivated}`);
  console.log(`  Merged into real well:     ${stats.merged}`);
  console.log(`  Not found in wells table:  ${notFound.length}`);
  console.log(`  Existing api mismatch:     ${statusMismatch.length}`);
  console.log(`  Operator unresolved:       ${operatorUnresolved.length}`);
  console.log(`  Held back (ambiguous):     ${ambiguousHeld.length}`);
  console.log(`  Held back (api collision): ${apiCollisionHeld.length}`);

  if (apiCollisionHeld.length) {
    console.log(`\n  Held back (multiple dead_wells -> same api, needs manual review):`);
    for (const [api, group] of byApi) {
      if (group.length > 1) console.log(`    ${api} (-> ${group[0].matched_name}): ${group.map(r => r.dead_well).join(' | ')}`);
    }
  }
  if (notFound.length) console.log(`\n  Not found:\n    ${notFound.join('\n    ')}`);
  if (statusMismatch.length) console.log(`\n  API mismatch (skipped):\n    ${statusMismatch.join('\n    ')}`);
  if (ambiguousHeld.length) console.log(`\n  Held back (ambiguous name):\n    ${ambiguousHeld.map(r => `${r.dead_well} (score ${r.best_score}, -> ${r.matched_name})`).join('\n    ')}`);
  if (operatorUnresolved.length) console.log(`\n  Operator unresolved (api/status still applied):\n    ${operatorUnresolved.join('\n    ')}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Fatal error:', e);
    prisma.$disconnect();
    process.exit(1);
  });
