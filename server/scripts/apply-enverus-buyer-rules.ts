/**
 * Apply pulled Enverus buyer-field-rules onto matching billing profiles.
 *
 * This is the "seed the boxes once" step: instead of hand-typing each buyer's
 * relabeled-field vocabulary + ADE item IDs into the profile editor, pull them
 * straight from the arbiter (via dump-enverus-buyer-rules.ts) and stamp the
 * derived config onto every CustomerBillingProfile whose buyerDuns matches.
 *
 * Reads the dump JSON produced by dump-enverus-buyer-rules.ts:
 *   { results: [ { duns, customerNames, status, body: { fieldName: rule, ... } } ] }
 * where each `rule` is { visible, editable, requiredOn?, customLabel?, ... } and
 * ADE fields appear keyed by their name with { adeField:true, itemID, adeFieldType, ... }.
 *
 * What it derives + writes (labels/structure from the arbiter — NEVER values):
 *   - lineFieldLabels   ← customLabel of afeNumber / costCenter / major / minor
 *                         (merged over any existing labels; placeholder labels
 *                          like "--" / "N/A" are skipped)
 *   - defaultAdditionalDataFields ← every adeField entry → { itemID, name,
 *                         adeFieldType, value:'' }, merged with existing rows so
 *                         already-entered values are PRESERVED by itemID and any
 *                         rows the rules no longer mention are kept (not dropped)
 *   - requiresAfe       ← afeNumber.requiredOn === 'Submit'
 *
 * It never touches the value columns (defaultMajor/Minor/Afe/CostCenter, ADF values).
 * Idempotent — safe to re-run after a fresh pull.
 *
 * Usage (dev):
 *   cd server
 *   npx tsx scripts/apply-enverus-buyer-rules.ts scripts/data/<dump>.json [--dry-run]
 *
 * Prod runs against the prod DB the same way the sales-tax backfill does (compiled
 * dist + a CJS runner, or on the host with DATABASE_URL pointing at the container DB).
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { prisma } from '../src/db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const inputFile = process.argv.slice(2).find((a) => !a.startsWith('--'));

// Standard line fields we surface on the OT submit panel (and store labels for).
const SURFACED = ['afeNumber', 'costCenter', 'major', 'minor'] as const;
// Placeholder "labels" buyers use to mean "not used" — don't show these.
const SKIP_LABELS = new Set(['', '--', 'n/a', 'na', 'none', '-']);

interface RuleEntry {
  visible?: boolean;
  editable?: boolean;
  requiredOn?: string;
  customLabel?: string;
  adeField?: boolean;
  itemID?: string;
  adeFieldType?: string;
  name?: string;
}
type RuleBody = Record<string, RuleEntry>;
interface AdfRow {
  itemID?: string;
  code?: string;
  name?: string;
  value: string;
  adeFieldType?: string;
  [k: string]: unknown;
}

function deriveLabels(body: RuleBody): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const f of SURFACED) {
    const cl = body[f]?.customLabel;
    if (cl && !SKIP_LABELS.has(String(cl).trim().toLowerCase())) {
      labels[f] = String(cl).trim();
    }
  }
  return labels;
}

function deriveAdeFields(body: RuleBody): AdfRow[] {
  return Object.entries(body)
    .filter(([, v]) => v && typeof v === 'object' && v.adeField === true && v.visible !== false && v.itemID)
    .map(([key, v]) => ({
      itemID: String(v.itemID),
      name: v.name || key,
      value: '',
      ...(v.adeFieldType ? { adeFieldType: v.adeFieldType } : {}),
    }));
}

/** Merge rule-derived ADE rows over existing ones: preserve entered values by
 *  itemID, refresh name/adeFieldType, and keep any existing rows the rules omit. */
function mergeAdf(existing: unknown, fromRules: AdfRow[]): AdfRow[] {
  const prev: AdfRow[] = Array.isArray(existing) ? (existing as AdfRow[]) : [];
  const byId = new Map(prev.filter((e) => e.itemID).map((e) => [String(e.itemID), e]));
  const used = new Set<string>();
  const out: AdfRow[] = [];
  for (const rf of fromRules) {
    const id = String(rf.itemID);
    used.add(id);
    const old = byId.get(id);
    out.push({ ...(old || {}), itemID: rf.itemID, name: rf.name, ...(rf.adeFieldType ? { adeFieldType: rf.adeFieldType } : {}), value: old?.value ?? '' });
  }
  for (const e of prev) {
    const id = e.itemID ? String(e.itemID) : null;
    if (!id || !used.has(id)) out.push(e);
  }
  return out;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function main() {
  if (!inputFile) {
    console.error('usage: tsx scripts/apply-enverus-buyer-rules.ts <dump.json> [--dry-run]');
    process.exit(1);
  }
  const parsed = JSON.parse(readFileSync(inputFile, 'utf-8'));
  const results: Array<{ duns: string; customerNames?: string[]; status: string; body?: RuleBody }> =
    Array.isArray(parsed) ? parsed : parsed.results || [];

  console.log(`[apply] ${results.length} dump entries · ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  let profilesTouched = 0;
  let profilesUnchanged = 0;
  let dunsNoProfile = 0;

  for (const r of results) {
    if (r.status !== 'ok' || !r.body || typeof r.body !== 'object') continue;
    const profiles = await prisma.customerBillingProfile.findMany({
      where: { buyerDuns: r.duns },
      select: {
        id: true, companyId: true, lineFieldLabels: true,
        defaultAdditionalDataFields: true, requiresAfe: true,
      },
    });
    if (profiles.length === 0) { dunsNoProfile++; continue; }

    const labels = deriveLabels(r.body);
    const ade = deriveAdeFields(r.body);
    const requiresAfe = r.body.afeNumber?.requiredOn === 'Submit';

    for (const p of profiles) {
      const mergedLabels = { ...((p.lineFieldLabels as Record<string, string>) || {}), ...labels };
      const newLabels = Object.keys(mergedLabels).length ? mergedLabels : null;
      const newAdf = mergeAdf(p.defaultAdditionalDataFields, ade);

      const data: Record<string, unknown> = {};
      if (!eq(newLabels, p.lineFieldLabels)) data.lineFieldLabels = newLabels;
      if (!eq(newAdf, p.defaultAdditionalDataFields)) data.defaultAdditionalDataFields = newAdf;
      if (requiresAfe !== p.requiresAfe) data.requiresAfe = requiresAfe;

      if (Object.keys(data).length === 0) { profilesUnchanged++; continue; }
      profilesTouched++;
      const name = (r.customerNames || [])[0] || r.duns;
      console.log(`\n[${DRY_RUN ? 'would update' : 'update'}] ${name} (${r.duns}) profile ${p.id}`);
      if ('lineFieldLabels' in data) console.log(`    labels      → ${JSON.stringify(newLabels)}`);
      if ('defaultAdditionalDataFields' in data) console.log(`    ade fields  → ${JSON.stringify(newAdf.map((f) => `${f.name}#${f.itemID}`))}`);
      if ('requiresAfe' in data) console.log(`    requiresAfe → ${requiresAfe}`);

      if (!DRY_RUN) {
        await prisma.customerBillingProfile.update({ where: { id: p.id }, data });
      }
    }
  }

  console.log(`\n[apply] done · ${profilesTouched} ${DRY_RUN ? 'to change' : 'updated'} · ${profilesUnchanged} unchanged · ${dunsNoProfile} dump DUNS with no matching profile`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
