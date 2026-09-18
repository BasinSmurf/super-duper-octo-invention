/**
 * DMR CSV Import Route
 *
 * POST /api/locations/dmr/import  — upload CSV, upsert into dmr_reference_wells
 * GET  /api/locations/dmr/import/status — last import stats
 *
 * Permission: locations:import_dmr (platform_admin only)
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { prisma } from '../index.js';
import { requirePermission } from '../middleware/rbac.js';
import { createAuditLog } from '../utils/auditLog.js';
import { bulkUpsertDmr, normalizeApi, DmrUpsertRow } from '../services/dmrBulkUpsert.js';
import { dedupeDmrReferenceWells } from '../services/dmrDedupe.js';

export const dmrImportRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

// ── Column mapping (mirrors server/scripts/import-dmr.ts — KEEP THE TWO IN SYNC) ──
// Supports: standard DMR CSV, claudius/Azure export CSV, and the ND OGD shapefile
// (OGD_Wells.dbf → CSV) export. The OGD lowercase headers below are what was missing
// before — without them an OGD upload imported with empty well_name/field_name/STR.
const COLUMN_MAP: Record<string, string> = {
  // Standard DMR format
  'File No': 'dmrFileNumber',
  'fileno': 'dmrFileNumber',
  'API No': 'apiNumber',
  'api': 'apiNumber',
  'Operator': 'operatorName',
  'operator': 'operatorName',
  'Well Name': 'wellName',
  'wellname': 'wellName',
  'Total Depth': 'totalDepth',
  'totaldepth': 'totalDepth',
  'Spud Date': 'spudDate',
  'spuddate': 'spudDate',
  'Field': 'fieldName',
  'field': 'fieldName',
  'QQ': 'quarterQuarter',
  'qq': 'quarterQuarter',
  'Section': 'section',
  'section': 'section',
  'Township': 'township',
  'twp': 'township',
  'Range': 'range',
  'range': 'range',
  'Feet N/S': 'feetNs',
  'feetns': 'feetNs',
  'N/S Line': 'nsLine',
  'nsline': 'nsLine',
  'Feet E/W': 'feetEw',
  'feetew': 'feetEw',
  'E/W Line': 'ewLine',
  'ewline': 'ewLine',
  'Latitude': 'latitude',
  'latitude': 'latitude',
  'Longitude': 'longitude',
  'longitude': 'longitude',
  'Well Type': 'wellType',
  'welltype': 'wellType',
  'Well Status': 'wellStatus',
  'wellstatus': 'wellStatus',
  'County': 'county',
  'county': 'county',
  'Symbol': 'symbol',
  'symbol': 'symbol',
  // Claudius/Azure export format (claudius_locations_wells.csv)
  'api_no': 'apiNumber',
  'well_name': 'wellName',
  'field_name': 'fieldName',
  'well_type': 'wellType',
  'dmr_status': 'wellStatus',
  'spud_date': 'spudDate',
  'sec': 'section',
  'feet_ns': 'feetNs',
  'fnsl': 'nsLine',
  'feet_ew': 'feetEw',
  'fewl': 'ewLine',
  'rng': 'range',
  'location_name': '_locationName',
  // ND OGD shapefile export format (OGD_Wells.dbf → CSV)
  'status': 'wellStatus',
  'td': 'totalDepth',
};

// Claudius CSV has a 'dmr_match' column — skip rows with these values
const SKIP_DMR_MATCH = new Set(['no_wells', 'none']);

// ── Helpers (same as import-dmr.ts script) ──

function parseWellNameBase(wellName: string | null): string | null {
  if (!wellName) return null;
  const base = wellName.replace(/[\s-]+\d+.*$/, '').trim();
  return base || wellName;
}

function parseDate(val: string | null): Date | null {
  if (!val || val.trim() === '') return null;
  // Handle YYYYMMDD format (dBASE date fields)
  if (/^\d{8}$/.test(val.trim())) {
    const y = val.slice(0, 4), m = val.slice(4, 6), dd = val.slice(6, 8);
    const d = new Date(`${y}-${m}-${dd}`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function parseInt2(val: string | null): number | null {
  if (!val || val.trim() === '') return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function parseFloat2(val: string | null): number | null {
  if (!val || val.trim() === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Simple CSV line parser that handles quoted fields with commas */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current.trim());
  return values;
}

// ── POST /dmr/import ──
dmrImportRouter.post(
  '/import',
  requirePermission('locations:import_dmr'),
  upload.single('file'),
  async (req: Request, res: Response, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded. Send a CSV as "file" field.' });
        return;
      }

      // Reject binary / Excel uploads up front. An .xlsx (or any zip) starts with
      // the "PK\x03\x04" magic; parsing its bytes as CSV text is meaningless and,
      // worse, a stray "api" token in the binary can fool the header check into
      // ingesting thousands of garbage rows. Guide the user to a real CSV.
      const head = req.file.buffer.subarray(0, 4);
      const isZip = head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
      const hasNulls = req.file.buffer.subarray(0, 8192).includes(0x00);
      if (isZip || hasNulls) {
        res.status(400).json({
          error: 'That looks like an Excel/binary file, not a CSV. Export or convert to .csv first (e.g. run scripts/ogd-to-csv.ts on the OGD shapefile).',
        });
        return;
      }

      const csvText = req.file.buffer.toString('utf-8');
      const lines = csvText.split(/\r?\n/);
      const batchDate = new Date();

      if (lines.length < 2) {
        res.status(400).json({ error: 'CSV appears empty — need a header row and at least one data row.' });
        return;
      }

      // Parse header row
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"/, '').replace(/"$/, ''));
      const headerMap: Record<number, string> = {};
      for (let i = 0; i < headers.length; i++) {
        const mapped = COLUMN_MAP[headers[i]];
        if (mapped) headerMap[i] = mapped;
      }

      const mappedFields = Object.values(headerMap);
      if (!mappedFields.includes('apiNumber')) {
        res.status(400).json({
          error: 'CSV must contain an API Number column (expected header: "API No" or "api")',
          recognizedHeaders: mappedFields,
        });
        return;
      }

      let skipped = 0;
      const batch: DmrUpsertRow[] = [];

      for (let lineIdx = 1; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (!line.trim()) continue;

        const values = parseCsvLine(line);

        // Build mapped row
        const row: Record<string, any> = {};
        const rawRow: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
          rawRow[headers[i]] = values[i] || '';
          const field = headerMap[i];
          if (field) row[field] = values[i] || '';
        }

        // Claudius CSV: skip rows flagged as having no well data
        if (SKIP_DMR_MATCH.has((rawRow['dmr_match'] || '').trim())) {
          skipped++;
          continue;
        }

        // Normalize API to the canonical 14-digit digits-only form (10-digit
        // sources get zero-padded), so a dashed, short, or full api column all
        // upsert onto the same record instead of inserting a duplicate.
        const apiNumber = normalizeApi(row.apiNumber || null);
        if (!apiNumber) {
          skipped++;
          continue;
        }

        // Azure export: fall back to location_name when no explicit well name
        if (!row.wellName && row._locationName) row.wellName = row._locationName;

        batch.push({
          dmrFileNumber: parseInt2(row.dmrFileNumber),
          apiNumber,
          apiShort: apiNumber,
          operatorName: row.operatorName || null,
          wellName: row.wellName || null,
          wellNameBase: parseWellNameBase(row.wellName),
          totalDepth: parseInt2(row.totalDepth),
          spudDate: parseDate(row.spudDate),
          fieldName: row.fieldName || null,
          quarterQuarter: row.quarterQuarter || null,
          section: parseInt2(row.section),
          township: parseInt2(row.township),
          range: parseInt2(row.range),
          feetNs: parseInt2(row.feetNs),
          nsLine: row.nsLine || null,
          feetEw: parseInt2(row.feetEw),
          ewLine: row.ewLine || null,
          latitude: parseFloat2(row.latitude),
          longitude: parseFloat2(row.longitude),
          wellType: row.wellType || null,
          wellStatus: row.wellStatus || null,
          county: row.county || null,
          symbol: row.symbol || null,
          rawData: rawRow,
          importBatchDate: batchDate,
        });
      }

      // Self-heal first: merge/rename any duplicate rows already in the table
      // (legacy imports keyed the same well under different API formats), so
      // this upload lands on ONE row per well. Fast no-op once the table is clean.
      const deduped = await dedupeDmrReferenceWells();

      // Bulk upsert (batched INSERT … ON CONFLICT) — fast enough to finish well
      // within the HTTP timeout, unlike the old per-row path.
      const { created, updated, errors, mergedInFile } = await bulkUpsertDmr(batch);
      const errorSamples: string[] = [];

      const totalRows = created + updated + skipped + errors + mergedInFile; // actual processed rows

      await createAuditLog({
        userId: req.user!.userId,
        entityType: 'dmr_import',
        entityId: 'bulk',
        action: 'create',
        changes: { totalRows, created, updated, skipped, errors, mergedInFile, deduped, fileName: req.file.originalname },
        ipAddress: req.ip,
      });

      res.json({
        totalRows,
        created,
        updated,
        skipped,
        errors,
        mergedInFile,
        deduped,
        errorSamples: errorSamples.length > 0 ? errorSamples : undefined,
        importDate: batchDate.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /dmr/import/status — last import info ──
dmrImportRouter.get(
  '/import/status',
  requirePermission('locations:import_dmr'),
  async (_req: Request, res: Response, next) => {
    try {
      const total = await prisma.dmrReferenceWell.count();
      const matched = await prisma.dmrReferenceWell.count({ where: { matchedWellId: { not: null } } });

      // Find most recent importBatchDate
      const latest = await prisma.dmrReferenceWell.findFirst({
        orderBy: { importBatchDate: 'desc' },
        select: { importBatchDate: true },
      });

      res.json({
        totalRecords: total,
        matchedToActive: matched,
        lastImportDate: latest?.importBatchDate || null,
      });
    } catch (err) {
      next(err);
    }
  }
);
