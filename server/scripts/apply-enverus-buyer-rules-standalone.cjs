/**
 * Self-contained version of apply-enverus-buyer-rules.ts.
 *
 * SAME logic, but NO project imports and NO Prisma — talks to Postgres via the
 * `pg` driver directly (which is present in the prod container as a transitive
 * dep of @prisma/adapter-pg). Runs under plain `node` (no tsx needed), so it
 * works inside the pruned prod container where src/ + the generated Prisma
 * client aren't shipped and the host node_modules is stale.
 *
 * It stamps arbiter-derived structure onto every customer_billing_profiles row
 * whose buyer_duns matches a dump entry — NEVER values:
 *   - line_field_labels            ← customLabel of afeNumber/costCenter/major/minor
 *   - default_additional_data_fields ← every adeField entry → {itemID,name,adeFieldType,value:''},
 *                                      merged (existing values preserved by itemID, omitted rows kept)
 *   - requires_afe                 ← afeNumber.requiredOn === 'Submit'
 * Idempotent. Supports --dry-run.
 *
 * Usage inside the prod container (DATABASE_URL already in container env):
 *   docker cp scripts/apply-enverus-buyer-rules-standalone.cjs servicepro-api:/tmp/apply.cjs
 *   docker cp scripts/data/<dump>.json servicepro-api:/tmp/dump.json
 *   docker exec servicepro-api node /tmp/apply.cjs /tmp/dump.json --dry-run
 *   docker exec servicepro-api node /tmp/apply.cjs /tmp/dump.json          # live
 *
 * Or anywhere `pg` resolves, with an explicit connection string:
 *   DATABASE_URL='postgresql://user:pass@host:5432/db' node apply.cjs dump.json --dry-run
 */

const { readFileSync } = require('fs');
const { Client } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const inputFile = process.argv.slice(2).find((a) => !a.startsWith('--'));

const SURFACED = ['afeNumber', 'costCenter', 'major', 'minor'];
const SKIP_LABELS = new Set(['', '--', 'n/a', 'na', 'none', '-']);

function deriveLabels(body) {
  const labels = {};
  for (const f of SURFACED) {
    const cl = body[f] && body[f].customLabel;
    if (cl && !SKIP_LABELS.has(String(cl).trim().toLowerCase())) {
      labels[f] = String(cl).trim();
    }
  }
  return labels;
}

function deriveAdeFields(body) {
  return Object.entries(body)
    .filter(([, v]) => v && typeof v === 'object' && v.adeField === true && v.visible !== false && v.itemID)
    .map(([key, v]) => ({
      itemID: String(v.itemID),
      name: v.name || key,
      value: '',
      ...(v.adeFieldType ? { adeFieldType: v.adeFieldType } : {}),
    }));
}

function mergeAdf(existing, fromRules) {
  const prev = Array.isArray(existing) ? existing : [];
  const byId = new Map(prev.filter((e) => e.itemID).map((e) => [String(e.itemID), e]));
  const used = new Set();
  const out = [];
  for (const rf of fromRules) {
    const id = String(rf.itemID);
    used.add(id);
    const old = byId.get(id);
    out.push({ ...(old || {}), itemID: rf.itemID, name: rf.name, ...(rf.adeFieldType ? { adeFieldType: rf.adeFieldType } : {}), value: (old && old.value) || '' });
  }
  for (const e of prev) {
    const id = e.itemID ? String(e.itemID) : null;
    if (!id || !used.has(id)) out.push(e);
  }
  return out;
}

function eq(a, b) {
  return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
}

async function main() {
  if (!inputFile) {
    console.error('usage: node apply-enverus-buyer-rules-standalone.cjs <dump.json> [--dry-run]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const parsed = JSON.parse(readFileSync(inputFile, 'utf-8'));
  const results = Array.isArray(parsed) ? parsed : parsed.results || [];

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`[apply] ${results.length} dump entries · ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  let profilesTouched = 0;
  let profilesUnchanged = 0;
  let dunsNoProfile = 0;

  try {
    for (const r of results) {
      if (r.status !== 'ok' || !r.body || typeof r.body !== 'object') continue;

      const { rows: profiles } = await client.query(
        'SELECT id, company_id, line_field_labels, default_additional_data_fields, requires_afe FROM customer_billing_profiles WHERE buyer_duns = $1',
        [r.duns],
      );
      if (profiles.length === 0) { dunsNoProfile++; continue; }

      const labels = deriveLabels(r.body);
      const ade = deriveAdeFields(r.body);
      const requiresAfe = r.body.afeNumber && r.body.afeNumber.requiredOn === 'Submit';

      for (const p of profiles) {
        const mergedLabels = { ...(p.line_field_labels || {}), ...labels };
        const newLabels = Object.keys(mergedLabels).length ? mergedLabels : null;
        const newAdf = mergeAdf(p.default_additional_data_fields, ade);

        const sets = [];
        const vals = [];
        if (!eq(newLabels, p.line_field_labels)) { vals.push(JSON.stringify(newLabels)); sets.push(`line_field_labels = $${vals.length}::jsonb`); }
        if (!eq(newAdf, p.default_additional_data_fields)) { vals.push(JSON.stringify(newAdf)); sets.push(`default_additional_data_fields = $${vals.length}::jsonb`); }
        if (requiresAfe !== p.requires_afe) { vals.push(requiresAfe); sets.push(`requires_afe = $${vals.length}`); }

        if (sets.length === 0) { profilesUnchanged++; continue; }
        profilesTouched++;
        const name = (r.customerNames || [])[0] || r.duns;
        console.log(`\n[${DRY_RUN ? 'would update' : 'update'}] ${name} (${r.duns}) profile ${p.id}`);
        if (sets.some((s) => s.startsWith('line_field_labels'))) console.log(`    labels      → ${JSON.stringify(newLabels)}`);
        if (sets.some((s) => s.startsWith('default_additional_data_fields'))) console.log(`    ade fields  → ${JSON.stringify(newAdf.map((f) => `${f.name}#${f.itemID}`))}`);
        if (sets.some((s) => s.startsWith('requires_afe'))) console.log(`    requiresAfe → ${requiresAfe}`);

        if (!DRY_RUN) {
          vals.push(p.id);
          await client.query(`UPDATE customer_billing_profiles SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
        }
      }
    }
  } finally {
    await client.end();
  }

  console.log(`\n[apply] done · ${profilesTouched} ${DRY_RUN ? 'to change' : 'updated'} · ${profilesUnchanged} unchanged · ${dunsNoProfile} dump DUNS with no matching profile`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
