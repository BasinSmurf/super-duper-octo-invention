/**
 * Extract structured gas readings and cylinder data from ticket notes.
 *
 * Used by:
 *   - POST /api/tickets (REST create)
 *   - PUT /api/tickets/:id (REST update)
 *   - POST /api/sync/push (offline sync mutations)
 *   - scripts/extract-legacy-notes.ts (batch legacy import)
 */

// ═══════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════

export interface GasReading {
  type: 'h2s' | 'lel';
  value: number;
  unit: 'ppm' | '%';
  context: string;       // e.g. "casing", "tubing", "breathing zone", "treater", "separator"
  readingType: 'test' | 'calibration' | 'monitor';
}

export interface CylinderRecord {
  serial: string;
  hydroDate: string | null;   // "MM/YYYY" normalized
  hydroUE: boolean;           // +UE = unlimited extension
  hydroStar: boolean;         // +* = star exemption
  psi: number | null;
  location: string;           // treater, tank battery, separator, etc.
  action: 'inspected' | 'installed' | 'removed' | 'noted';
}

// ═══════════════════════════════════════════════════════════════
//  GAS READING EXTRACTION
// ═══════════════════════════════════════════════════════════════

export function extractGasReadings(notes: string): GasReading[] {
  const readings: GasReading[] = [];
  if (!notes) return readings;

  const text = notes.replace(/\\r\\n|\\r|\\n|\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ');

  // ── H2S test results ──
  const h2sTestPatterns = [
    /(?:(\w[\w\s]{0,30}?)\s+)?h2s\s*(?:results?|analysis\s*results?|tested?|testing\s*results?)\s*(?:on\s+([\w\s]+?)\s+)?(?:were?|was|is|=|:)?\s*(?:@|at)?\s*(-?\d+(?:\.\d+)?)\s*ppm/gi,
    /h2s\s*(?:monitor\s*)?(?:reading|level|was\s*reading)\s*(?:at|@|of|=|:)?\s*(-?\d+(?:\.\d+)?)\s*ppm/gi,
  ];

  for (const pattern of h2sTestPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const groups = match.slice(1).filter(g => g !== undefined);
      const valueStr = groups[groups.length - 1];
      const value = parseFloat(valueStr);
      if (isNaN(value)) continue;

      let context = '';
      for (const g of groups.slice(0, -1)) {
        if (g && !/^\d/.test(g.trim())) {
          context = g.trim().toLowerCase();
        }
      }

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

function isValidSerial(s: string): boolean {
  const upper = s.toUpperCase();
  if (SERIAL_BLACKLIST.has(upper)) return false;
  if (upper.length < 4) return false;
  if (/^[A-Z]+$/.test(upper)) return false;
  if (!/\d/.test(upper)) return false;
  return true;
}

function normalizeHydroDate(raw: string): string {
  const raw2 = raw.trim().replace(/[()]/g, '');

  const ym = raw2.match(/^(20\d{2})\/(0?\d{1,2})$/);
  if (ym) return `${ym[2].padStart(2, '0')}/${ym[1]}`;

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

  const md = raw2.match(/^(0?\d{1,2})\/(0?\d{2,4})$/);
  if (md) {
    const month = md[1].padStart(2, '0');
    let year = md[2];
    if (year.length === 2) year = (parseInt(year) > 50 ? '19' : '20') + year;
    return `${month}/${year}`;
  }

  return raw2;
}

export function extractCylinderData(notes: string): CylinderRecord[] {
  const records: CylinderRecord[] = [];
  if (!notes) return records;

  const text = notes.replace(/\\r\\n|\\r|\\n|\r\n|\r|\n/g, '\n');
  const lines = text.split('\n');

  let currentLocation = '';
  const locationKeywords = /(treater|tank\s*battery|separator|stairs?|wellhead|pig\s*launcher|lact|compressor|vru|pump|bulk)/i;

  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (!lower) continue;

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

    // ── Pattern 2: Compact "enk h2287 3/14+*" or "4932018y 1/14+*" ──
    const compactPattern = /\b([A-Z]{0,4}\s?[A-Z0-9][A-Z0-9\-]{3,}[A-Z0-9Y])\s+(?:\(?(\d{1,2}\/\d{2,4})\)?)\s*(\+\s*(?:ue|\*))?/gi;
    let compactMatch;
    while ((compactMatch = compactPattern.exec(line)) !== null) {
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

    // ── Pattern 3: "Hydro: MM/YYYY" on same line as serial ──
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
        const psi = pm[3] ? parseInt(pm[3]) : parseInt(pm[2]);
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
//  HIGH-LEVEL: Enrich customData with extracted readings
// ═══════════════════════════════════════════════════════════════

/**
 * Given a workDescription (ticket notes) and existing customData,
 * extract gas readings and cylinder data and merge them in.
 * Returns the updated customData object (or undefined if nothing to add).
 */
export function enrichCustomData(
  workDescription: string | null | undefined,
  existingCustomData: Record<string, any> | null | undefined,
): Record<string, any> | undefined {
  if (!workDescription) return existingCustomData || undefined;

  const gasReadings = extractGasReadings(workDescription);
  const cylinderData = extractCylinderData(workDescription);

  // Nothing extracted — return existing as-is
  if (gasReadings.length === 0 && cylinderData.length === 0) {
    return existingCustomData || undefined;
  }

  const cd: Record<string, any> = { ...(existingCustomData || {}) };
  if (gasReadings.length > 0) cd.gasReadings = gasReadings;
  if (cylinderData.length > 0) cd.cylinderData = cylinderData;

  return cd;
}
