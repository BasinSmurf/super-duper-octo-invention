/**
 * Strip all Pads
 *
 * Usage: npx tsx scripts/strip-pads.ts [--apply]
 *
 * Pad is no longer a first-class grouping — it's fine for every well to sit
 * pad-less until someone deliberately regroups a set of DMR-verified wells
 * through the new pad-creation flow. Well identity/history is completely
 * untouched by this script — only the pad/site grouping goes away.
 *
 * BUT: most existing service_tickets/work_points/rental_agreements only ever
 * carried a padId, never a wellId (well was never required). Nulling padId on
 * those with no backfill would leave them with NO location at all. So this
 * runs in two phases:
 *
 *   Phase 1 — backfill wellId from padId, before anything is stripped:
 *     - Pad has exactly 1 well  → derive wellId from it (unambiguous).
 *     - Pad has 0 or 2+ wells   → leave wellId null, but stamp a breadcrumb
 *       (former pad name + its well names) so the record is flagged for
 *       manual review instead of silently losing its location. ServiceTicket
 *       and WorkPoint get this in customData.formerPad; RentalAgreement has
 *       no customData column so it goes in `notes` (only ~1 row affected).
 *   Phase 2 — null every FK that points at Pad, then delete every Pad row.
 *
 * Defaults to a dry run (prints row counts only). Pass --apply to execute.
 * Take a DB snapshot first — this is a real delete, run once per environment.
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';

const APPLY = process.argv.includes('--apply');

// Every table with a column that FKs to Pad.id, mapped to { table, column }.
const PAD_FK_TABLES: Array<{ table: string; column: string }> = [
  { table: 'service_tickets', column: 'pad_id' },
  { table: 'rental_agreements', column: 'pad_id' },
  { table: 'serialized_equipment', column: 'current_pad_id' },
  { table: 'route_stops', column: 'pad_id' },
  { table: 'operator_history', column: 'pad_id' },
  { table: 'work_points', column: 'pad_id' },
  { table: 'facilities', column: 'pad_id' },
  { table: 'wells', column: 'pad_id' },
  { table: 'shop_work_orders', column: 'source_location_id' },
  { table: 'shop_work_orders', column: 'return_location_id' },
];

async function main() {
  console.log(APPLY ? 'Running with --apply — this will modify and delete data.' : 'Dry run (pass --apply to execute).');
  console.log('');

  console.log('== Phase 1: backfill wellId from padId ==');
  for (const table of ['service_tickets', 'work_points'] as const) {
    const [{ single, ambiguous }] = await prisma.$queryRawUnsafe<Array<{ single: bigint; ambiguous: bigint }>>(`
      WITH pad_wellcount AS (
        SELECT p.id AS pad_id, COUNT(w.id) AS well_count FROM pads p LEFT JOIN wells w ON w.pad_id = p.id GROUP BY p.id
      )
      SELECT
        COUNT(*) FILTER (WHERE pw.well_count = 1) AS single,
        COUNT(*) FILTER (WHERE pw.well_count <> 1) AS ambiguous
      FROM ${table} t JOIN pad_wellcount pw ON pw.pad_id = t.pad_id WHERE t.well_id IS NULL
    `);
    console.log(`${table}: ${single} to backfill (1-well pad), ${ambiguous} to flag (0 or 2+ wells)`);
  }
  const [{ single: raSingle, ambiguous: raAmbiguous }] = await prisma.$queryRawUnsafe<Array<{ single: bigint; ambiguous: bigint }>>(`
    WITH pad_wellcount AS (
      SELECT p.id AS pad_id, COUNT(w.id) AS well_count FROM pads p LEFT JOIN wells w ON w.pad_id = p.id GROUP BY p.id
    )
    SELECT
      COUNT(*) FILTER (WHERE pw.well_count = 1) AS single,
      COUNT(*) FILTER (WHERE pw.well_count <> 1) AS ambiguous
    FROM rental_agreements r JOIN pad_wellcount pw ON pw.pad_id = r.pad_id
    WHERE r.well_id IS NULL AND (r.well_ids IS NULL OR r.well_ids = '[]'::jsonb)
  `);
  console.log(`rental_agreements: ${raSingle} to backfill (1-well pad), ${raAmbiguous} to flag (0 or 2+ wells)`);

  console.log('\n== Phase 2: strip Pads ==');
  const [{ count: padCount }] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT COUNT(*) AS count FROM pads'
  );
  console.log(`pads: ${padCount} row(s) to delete`);
  for (const { table, column } of PAD_FK_TABLES) {
    const [{ count }] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IS NOT NULL`
    );
    console.log(`${table}.${column}: ${count} row(s) to null out`);
  }

  if (!APPLY) {
    console.log('\nDry run only — no changes made. Re-run with --apply to execute.');
    return;
  }

  console.log('\nApplying...');
  await prisma.$transaction(async (tx) => {
    // Phase 1a: single-well pads — unambiguous backfill.
    await tx.$executeRawUnsafe(`
      WITH single_well_pads AS (
        SELECT p.id AS pad_id, MIN(w.id) AS well_id FROM pads p JOIN wells w ON w.pad_id = p.id GROUP BY p.id HAVING COUNT(w.id) = 1
      )
      UPDATE service_tickets t SET well_id = s.well_id FROM single_well_pads s WHERE t.pad_id = s.pad_id AND t.well_id IS NULL
    `);
    await tx.$executeRawUnsafe(`
      WITH single_well_pads AS (
        SELECT p.id AS pad_id, MIN(w.id) AS well_id FROM pads p JOIN wells w ON w.pad_id = p.id GROUP BY p.id HAVING COUNT(w.id) = 1
      )
      UPDATE work_points t SET well_id = s.well_id FROM single_well_pads s WHERE t.pad_id = s.pad_id AND t.well_id IS NULL
    `);
    await tx.$executeRawUnsafe(`
      WITH single_well_pads AS (
        SELECT p.id AS pad_id, MIN(w.id) AS well_id FROM pads p JOIN wells w ON w.pad_id = p.id GROUP BY p.id HAVING COUNT(w.id) = 1
      )
      UPDATE rental_agreements r SET well_id = s.well_id, well_ids = jsonb_build_array(s.well_id)
      FROM single_well_pads s
      WHERE r.pad_id = s.pad_id AND r.well_id IS NULL AND (r.well_ids IS NULL OR r.well_ids = '[]'::jsonb)
    `);

    // Phase 1b: ambiguous (0 or 2+ wells) — breadcrumb, no guess.
    await tx.$executeRawUnsafe(`
      WITH ambiguous_pads AS (
        SELECT p.id AS pad_id, p.name AS pad_name,
               COALESCE(array_agg(w.well_name) FILTER (WHERE w.id IS NOT NULL), '{}') AS well_names
        FROM pads p LEFT JOIN wells w ON w.pad_id = p.id GROUP BY p.id, p.name HAVING COUNT(w.id) <> 1
      )
      UPDATE service_tickets t
      SET custom_data = COALESCE(t.custom_data, '{}'::jsonb) || jsonb_build_object(
        'needsWellReview', true,
        'formerPad', jsonb_build_object('name', ap.pad_name, 'wellNames', to_jsonb(ap.well_names))
      )
      FROM ambiguous_pads ap WHERE t.pad_id = ap.pad_id AND t.well_id IS NULL
    `);
    await tx.$executeRawUnsafe(`
      WITH ambiguous_pads AS (
        SELECT p.id AS pad_id, p.name AS pad_name,
               COALESCE(array_agg(w.well_name) FILTER (WHERE w.id IS NOT NULL), '{}') AS well_names
        FROM pads p LEFT JOIN wells w ON w.pad_id = p.id GROUP BY p.id, p.name HAVING COUNT(w.id) <> 1
      )
      UPDATE work_points t
      SET custom_data = COALESCE(t.custom_data, '{}'::jsonb) || jsonb_build_object(
        'needsWellReview', true,
        'formerPad', jsonb_build_object('name', ap.pad_name, 'wellNames', to_jsonb(ap.well_names))
      )
      FROM ambiguous_pads ap WHERE t.pad_id = ap.pad_id AND t.well_id IS NULL
    `);
    await tx.$executeRawUnsafe(`
      WITH ambiguous_pads AS (
        SELECT p.id AS pad_id, p.name AS pad_name
        FROM pads p LEFT JOIN wells w ON w.pad_id = p.id GROUP BY p.id, p.name HAVING COUNT(w.id) <> 1
      )
      UPDATE rental_agreements r
      SET notes = COALESCE(r.notes || E'\\n', '') || '[needs well match — was on pad ' || ap.pad_name || ']'
      FROM ambiguous_pads ap
      WHERE r.pad_id = ap.pad_id AND r.well_id IS NULL AND (r.well_ids IS NULL OR r.well_ids = '[]'::jsonb)
    `);

    // Phase 2: null every Pad FK, then delete every Pad row.
    for (const { table, column } of PAD_FK_TABLES) {
      await tx.$executeRawUnsafe(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IS NOT NULL`);
    }
    await tx.$executeRawUnsafe('DELETE FROM pads');
  }, { timeout: 120_000 });

  console.log('Done — wellId backfilled where derivable, pads table is empty, all pad references cleared.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
