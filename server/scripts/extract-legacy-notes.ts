/**
 * Extract structured data from legacy ticket freetext notes.
 *
 * Parses:
 *   - H2S gas readings (test results, monitor readings, calibrations)
 *   - LEL gas readings (calibrations, monitor readings)
 *   - Cylinder info (serial numbers, hydro dates, PSI levels, swaps)
 *   - Service names from ProductService lookup table
 *
 * Also imports TechTicketAssignment data if present in preload/.
 *
 * Run:  npx tsx scripts/extract-legacy-notes.ts [--dry-run] [--limit N]
 */

import { prisma, Prisma } from '../src/db.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';

const PRELOAD = path.resolve(__dirname, '../../preload');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.indexOf('--limit');
const LIMIT = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : 0;

// ═══════════════════════════════════════════════════════════════
//  GAS READING EXTRACTION
// ═══════════════════════════════════════════════════════════════

interface GasReading {
  type: 'h2s' | 'lel';
  value: number;
  unit: 'ppm' | '%';
  context: string;       // e.g. "casing", "tubing", "breathing zone", "treater", "separator"
  readingType: 'test' | 'calibration' | 'monitor';
}

function extractGasReadings(notes: string): GasReading[] {
  const readings: GasReading[] = [];
  if (!notes) return readings;

  // Normalize whitespace
  const text = notes.replace(/\\r\\n|\\r|\\n|\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ');

  // ── H2S test results ──
  // "H2S results were @ 3PPM", "H2S results on casing were @ 0PPM"
  // "H2s analysis result is 500ppm", "Breathing Zone H2s analysis result is 500ppm"
  const h2sTestPatterns = [
    // "H2S results on <context> were @ <N>PPM"
    /(?:(\w[\w\s]{0,30}?)\s+)?h2s\s*(?:results?|analysis\s*results?|tested?|testing\s*results?)\s*(?:on\s+([\w\s]+?)\s+)?(?:were?|was|is|=|:)?\s*(?:@|at)?\s*(-?\d+(?:\.\d+)?)\s*ppm/gi,
    // "H2S reading/level at <N>PPM"
    /h2s\s*(?:monitor\s*)?(?:reading|level|was\s*reading)\s*(?:at|@|of|=|:)?\s*(-?\d+(?:\.\d+)?)\s*ppm/gi,
  ];

  for (const pattern of h2sTestPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // Figure out which capture group has the value
      const groups = match.slice(1).filter(g => g !== undefined);
      const valueStr = groups[groups.length - 1];
      const value = parseFloat(valueStr);
      if (isNaN(value)) continue;

      // Context from preceding words
      let context = '';
      for (const g of groups.slice(0, -1)) {
        if (g && !/^\d/.test(g.trim())) {
          context = g.trim().toLowerCase();
        }
      }

      // Skip if this is actually a calibration mention
      const surroundingStart = Math.max(0, match.index - 30);
      const surrounding = text.slice(surroundingStart, match.index + match[0].length + 30).toLowerCase();
      if (/calibrat/i.test(surrounding)) continue;

      readings.push({
        type: 'h2s',
        value,
        unit: 'ppm',
        context: context || 'general',
        readingType: 'test',
      });
    }
  }

  // ── H2S calibrations ──
  // "H2S calibrated @ 25PPM", "H2S monitor calibrated at 25 PPM"
  const h2sCalPatterns = [
    /h2s\s*(?:monitor\s*)?(?:\w+\s+\w+\s+)?calibrat(?:ed|ion)\s*(?:@|at)\s*(-?\d+(?:\.\d+)?)\s*ppm/gi,
    /calibrat(?:ed|ion)\s*(?:@|at)\s*(-?\d+(?:\.\d+)?)\s*ppm\s*(?:[-–]\s*)?(?:model\s+(?:was\s+)?)?.*?h2s/gi,
  ];

  for (const pattern of h2sCalPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = parseFloat(match[1]);
      if (isNaN(value)) continue;
      readings.push({
        type: 'h2s',
        value,
        unit: 'ppm',
        context: 'calibration',
        readingType: 'calibration',
      });
    }
  }

  // ── LEL readings ──
  // "LEL CALIBRATED @ 50% LEL", "reading -14.7 LEL", "LEL calibrated @ 50%"
  const lelPatterns = [
    /lel\s*(?:monitor\s*)?calibrat(?:ed|ion)\s*(?:@|at)\s*(-?\d+(?:\.\d+)?)\s*%?\s*(?:lel)?/gi,
    /(-?\d+(?:\.\d+)?)\s*%?\s*lel/gi,
  ];

  for (const pattern of lelPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = parseFloat(match[1]);
      if (isNaN(value)) continue;
      const readingType = /calibrat/i.test(match[0]) ? 'calibration' as const : 'monitor' as const;
      readings.push({
        type: 'lel',
        value,
        unit: '%',
        context: readingType === 'calibration' ? 'calibration' : 'general',
        readingType,
      });
    }
  }

  return readings;
}

// ═══════════════════════════════════════════════════════════════
//  CYLINDER DATA EXTRACTION
// ═══════════════════════════════════════════════════════════════

interface CylinderRecord {
  serial: string;
  hydroDate: string | null;   // "MM/YYYY" normalized
  hydroUE: boolean;           // +UE = unlimited extension
  hydroStar: boolean;         // +* = star exemption
  psi: number | null;
  location: string;           // treater, tank battery, separator, etc.
  action: 'inspected' | 'installed' | 'removed' | 'noted';
}

// Common serial number pattern: alphanumeric 4+ chars, often with dashes
const SERIAL_RE = /[A-Z0-9][A-Z0-9\-]{3,}[A-Z0-9]/gi;

// Words that look like serial numbers but aren't
const SERIAL_BLACKLIST = new Set([
  'HYDRO', 'SECOND', 'NUMBER', 'CYLINDERS', 'TANKS', 'SERIAL', 'TREATER',
  'BATTERY', 'CYLINDER', 'FILLED', 'NUMBERS', 'BOTTLE', 'OTHER', 'SYSTEM',
  'NEEDS', 'INFORMATION', 'BOTTLES', 'TOPPED', 'REGULATOR', 'MISSING',
  'SEPARATOR', 'OFHYDRO', 'CORRECT', 'FAILED', 'AFTER', 'THERE', 'REFILLED',
  'STAIRS', 'STAIR', 'LOCATION', 'PRESENT', 'REPLACED', 'REPLACE', 'WOULD',
  'NOTED', 'CHECK', 'CHECKED', 'INSPECTED', 'INSPECTION', 'SAFETY', 'BASIN',
  'SIGNS', 'SIGNAGE', 'DANGER', 'SMOKING', 'REQUIRED', 'PERSONNEL', 'CHARGE',
  'INSTALLED', 'REMOVED', 'BROUGHT', 'PRESSURE', 'VALVES', 'VALVE', 'HOSES',
  'BOTH', 'ABOUT', 'THEIR', 'BEING', 'STILL', 'THESE', 'THREE', 'THOSE',
  'UNDER', 'WHERE', 'WHICH', 'WHILE', 'EVERY', 'NEVER', 'SINCE', 'UNTIL',
  'FIRST', 'FOUND', 'LEVEL', 'SHOWS', 'TOTAL', 'GOING', 'EMPTY', 'DATED',
  'RISER', 'BLOCK', 'STAND', 'MOUNT', 'BRASS', 'STEEL', 'METAL', 'SOUTH',
  'NORTH', 'WEST', 'EAST', 'OWNED', 'LOANER', 'TEMPORARY', 'PRAXAIR',
  'VICTOR', 'DRAGER', 'DETCON', 'VENTIS', 'SCBA', 'MONTHLY', 'ANNUAL',
  'MARCH', 'APRIL', 'DATES', 'TESTED', 'TESTING', 'SWAPPED',
]);

/** Returns true if value looks like a real cylinder serial number, not a word */
function isValidSerial(s: string): boolean {
  const upper = s.toUpperCase();
  if (SERIAL_BLACKLIST.has(upper)) return false;
  if (upper.length < 4) return false;
  // Pure alphabetic words (all letters) are almost never serials
  if (/^[A-Z]+$/.test(upper)) return false;
  // Must have at least one digit (real serials always do)
  if (!/\d/.test(upper)) return false;
  return true;
}

function normalizeHydroDate(raw: string): string {
  // Input formats: "08/2019", "06/20", "3/14", "Feb-2015", "2024/07", "05/2015"
  const raw2 = raw.trim().replace(/[()]/g, '');

  // "2024/07" format (year/month)
  const ym = raw2.match(/^(20\d{2})\/(0?\d{1,2})$/);
  if (ym) return `${ym[2].padStart(2, '0')}/${ym[1]}`;

  // "Feb-2015" or "May-2024"
  const monthNames: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const named = raw2.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*[-\/\s]+(\d{2,4})$/i);
  if (named) {
    const month = monthNames[named[1].toLowerCase().slice(0, 3)];
    let year = named[2];
    if (year.length === 2) year = (parseInt(year) > 50 ? '19' : '20') + year;
    return `${month}/${year}`;
  }

  // "08/2019" or "3/14" or "06/20"
  const md = raw2.match(/^(0?\d{1,2})\/(0?\d{2,4})$/);
  if (md) {
    const month = md[1].padStart(2, '0');
    let year = md[2];
    if (year.length === 2) year = (parseInt(year) > 50 ? '19' : '20') + year;
    return `${month}/${year}`;
  }

  return raw2;
}

function extractCylinderData(notes: string): CylinderRecord[] {
  const records: CylinderRecord[] = [];
  if (!notes) return records;

  const text = notes.replace(/\\r\\n|\\r|\\n|\r\n|\r|\n/g, '\n');
  const lines = text.split('\n');

  // Track context (treater, tank battery, etc.) across lines
  let currentLocation = '';
  const locationKeywords = /(treater|tank\s*battery|separator|stairs?|wellhead|pig\s*launcher|lact|compressor|vru|pump|bulk)/i;

  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (!lower) continue;

    // Update location context
    const locMatch = line.match(locationKeywords);
    if (locMatch) {
      currentLocation = locMatch[1].toLowerCase().replace(/\s+/g, ' ');
    }

    // ── Pattern 1: "Serial number # JP19S156166 with a hydro date of (08/2019)" ──
    const serialHydro1 = line.match(
      /(?:serial\s*(?:number|#|:)?\s*#?\s*|s\/n\s*|sn:\s*|cylinder\s*(?:#|number)?\s*#?\s*)([A-Z0-9][A-Z0-9\-]{3,}[A-Z0-9Y])\s*(?:with\s*(?:a\s*)?)?(?:hydro\s*(?:date\s*)?(?:of\s*)?[:\s]*|[-–]\s*)?(?:\(?\s*(\d{1,2}\/\d{2,4}|\w{3,9}[-\/]\d{2,4})\s*\)?)?/i
    );
    if (serialHydro1 && serialHydro1[1] && isValidSerial(serialHydro1[1])) {
      const hydroRaw = serialHydro1[2] || null;
      const ue = /\+\s*ue/i.test(line);
      const star = /\+\s*\*/i.test(line);
      const psiMatch = line.match(/(?:@|at|=)\s*(\d{3,4})\s*psi/i);

      records.push({
        serial: serialHydro1[1].toUpperCase(),
        hydroDate: hydroRaw ? normalizeHydroDate(hydroRaw) : null,
        hydroUE: ue,
        hydroStar: star,
        psi: psiMatch ? parseInt(psiMatch[1]) : null,
        location: currentLocation || 'unknown',
        action: /replac|swap|install|remove/i.test(line) ?
          (/removed|took\s*out/i.test(line) ? 'removed' : 'installed') : 'inspected',
      });
      continue;
    }

    // ── Pattern 2: Compact format "enk h2287 3/14+*" or "4932018y 1/14+*" ──
    // Serial followed by date followed by optional +UE or +*
    const compactPattern = /\b([A-Z]{0,4}\s?[A-Z0-9][A-Z0-9\-]{3,}[A-Z0-9Y])\s+(?:\(?(\d{1,2}\/\d{2,4})\)?)\s*(\+\s*(?:ue|\*))?/gi;
    let compactMatch;
    while ((compactMatch = compactPattern.exec(line)) !== null) {
      // Validate serial looks legit
      const serial = compactMatch[1].trim().toUpperCase();
      if (!isValidSerial(serial)) continue;

      const ue = /\+\s*ue/i.test(compactMatch[3] || '') || /\+\s*ue/i.test(line);
      const star = /\+\s*\*/i.test(compactMatch[3] || '') || /\+\s*\*/i.test(line);
      const psiMatch = line.match(/(?:@|at|=)\s*(\d{3,4})\s*psi/i);

      records.push({
        serial: serial.replace(/\s+/g, ''),
        hydroDate: normalizeHydroDate(compactMatch[2]),
        hydroUE: ue,
        hydroStar: star,
        psi: psiMatch ? parseInt(psiMatch[1]) : null,
        location: currentLocation || 'unknown',
        action: /replac|swap|install|remove/i.test(line) ?
          (/removed|took\s*out/i.test(line) ? 'removed' : 'installed') : 'inspected',
      });
    }

    // ── Pattern 3: "Hydro: MM/YYYY" or "Hydro date MM/YYYY" on same line as serial ──
    if (/hydro/i.test(line) && !records.some(r => line.includes(r.serial))) {
      const hydroDateMatch = line.match(/hydro\s*(?:date\s*)?(?:of\s*)?(?:is\s*)?[:\s-]*\(?\s*(\d{1,2}\/\d{2,4}|\w{3,9}[-\/]\d{2,4})\s*\)?/i);
      const serialsOnLine: string[] = [];
      let sm;
      const serialRe = /\b([A-Z][A-Z0-9\-]{3,}[A-Z0-9Y])\b/gi;
      while ((sm = serialRe.exec(line)) !== null) {
        if (isValidSerial(sm[1])) {
          serialsOnLine.push(sm[1].toUpperCase());
        }
      }
      if (hydroDateMatch && serialsOnLine.length > 0) {
        const ue = /\+\s*ue/i.test(line);
        const star = /\+\s*\*/i.test(line);
        for (const serial of serialsOnLine) {
          if (!records.some(r => r.serial === serial)) {
            records.push({
              serial,
              hydroDate: normalizeHydroDate(hydroDateMatch[1]),
              hydroUE: ue,
              hydroStar: star,
              psi: null,
              location: currentLocation || 'unknown',
              action: 'noted',
            });
          }
        }
      }
    }

    // ── Pattern 4: PSI-only mentions with serial ──
    if (/psi/i.test(line) && !records.some(r => line.includes(r.serial))) {
      const psiSerialPattern = /\b([A-Z0-9][A-Z0-9\-]{3,}[A-Z0-9Y])\b.*?(?:@|at|=)?\s*(\d{3,4})\s*(?:-\s*(\d{3,4})\s*)?psi/gi;
      let pm;
      while ((pm = psiSerialPattern.exec(line)) !== null) {
        const serial = pm[1].toUpperCase();
        if (!isValidSerial(serial)) continue;
        const psi = pm[3] ? parseInt(pm[3]) : parseInt(pm[2]); // If range like "500-2400psi", use the second (filled) value
        if (!records.some(r => r.serial === serial)) {
          records.push({
            serial,
            hydroDate: null,
            hydroUE: false,
            hydroStar: false,
            psi,
            location: currentLocation || 'unknown',
            action: 'inspected',
          });
        }
      }
    }
  }

  // Deduplicate by serial
  const seen = new Set<string>();
  return records.filter(r => {
    if (seen.has(r.serial)) return false;
    seen.add(r.serial);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════
//  SERVICE NAME LOOKUP (ProductService)
// ═══════════════════════════════════════════════════════════════

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function loadServiceNames(): Map<number, string> {
  const map = new Map<number, string>();
  const files = readdirSync(PRELOAD);
  const file = files.find(f => f.startsWith('ProductService') && f.endsWith('.csv'));
  if (!file) {
    console.log('  ProductService CSV not found — skipping service name resolution');
    return map;
  }

  const raw = readFileSync(path.join(PRELOAD, file), 'utf8');
  // Reassemble logical rows (handles quoted multi-line fields)
  const logicalRows: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of raw) {
    if (ch === '"') { inQuotes = !inQuotes; current += ch; }
    else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current.trim()) logicalRows.push(current);
      current = '';
    } else { current += ch; }
  }
  if (current.trim()) logicalRows.push(current);

  // Skip header
  for (let i = 1; i < logicalRows.length; i++) {
    const fields = parseCSVLine(logicalRows[i]);
    // Id(0), RefId(1), Name(2), Description(3), Price(4), ...
    const id = parseInt(fields[0], 10);
    const name = fields[2] || fields[3] || '';
    if (!isNaN(id) && name) {
      map.set(id, name);
    }
  }

  console.log(`  Service names loaded: ${map.size} entries`);
  return map;
}

// ═══════════════════════════════════════════════════════════════
//  TECH ASSIGNMENT IMPORT
// ═══════════════════════════════════════════════════════════════

function loadTechAssignments(): Map<number, string[]> {
  const map = new Map<number, string[]>();
  const files = readdirSync(PRELOAD);
  const file = files.find(f => f.startsWith('TechTicketAssignment') && f.endsWith('.csv'));
  if (!file) return map;

  const raw = readFileSync(path.join(PRELOAD, file), 'utf8');
  const lines = raw.split('\n').slice(1); // skip header

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    const ticketId = parseInt(parts[2]?.replace(/"/g, ''), 10);
    const isDeleted = parts[7]?.replace(/"/g, '').trim();
    if (isDeleted === '1') continue;
    const userName = parts[6]?.replace(/"/g, '').trim();
    if (isNaN(ticketId) || !userName) continue;

    if (!map.has(ticketId)) map.set(ticketId, []);
    const existing = map.get(ticketId)!;
    if (!existing.includes(userName)) existing.push(userName);
  }

  console.log(`  Tech assignments loaded: ${map.size} tickets with assigned techs`);
  return map;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n=== Extract Legacy Ticket Notes ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${LIMIT ? ` | Limit: ${LIMIT}` : ''}\n`);

  // Load lookups
  console.log('Step 1a: Loading service names...');
  const serviceNames = loadServiceNames();

  console.log('Step 1b: Loading tech assignments...');
  const techAssignments = loadTechAssignments();

  // Fetch legacy tickets with notes
  console.log('Step 2: Fetching legacy tickets...');
  const tickets = await prisma.serviceTicket.findMany({
    where: {
      ticketNumber: { startsWith: 'LGC-' },
      ...(LIMIT ? {} : {}),
    },
    select: {
      id: true,
      ticketNumber: true,
      workDescription: true,
      customData: true,
    },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`  Fetched ${tickets.length} legacy tickets`);

  // Extract and update
  console.log('Step 3: Extracting structured data from notes...\n');
  let updated = 0, errors = 0;
  let totalGasReadings = 0, totalCylinders = 0, totalTechAssigned = 0;
  let ticketsWithGas = 0, ticketsWithCylinders = 0, ticketsWithTechs = 0;

  const BATCH = 200;
  for (let i = 0; i < tickets.length; i += BATCH) {
    const batch = tickets.slice(i, i + BATCH);
    const updates: Array<{ id: string; customData: any }> = [];

    for (const ticket of batch) {
      const cd = (ticket.customData as any) || {};
      const azureTicketId = cd.azureTicketId;
      let changed = false;

      // Always clear previous extractions so re-runs don't accumulate stale data
      const hadGas = !!cd.gasReadings;
      const hadCyl = !!cd.cylinderData;
      delete cd.gasReadings;
      delete cd.cylinderData;

      // Extract gas readings
      const gasReadings = extractGasReadings(ticket.workDescription || '');
      if (gasReadings.length > 0) {
        cd.gasReadings = gasReadings;
        totalGasReadings += gasReadings.length;
        ticketsWithGas++;
        changed = true;
      } else if (hadGas) {
        changed = true;  // Need to persist the deletion
      }

      // Extract cylinder data
      const cylinderData = extractCylinderData(ticket.workDescription || '');
      if (cylinderData.length > 0) {
        cd.cylinderData = cylinderData;
        totalCylinders += cylinderData.length;
        ticketsWithCylinders++;
        changed = true;
      } else if (hadCyl) {
        changed = true;  // Need to persist the deletion
      }

      // Add tech assignments
      if (azureTicketId && techAssignments.has(azureTicketId)) {
        const techs = techAssignments.get(azureTicketId)!;
        cd.legacyTechs = techs;
        ticketsWithTechs++;
        totalTechAssigned++;
        changed = true;
      }

      if (changed) {
        updates.push({ id: ticket.id, customData: cd });
      }
    }

    // Batch update
    if (!DRY_RUN && updates.length > 0) {
      for (const upd of updates) {
        try {
          await prisma.serviceTicket.update({
            where: { id: upd.id },
            data: { customData: upd.customData as any },
          });
          updated++;
        } catch (e: any) {
          errors++;
          if (errors <= 5) console.error(`  Error updating ${upd.id}: ${e.message.slice(0, 200)}`);
        }
      }
    } else if (DRY_RUN) {
      updated += updates.length;
    }

    const pct = Math.round(((i + batch.length) / tickets.length) * 100);
    process.stdout.write(`\r  Progress: ${pct}% (${updated} updated, ${errors} errors)`);
  }

  console.log('\n');

  // ── Step 4: Update line item descriptions with service names ──
  let lineItemsUpdated = 0, lineItemErrors = 0;
  if (serviceNames.size > 0) {
    console.log('Step 4: Updating line item descriptions with service names...');

    // Fetch all legacy line items with "Legacy service #N" descriptions
    const legacyItems = await prisma.ticketLineItem.findMany({
      where: { description: { startsWith: 'Legacy service #' } },
      select: { id: true, description: true, customData: true },
    });
    console.log(`  Legacy line items to update: ${legacyItems.length}`);

    const LI_BATCH = 500;
    for (let i = 0; i < legacyItems.length; i += LI_BATCH) {
      const batch = legacyItems.slice(i, i + LI_BATCH);

      for (const item of batch) {
        const cd = (item.customData as any) || {};
        const serviceId = cd.azureServiceId;
        if (serviceId == null) continue;

        const name = serviceNames.get(serviceId);
        if (!name) continue;

        if (!DRY_RUN) {
          try {
            await prisma.ticketLineItem.update({
              where: { id: item.id },
              data: { description: name },
            });
            lineItemsUpdated++;
          } catch (e: any) {
            lineItemErrors++;
            if (lineItemErrors <= 5) console.error(`  Line item error: ${e.message.slice(0, 200)}`);
          }
        } else {
          lineItemsUpdated++;
        }
      }

      const pct = Math.round(((i + batch.length) / legacyItems.length) * 100);
      process.stdout.write(`\r  Progress: ${pct}% (${lineItemsUpdated} updated)`);
    }
    console.log('');
  }

  console.log('\n=== Extraction Summary ===');
  console.log(`Tickets updated:          ${updated}`);
  console.log(`Errors:                   ${errors}`);
  console.log(`─── Gas Readings ───`);
  console.log(`  Tickets with readings:  ${ticketsWithGas}`);
  console.log(`  Total readings found:   ${totalGasReadings}`);
  console.log(`─── Cylinder Data ───`);
  console.log(`  Tickets with cylinders: ${ticketsWithCylinders}`);
  console.log(`  Total cylinders found:  ${totalCylinders}`);
  console.log(`─── Tech Assignments ───`);
  console.log(`  Tickets with techs:     ${ticketsWithTechs}`);
  console.log(`─── Service Names ───`);
  console.log(`  Line items updated:     ${lineItemsUpdated}`);
  console.log(`  Line item errors:       ${lineItemErrors}`);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  prisma.$disconnect();
  process.exit(1);
});
