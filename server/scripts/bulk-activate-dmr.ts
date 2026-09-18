/**
 * Bulk Activate DMR Reference Wells
 *
 * Usage: npx tsx scripts/bulk-activate-dmr.ts [--dry-run] [--status A,IA] [--operator "continental"]
 *
 * Filters dmr_reference_wells by:
 *   1. Operator name matches a known company (via alias map)
 *   2. Well status is in allowed list (default: active statuses)
 *   3. Not already activated (matchedWellId IS NULL)
 *
 * Then creates fields, pads, and wells — grouping wells into pads by
 * wellNameBase + section-township-range + lat/lon proximity (25 ft).
 *
 * Finally re-links orphaned route stops to newly created pads.
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';


// ============================================================
// Operator alias map: DMR operatorName → Sundog company name
// This is the authoritative mapping. Add entries as needed.
// ============================================================
const OPERATOR_ALIASES: Record<string, string> = {
  // ND operators
  'CONTINENTAL RESOURCES, INC.':        'Continental Resources, Inc',
  'Continental Resources Inc':          'Continental Resources, Inc',
  'HESS CORPORATION':                   'Hess Bakken Investments',
  'HESS BAKKEN INVESTMENTS II, LLC':    'Hess Bakken Investments',
  'EOG RESOURCES, INC.':                'EOG Resources Inc.',
  'PETRO-HUNT, L.L.C.':                'Petro-Hunt, LLC',
  'PETRO-HUNT DAKOTA, LLC':             'Petro-Hunt Dakota, LLC',
  'XTO ENERGY INC':                     'XTO Energy Inc',
  'KRAKEN OPERATING, LLC':              'Kraken Oil & Gas',
  'KODA RESOURCES OPERATING, LLC':      'KODA Resources LLC',
  'NEPTUNE OPERATING LLC':              'Neptune Operating LLC - Kraken',
  'HYDRA SERVICES LLC':                 'Hydra Services LLC - Kraken',
  'WHITING OIL AND GAS CORPORATION':    'Whiting Petroleum',
  'OASIS PETROLEUM NORTH AMERICA LLC':  'Oasis Petroleum',
  'MARATHON OIL COMPANY':               'Marathon Oil',
  'DEVON ENERGY WILLISTON, L.L.C':      'Devon Energy Production Company',
  'ENERPLUS RESOURCES USA CORPORATION': 'Enerplus Resources Corporation',
  'HUNT OIL COMPANY':                   'Hunt Energy Company',
  'SLAWSON EXPLORATION COMPANY, INC.':  'Slawson Exploration',
  'SPOTTED HAWK DEVELOPMENT, LLC':      'Spotted Hawk Development LLC',
  'RAGNAR EXPLORATION, LLC':            'Ragnar Exploration, LLC',
  'BURLINGTON RESOURCES OIL & GAS COMPANY LP': 'ConocoPhillips',
  'WHITE ROCK OIL & GAS, LLC':         'White Rock Oil & Gas',
  'SAMSON OIL AND GAS USA, INC':        'Samson Resources',
  'SCOUT ENERGY MANAGEMENT LLC':        'Scout Energy',
  'FOUNDATION ENERGY MANAGEMENT, LLC':  'Foundation Energy',
  // MT operators
  'Kraken Operating, LLC':              'Kraken Oil & Gas',
  'Continental Resources Inc':          'Continental Resources, Inc',
  'MorningStar Operating LLC':          'MorningStar Operating',
};

// Default: "active" well statuses to import
const DEFAULT_STATUSES = ['A', 'IA', 'Producing', 'Active Injection', 'Completed', 'Shut In', 'OG'];

// 1000 feet proximity for initial pad grouping (approximate at ND latitude ~47°N)
// Wells sharing name+STR within 1000ft are very likely on the same pad site.
// Tighter grouping (25-50ft) can be done in the UI for fine-tuning.
// 1 degree latitude ≈ 364,000 feet → 1000ft ≈ 0.00275
// 1 degree longitude at 47°N ≈ 248,000 feet → 1000ft ≈ 0.00403
const PROXIMITY_LAT = 0.00275;
const PROXIMITY_LON = 0.00403;

// ============================================================
// Well Type / Status enum mappings
// DMR reference wells may have descriptive strings (MT) or codes (ND).
// These maps normalize to Prisma WellType / WellStatus enum values.
// ============================================================
const WELL_TYPE_MAP: Record<string, string> = {
  // ND codes (already valid)
  'OG': 'OG', 'SWD': 'SWD', 'WI': 'WI', 'GASD': 'GASD', 'ST': 'ST',
  'GASC': 'GASC', 'WS': 'WS', 'CO2I': 'CO2I', 'AI': 'AI', 'GI': 'GI',
  // MT descriptive values
  'Oil': 'OG', 'Oil & Gas': 'OG', 'Gas': 'OG',
  'Dry Hole': 'OG',
  'Injection, EOR': 'WI', 'Injection - EOR': 'WI',
  'Injection - Disposal': 'SWD', 'Injection, Disposal': 'SWD',
  'Water Source': 'WS',
  'Stratigraphic Test': 'ST', 'Strat Test': 'ST',
  'Gas Storage': 'GASC',
};

const WELL_STATUS_MAP: Record<string, string> = {
  // ND codes (already valid)
  'A': 'A', 'DRY': 'DRY', 'PA': 'PA', 'PNC': 'PNC', 'IA': 'IA',
  'Confidential': 'Confidential', 'AB': 'AB', 'LOC': 'LOC', 'DRL': 'DRL', 'TA': 'TA',
  // MT descriptive values
  'Producing': 'A',
  'Active Injection': 'A',
  'Completed': 'A',
  'Shut In': 'IA',
  'P&A - Approved': 'PA',
  'P&A - Unapproved': 'PA',
  'Spudded': 'DRL',
  'Drilling': 'DRL',
  'Permit to Drill': 'LOC',
  'Temporarily Abandoned': 'TA',
  'Abandoned - Unapproved': 'AB',
  'Expired, Not Released': 'other',
  'Permitted Injection Well': 'LOC',
  'Other': 'other',
};

function mapWellType(raw: string | null): string | undefined {
  if (!raw) return undefined;
  return WELL_TYPE_MAP[raw] || WELL_TYPE_MAP[raw.trim()] || 'other';
}

function mapWellStatus(raw: string | null): string | undefined {
  if (!raw) return undefined;
  return WELL_STATUS_MAP[raw] || WELL_STATUS_MAP[raw.trim()] || 'other';
}

// ============================================================
// Helpers
// ============================================================

function parseWellNameBase(wellName: string | null): string {
  if (!wellName) return 'Unknown';
  // Strip trailing numbers, dashes, and well number patterns
  // "JERSEY 1-6H" → "JERSEY", "FAIRBANKS 21X-35H2" → "FAIRBANKS"
  const base = wellName.replace(/[\s-]+\d+.*$/, '').trim();
  return base || wellName;
}

function padGroupKey(operatorId: string, wellNameBase: string, section: number | null, township: number | null, range: number | null): string {
  return `${operatorId}|${wellNameBase.toUpperCase()}|${section ?? '?'}-${township ?? '?'}-${range ?? '?'}`;
}

function isWithinProximity(lat1: number, lon1: number, lat2: number, lon2: number): boolean {
  return Math.abs(lat1 - lat2) <= PROXIMITY_LAT && Math.abs(lon1 - lon2) <= PROXIMITY_LON;
}

// Check if a well fits into an existing pad group by proximity
function fitsInGroup(well: { latitude: number | null; longitude: number | null },
                     group: { latitude: number | null; longitude: number | null }[]): boolean {
  if (!well.latitude || !well.longitude) return true; // no coords = assume fits
  if (group.length === 0) return true;
  // Must be within 25ft of at least one well in the group
  for (const member of group) {
    if (!member.latitude || !member.longitude) continue;
    if (isWithinProximity(well.latitude, well.longitude, member.latitude, member.longitude)) {
      return true;
    }
  }
  // If no group members have coords, assume fits
  return group.every(m => !m.latitude || !m.longitude);
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const statusArg = args.find(a => a.startsWith('--status'));
  const operatorArg = args.find(a => a.startsWith('--operator'));

  const allowedStatuses = statusArg
    ? statusArg.split('=')[1]?.split(',').map(s => s.trim()) || DEFAULT_STATUSES
    : DEFAULT_STATUSES;

  const operatorFilter = operatorArg
    ? operatorArg.split('=')[1]?.replace(/"/g, '').trim().toLowerCase()
    : null;

  console.log(`Bulk DMR Activation${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`  Allowed statuses: ${allowedStatuses.join(', ')}`);
  if (operatorFilter) console.log(`  Operator filter: ${operatorFilter}`);

  // ---- Step 1: Resolve operator aliases to company IDs ----
  const companies = await prisma.company.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });
  const companyByName = new Map(companies.map(c => [c.name, c.id]));

  const resolvedAliases: Map<string, { companyId: string; companyName: string }> = new Map();
  let unmatchedOperators = 0;

  for (const [dmrName, sundogName] of Object.entries(OPERATOR_ALIASES)) {
    if (operatorFilter && !dmrName.toLowerCase().includes(operatorFilter)) continue;
    const companyId = companyByName.get(sundogName);
    if (companyId) {
      resolvedAliases.set(dmrName, { companyId, companyName: sundogName });
    } else {
      console.warn(`  WARNING: Alias "${dmrName}" → "${sundogName}" — company not found in DB`);
      unmatchedOperators++;
    }
  }

  console.log(`  Resolved aliases: ${resolvedAliases.size} operators → companies`);
  if (unmatchedOperators > 0) console.log(`  Unmatched aliases: ${unmatchedOperators}`);

  // ---- Step 2: Query unactivated DMR wells matching operators + status ----
  const dmrOperatorNames = [...resolvedAliases.keys()];
  if (dmrOperatorNames.length === 0) {
    console.log('No operators matched. Nothing to do.');
    return;
  }

  const dmrWells = await prisma.dmrReferenceWell.findMany({
    where: {
      matchedWellId: null,
      operatorName: { in: dmrOperatorNames },
      wellStatus: { in: allowedStatuses },
    },
    orderBy: [{ operatorName: 'asc' }, { wellName: 'asc' }],
  });

  console.log(`  DMR wells to process: ${dmrWells.length}`);
  if (dmrWells.length === 0) {
    console.log('No wells to activate. Done.');
    return;
  }

  // ---- Step 3: Check for existing wells by API number (skip dupes) ----
  const existingWells = await prisma.well.findMany({
    where: { apiNumber: { in: dmrWells.map(w => w.apiNumber) } },
    select: { apiNumber: true, id: true, padId: true },
  });
  const existingByApi = new Map(existingWells.map(w => [w.apiNumber, w]));
  const alreadyExist = existingWells.length;
  console.log(`  Already exist in wells table (will skip): ${alreadyExist}`);

  // ---- Step 4: Group into pads ----
  // Key: padGroupKey → wells in that group
  const padGroups: Map<string, {
    wellNameBase: string;
    operatorId: string;
    companyName: string;
    section: number | null;
    township: number | null;
    range: number | null;
    fieldName: string | null;
    county: string | null;
    wells: typeof dmrWells;
  }> = new Map();

  let skippedExisting = 0;
  let skippedProximity = 0;
  const proximityOrphans: typeof dmrWells = [];

  for (const well of dmrWells) {
    // Skip if well already exists in operational table
    if (existingByApi.has(well.apiNumber)) {
      skippedExisting++;
      continue;
    }

    const alias = resolvedAliases.get(well.operatorName!);
    if (!alias) continue; // shouldn't happen but safety check

    const wnBase = parseWellNameBase(well.wellName);
    const key = padGroupKey(alias.companyId, wnBase, well.section, well.township, well.range);

    if (!padGroups.has(key)) {
      padGroups.set(key, {
        wellNameBase: wnBase,
        operatorId: alias.companyId,
        companyName: alias.companyName,
        section: well.section,
        township: well.township,
        range: well.range,
        fieldName: well.fieldName,
        county: well.county,
        wells: [],
      });
    }

    const group = padGroups.get(key)!;
    const lat = well.latitude ? Number(well.latitude) : null;
    const lon = well.longitude ? Number(well.longitude) : null;
    const wellCoords = { latitude: lat, longitude: lon };
    const groupCoords = group.wells.map(w => ({
      latitude: w.latitude ? Number(w.latitude) : null,
      longitude: w.longitude ? Number(w.longitude) : null,
    }));

    if (fitsInGroup(wellCoords, groupCoords)) {
      group.wells.push(well);
    } else {
      // Doesn't fit proximity — put in its own pad (append suffix)
      skippedProximity++;
      const soloKey = `${key}|solo-${well.apiNumber}`;
      padGroups.set(soloKey, {
        wellNameBase: well.wellName || wnBase,
        operatorId: alias.companyId,
        companyName: alias.companyName,
        section: well.section,
        township: well.township,
        range: well.range,
        fieldName: well.fieldName,
        county: well.county,
        wells: [well],
      });
      proximityOrphans.push(well);
    }
  }

  console.log(`  Pad groups formed: ${padGroups.size}`);
  console.log(`  Wells split by proximity: ${skippedProximity}`);

  // ---- Step 5: Create fields, pads, wells ----
  const stats = {
    fieldsCreated: 0,
    fieldsReused: 0,
    padsCreated: 0,
    padsReused: 0,
    wellsCreated: 0,
    wellsSkipped: skippedExisting,
    dmrUpdated: 0,
  };

  // Cache fields and pads to avoid repeated lookups
  const fieldCache: Map<string, string> = new Map(); // fieldName|state → fieldId
  const padCache: Map<string, string> = new Map(); // padName|operatorId → padId

  // Pre-load existing fields
  const existingFields = await prisma.field.findMany({ select: { id: true, name: true, state: true } });
  for (const f of existingFields) {
    fieldCache.set(`${f.name.toLowerCase()}|${(f.state || 'ND').toUpperCase()}`, f.id);
  }

  // Pre-load existing pads
  const existingPads = await prisma.pad.findMany({
    where: { isActive: true },
    select: { id: true, name: true, currentOperatorId: true },
  });
  for (const p of existingPads) {
    if (p.currentOperatorId) {
      padCache.set(`${p.name.toLowerCase()}|${p.currentOperatorId}`, p.id);
    }
  }

  let processed = 0;
  const totalGroups = padGroups.size;

  for (const [_key, group] of padGroups) {
    processed++;
    if (processed % 200 === 0) {
      console.log(`  Processing group ${processed}/${totalGroups}...`);
    }

    const state = 'ND'; // Default — could be derived from API prefix
    const fieldKey = `${(group.fieldName || 'Unknown').toLowerCase()}|${state}`;

    // Find or create field
    let fieldId = fieldCache.get(fieldKey);
    if (!fieldId) {
      if (dryRun) {
        fieldId = `dry-run-field-${fieldKey}`;
        stats.fieldsCreated++;
      } else {
        // Try case-insensitive match first
        const existing = await prisma.field.findFirst({
          where: { name: { equals: group.fieldName || 'Unknown', mode: 'insensitive' } },
        });
        if (existing) {
          fieldId = existing.id;
          stats.fieldsReused++;
        } else {
          const created = await prisma.field.create({
            data: {
              name: group.fieldName || 'Unknown',
              county: group.county || null,
              state,
            },
          });
          fieldId = created.id;
          stats.fieldsCreated++;
        }
      }
      fieldCache.set(fieldKey, fieldId);
    } else {
      stats.fieldsReused++;
    }

    // Find or create pad
    const padKey = `${group.wellNameBase.toLowerCase()}|${group.operatorId}`;
    let padId = padCache.get(padKey);
    if (!padId) {
      if (dryRun) {
        padId = `dry-run-pad-${padKey}`;
        stats.padsCreated++;
      } else {
        // Try to find existing pad by name + operator
        const existing = await prisma.pad.findFirst({
          where: {
            name: { equals: group.wellNameBase, mode: 'insensitive' },
            currentOperatorId: group.operatorId,
            isActive: true,
          },
        });
        if (existing) {
          padId = existing.id;
          stats.padsReused++;
        } else {
          // Use first well's coords for pad lat/lon
          const firstWithCoords = group.wells.find(w => w.latitude && w.longitude);
          const created = await prisma.pad.create({
            data: {
              name: group.wellNameBase,
              fieldId,
              currentOperatorId: group.operatorId,
              section: group.section,
              township: group.township,
              range: group.range,
              latitude: firstWithCoords?.latitude || null,
              longitude: firstWithCoords?.longitude || null,
              county: group.county,
              autoGenerated: true,
              pendingReview: false,
            },
          });
          padId = created.id;
          stats.padsCreated++;
        }
      }
      padCache.set(padKey, padId);
    } else {
      stats.padsReused++;
    }

    // Create wells
    for (const dmrWell of group.wells) {
      if (existingByApi.has(dmrWell.apiNumber)) continue;

      if (dryRun) {
        stats.wellsCreated++;
        continue;
      }

      try {
        const well = await prisma.well.create({
          data: {
            fieldId,
            padId,
            currentOperatorId: group.operatorId,
            dmrFileNumber: dmrWell.dmrFileNumber,
            apiNumber: dmrWell.apiNumber,
            apiShort: dmrWell.apiShort,
            wellName: dmrWell.wellName,
            wellNameBase: dmrWell.wellNameBase,
            totalDepth: dmrWell.totalDepth,
            spudDate: dmrWell.spudDate,
            quarterQuarter: dmrWell.quarterQuarter,
            section: dmrWell.section,
            township: dmrWell.township,
            range: dmrWell.range,
            feetNs: dmrWell.feetNs,
            nsLine: dmrWell.nsLine,
            feetEw: dmrWell.feetEw,
            ewLine: dmrWell.ewLine,
            latitude: dmrWell.latitude,
            longitude: dmrWell.longitude,
            wellType: (mapWellType(dmrWell.wellType) as any) || undefined,
            wellStatus: (mapWellStatus(dmrWell.wellStatus) as any) || undefined,
            county: dmrWell.county,
            dmrReferenceId: dmrWell.id,
            dmrImportDate: new Date(),
            dmrRawData: dmrWell.rawData || undefined,
          },
        });

        // Update DMR reference
        await prisma.dmrReferenceWell.update({
          where: { id: dmrWell.id },
          data: { matchedWellId: well.id, matchedCompanyId: group.operatorId },
        });

        stats.wellsCreated++;
        stats.dmrUpdated++;
      } catch (e: any) {
        // Likely duplicate API number — skip
        if (e.code === 'P2002') {
          stats.wellsSkipped++;
        } else {
          console.error(`  Error creating well ${dmrWell.apiNumber}: ${e.message}`);
        }
      }
    }
  }

  // ---- Step 6: Re-link route stops ----
  let routeStopsLinked = 0;
  if (!dryRun) {
    // Build company alias map for route stops (route company → pad company)
    const routeCompanyAliases: [string, string][] = [
      ['EOG Resources', 'EOG Resources Inc.'],
      ['Petro-Hunt', 'Petro-Hunt, LLC'],
      ['XTO Energy', 'XTO Energy Inc'],
      ['Continental Resources', 'Continental Resources, Inc'],
      ['Petro-Hunt Dakota', 'Petro-Hunt Dakota, LLC'],
      ['NextEra Energy', 'NextEra Energy Resources'],
      ['KODA Resources', 'KODA Resources LLC'],
      ['Neptune Operating', 'Neptune Operating LLC - Kraken'],
      ['Spotted Hawk Development', 'Spotted Hawk Development LLC'],
      ['Ragnar Exploration', 'Ragnar Exploration, LLC'],
      ['Hess Corporation', 'Hess Bakken Investments'],
      ['Hess Midstream', 'Hess Bakken Investments'],
      ['Hydra Services', 'Hydra Services LLC - Kraken'],
      ['Goodnight Midstream', 'Goodnight Midstream'],
      ['Kraken Oil & Gas', 'Kraken Oil & Gas'],
    ];

    for (const [routeCo, padCo] of routeCompanyAliases) {
      const result = await prisma.$executeRawUnsafe(`
        UPDATE route_stops SET pad_id = sub.pad_id
        FROM (
          SELECT DISTINCT ON (rs.id) rs.id as stop_id, p.id as pad_id
          FROM route_stops rs
          JOIN service_routes sr ON rs.route_id = sr.id
          JOIN companies c_route ON sr.company_id = c_route.id
          JOIN companies c_pad ON c_pad.name = $1
          JOIN pads p ON p.current_operator_id = c_pad.id AND p.is_active = true
            AND p.name ILIKE rs.client_name
          WHERE rs.is_active = true AND rs.pad_id IS NULL
          AND c_route.name = $2
        ) sub
        WHERE route_stops.id = sub.stop_id
      `, padCo, routeCo);
      routeStopsLinked += result as number;
    }
  }

  // ---- Summary ----
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Bulk Activation ${dryRun ? '(DRY RUN) ' : ''}Summary`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  Operators matched:     ${resolvedAliases.size}`);
  console.log(`  DMR wells processed:   ${dmrWells.length}`);
  console.log(`  Fields created:        ${stats.fieldsCreated} (reused: ${stats.fieldsReused})`);
  console.log(`  Pads created:          ${stats.padsCreated} (reused: ${stats.padsReused})`);
  console.log(`  Wells created:         ${stats.wellsCreated}`);
  console.log(`  Wells skipped (exist): ${stats.wellsSkipped}`);
  console.log(`  DMR refs updated:      ${stats.dmrUpdated}`);
  console.log(`  Route stops linked:    ${routeStopsLinked}`);
  if (skippedProximity > 0) {
    console.log(`  Proximity splits:      ${skippedProximity}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Fatal error:', e);
    prisma.$disconnect();
    process.exit(1);
  });
