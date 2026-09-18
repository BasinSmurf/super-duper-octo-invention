/**
 * Import historical Field Tickets from old Azure DB exports.
 *
 * Sources (preload/):
 *   - Company_*.csv         → build azureCompanyId → new company UUID map
 *   - FieldTicket_*.csv     → ServiceTicket (status = closed)
 *   - FieldService_*.csv    → TicketLineItem
 *   - FieldTicketHistory_*.csv → stored in ticket customData
 *
 * Run:  npx tsx scripts/import-field-tickets.ts [--dry-run] [--limit N]
 *
 * All imported tickets get status='closed', ticketType='field_service'.
 * Ticket numbers use prefix "LGC-{azureTicketId}" to avoid collisions.
 */

import { prisma, Prisma } from '../src/db.js';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

const PRELOAD = path.resolve(__dirname, '../../preload');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.indexOf('--limit');
const LIMIT = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : 0;
const BATCH_SIZE = 500;

// ═══════════════════════════════════════════════════════════════
//  CSV PARSER
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

/**
 * Read CSV handling multi-line quoted fields (Notes with embedded newlines).
 * Returns logical rows, not physical lines.
 */
function readCSV(filename: string, expectedCols?: number): { headers: string[]; rows: string[][] } {
  const raw = readFileSync(path.join(PRELOAD, filename), 'utf8');
  // Reassemble logical rows: track open quotes
  const logicalRows: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current.trim()) logicalRows.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) logicalRows.push(current);

  const headers = parseCSVLine(logicalRows[0]);
  const colCount = expectedCols || headers.length;
  const rows: string[][] = [];
  for (let i = 1; i < logicalRows.length; i++) {
    const parsed = parseCSVLine(logicalRows[i]);
    // Sanity: skip rows that don't have the right number of columns
    if (parsed.length >= colCount - 2 && parsed.length <= colCount + 2) {
      rows.push(parsed);
    }
  }
  return { headers, rows };
}

function findFile(prefix: string): string {
  const fs = require('fs');
  const files: string[] = fs.readdirSync(PRELOAD);
  const match = files.find((f: string) => f.startsWith(prefix) && f.endsWith('.csv'));
  if (!match) throw new Error(`No file matching ${prefix}*.csv in ${PRELOAD}`);
  return match;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function parseDate(s: string | undefined): Date | null {
  if (!s || s === '' || s === '0') return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseDateOnly(s: string | undefined): Date | null {
  const d = parseDate(s);
  if (!d) return null;
  // Strip time for @db.Date fields
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function parseDecimal(s: string | undefined): number | null {
  if (!s || s === '') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseInt2(s: string | undefined): number | null {
  if (!s || s === '') return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

/** Map old numeric status to new enum. Everything historical → closed. */
function mapStatus(oldStatus: string): string {
  // Old statuses: 0=new, 1=submitted, 2=reviewed, 3=invoiced, 5=archived, 8=rejected
  // All historical → closed
  return 'closed';
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n=== Import Field Tickets ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${LIMIT ? ` | Limit: ${LIMIT}` : ''}\n`);

  // ─── Step 1: Build company mapping (azureCompanyId → new UUID) ───
  console.log('Step 1: Building company mapping...');
  const companyFile = findFile('Company_');
  const companyCsv = readCSV(companyFile);
  // Company CSV: Id(0), Name(1), ..., QuickBooksName(13)
  const qbNameIdx = companyCsv.headers.indexOf('QuickBooksName');
  const azureCompanyMap: Record<number, { name: string; qbName: string }> = {};
  for (const row of companyCsv.rows) {
    const id = parseInt(row[0], 10);
    if (!isNaN(id)) {
      azureCompanyMap[id] = {
        name: row[1] || '',
        qbName: row[qbNameIdx] || row[1] || '',
      };
    }
  }

  // Query all DB companies, build lookup by qbCustomerFullName (case-insensitive)
  const dbCompanies = await prisma.company.findMany({
    select: { id: true, name: true, qbCustomerFullName: true },
  });
  const companyByQB: Record<string, string> = {};
  const companyByName: Record<string, string> = {};
  for (const c of dbCompanies) {
    if (c.qbCustomerFullName) companyByQB[c.qbCustomerFullName.toLowerCase()] = c.id;
    companyByName[c.name.toLowerCase()] = c.id;
  }

  // Build azure → new mapping
  const azureToCompany: Record<number, string> = {};
  let companyMatched = 0, companyMissed = 0;
  for (const [azId, info] of Object.entries(azureCompanyMap)) {
    const qbKey = info.qbName.toLowerCase();
    const nameKey = info.name.toLowerCase();
    const newId = companyByQB[qbKey] || companyByName[nameKey];
    if (newId) {
      azureToCompany[parseInt(azId)] = newId;
      companyMatched++;
    } else {
      companyMissed++;
    }
  }
  console.log(`  Companies mapped: ${companyMatched}, unmapped: ${companyMissed}`);

  // ─── Step 2: Build location mapping (azureLocationId → pad UUID) ───
  console.log('Step 2: Building location→pad mapping...');
  const pads = await prisma.pad.findMany({
    select: { id: true, fieldId: true, customData: true, currentOperatorId: true },
  });
  const azureToPad: Record<number, { padId: string; fieldId: string; operatorId: string | null }> = {};
  for (const pad of pads) {
    const cd = (pad.customData as any) || {};
    if (cd.azureLocationId != null) {
      azureToPad[cd.azureLocationId] = {
        padId: pad.id,
        fieldId: pad.fieldId,
        operatorId: pad.currentOperatorId,
      };
    }
  }
  console.log(`  Pads with azureLocationId: ${Object.keys(azureToPad).length}`);

  // ─── Step 3: Parse FieldService (line items) — group by TicketId ───
  console.log('Step 3: Parsing FieldService (line items)...');
  const servicefile = findFile('FieldService_');
  const serviceCsv = readCSV(servicefile);
  // FieldService: Id(0), Quantity(1), Price(2), ServiceId(3), TicketId(4), DateCreated(5), DateModified(6), DateDeleted(7), IsDeleted(8)
  const lineItemsByTicket: Record<number, Array<{
    azureId: number;
    quantity: number;
    price: number;
    serviceId: number;
  }>> = {};
  let serviceSkipped = 0;
  for (const row of serviceCsv.rows) {
    const isDeleted = row[8]?.trim();
    if (isDeleted === '1') { serviceSkipped++; continue; }
    const ticketId = parseInt2(row[4]);
    if (ticketId == null) continue;
    if (!lineItemsByTicket[ticketId]) lineItemsByTicket[ticketId] = [];
    lineItemsByTicket[ticketId].push({
      azureId: parseInt(row[0], 10),
      quantity: parseFloat(row[1]) || 0,
      price: parseFloat(row[2]) || 0,
      serviceId: parseInt(row[3], 10) || 0,
    });
  }
  const totalServices = serviceCsv.rows.length;
  const activeServices = totalServices - serviceSkipped;
  console.log(`  Line items: ${activeServices} active, ${serviceSkipped} deleted (skipped)`);
  console.log(`  Tickets with line items: ${Object.keys(lineItemsByTicket).length}`);

  // ─── Step 4: Parse FieldTicketHistory — group by TicketId ───
  console.log('Step 4: Parsing FieldTicketHistory...');
  const historyFile = findFile('FieldTicketHistory_');
  const historyCsv = readCSV(historyFile);
  // FieldTicketHistory: Id(0), OriginalStatus(1), NewStatus(2), User(3), Notes(4), TicketId(5), DateCreated(6), ...
  const historyByTicket: Record<number, Array<{
    from: string; to: string; user: string; notes: string; date: string;
  }>> = {};
  for (const row of historyCsv.rows) {
    const isDeleted = row[9]?.trim();
    if (isDeleted === '1') continue;
    const ticketId = parseInt2(row[5]);
    if (ticketId == null) continue;
    if (!historyByTicket[ticketId]) historyByTicket[ticketId] = [];
    historyByTicket[ticketId].push({
      from: row[1] || '',
      to: row[2] || '',
      user: row[3] || '',
      notes: row[4] || '',
      date: row[6] || '',
    });
  }
  console.log(`  History entries loaded for ${Object.keys(historyByTicket).length} tickets`);

  // ─── Step 5: Parse FieldTicket and insert ───
  console.log('Step 5: Parsing FieldTicket CSV...');
  const ticketFile = findFile('FieldTicket_');
  const ticketCsv = readCSV(ticketFile);

  // Filter: skip deleted, optionally limit
  const ticketRows: string[][] = [];
  let ticketDeleted = 0;
  for (const row of ticketCsv.rows) {
    const isDeleted = row[8]?.trim();
    if (isDeleted === '1') { ticketDeleted++; continue; }
    ticketRows.push(row);
    if (LIMIT && ticketRows.length >= LIMIT) break;
  }
  console.log(`  Tickets to import: ${ticketRows.length} (${ticketDeleted} deleted skipped)`);

  // Check for existing legacy tickets to avoid duplicates
  const existingLegacy = await prisma.serviceTicket.findMany({
    where: { ticketNumber: { startsWith: 'LGC-' } },
    select: { ticketNumber: true },
  });
  const existingSet = new Set(existingLegacy.map(t => t.ticketNumber));
  console.log(`  Existing legacy tickets in DB: ${existingSet.size}`);

  // ─── Step 6: Batch insert ───
  console.log(`\nStep 6: Inserting tickets in batches of ${BATCH_SIZE}...`);

  let inserted = 0, skipped = 0, noCompany = 0, errors = 0, lineItemsInserted = 0;
  const unmappedCompanies = new Set<number>();

  for (let batchStart = 0; batchStart < ticketRows.length; batchStart += BATCH_SIZE) {
    const batch = ticketRows.slice(batchStart, batchStart + BATCH_SIZE);
    const ticketCreates: Prisma.ServiceTicketCreateManyInput[] = [];
    const lineItemCreates: Prisma.TicketLineItemCreateManyInput[] = [];

    for (const row of batch) {
      const azureTicketId = parseInt(row[0], 10);
      if (isNaN(azureTicketId)) { errors++; continue; }
      const ticketNumber = `LGC-${azureTicketId}`;

      // Skip if already imported
      if (existingSet.has(ticketNumber)) { skipped++; continue; }

      // Company mapping
      const azureCompanyId = parseInt2(row[12]);
      let companyId: string | null = null;
      if (azureCompanyId != null) {
        companyId = azureToCompany[azureCompanyId] || null;
        if (!companyId) unmappedCompanies.add(azureCompanyId);
      }
      // Fallback: use Basin Safety as catch-all for unmapped/missing companies
      if (!companyId) {
        companyId = companyByName['basin safety'] || dbCompanies[0]?.id;
        if (!companyId) { noCompany++; continue; }
      }

      // Location mapping
      const azureLocationId = parseInt2(row[4]);
      const padInfo = azureLocationId != null ? azureToPad[azureLocationId] : null;

      // Dates
      const arrival = parseDate(row[1]);
      const departure = parseDate(row[2]);
      const serviceDate = arrival ? parseDateOnly(row[1]) : parseDateOnly(row[5]); // fallback to DateCreated
      const createdAt = parseDate(row[5]) || new Date();

      // Build customData with all legacy fields
      const customData: Record<string, any> = {
        azureTicketId,
        azureCompanyId,
        azureLocationId,
        legacyStatus: parseInt2(row[17]),
        legacyRouteId: parseInt2(row[13]),
        legacyVisitType: parseInt2(row[23]),
        legacyInvoiceNumber: row[11] || null,
        legacyDataFileId: parseInt2(row[18]),
        legacyTier1: row[41] || null,
        legacyInvoiceTemplateId: parseInt2(row[43]),
        legacyGroupId: parseInt2(row[44]),
      };

      // History
      const hist = historyByTicket[azureTicketId];
      if (hist && hist.length > 0) {
        customData.statusHistory = hist;
      }

      const ticketId = randomUUID();

      ticketCreates.push({
        id: ticketId,
        ticketNumber,
        ticketType: 'field_service',
        status: 'closed',
        companyId,
        padId: padInfo?.padId || null,
        fieldId: padInfo?.fieldId || null,

        serviceDate: serviceDate || new Date('2016-01-01'),
        arrivalTime: arrival,
        departureTime: departure,

        workDescription: row[3] || null, // Notes
        internalNotes: row[19] || null,   // ReviewNotes

        // Billing refs
        afeNumber: row[48] || null,
        costCenter: row[50] || null,
        poNumber: row[52] || null,

        // Contact
        customerRepName: row[22] || null, // ContactPerson
        customerRepSignature: row[40] || null, // SignatureURL

        // Enverus/OpenInvoice
        enverusReceiptId: row[45] || null, // OpenInvoiceId
        enverusInvoiceStatus: row[46] || null, // OpenInvoiceStatus

        // Temperature stored in customData (not a ticket field)
        customData: customData as any,

        createdAt,
        completedAt: departure || arrival || createdAt,
      });

      // Line items for this ticket
      const items = lineItemsByTicket[azureTicketId];
      if (items) {
        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx];
          const lineTotal = item.quantity * item.price;
          lineItemCreates.push({
            id: randomUUID(),
            ticketId,
            lineNumber: idx + 1,
            lineType: 'service',
            quantity: item.quantity,
            rate: item.price,
            total: lineTotal,
            description: `Legacy service #${item.serviceId}`,
            sortOrder: idx + 1,
            customData: {
              azureFieldServiceId: item.azureId,
              azureServiceId: item.serviceId,
            } as any,
          });
        }
      }
    }

    // Execute batch — insert one-by-one for reliable counting & error isolation
    if (!DRY_RUN && ticketCreates.length > 0) {
      for (let i = 0; i < ticketCreates.length; i++) {
        try {
          const tkt = ticketCreates[i];
          const tktLines = lineItemCreates.filter(li => li.ticketId === tkt.id);
          await prisma.$transaction([
            prisma.serviceTicket.create({ data: tkt }),
            ...(tktLines.length > 0
              ? [prisma.ticketLineItem.createMany({ data: tktLines })]
              : []),
          ]);
          inserted++;
          lineItemsInserted += tktLines.length;
        } catch (e2: any) {
          errors++;
          if (errors <= 10) console.error(`\n  Row error (LGC-${(ticketCreates[i] as any).customData?.azureTicketId}): ${e2.message.slice(0, 200)}`);
        }
      }
    } else if (DRY_RUN) {
      inserted += ticketCreates.length;
    }

    // Progress
    const pct = Math.round(((batchStart + batch.length) / ticketRows.length) * 100);
    process.stdout.write(`\r  Progress: ${pct}% (${inserted} inserted, ${skipped} skipped, ${errors} errors)`);
  }

  console.log('\n');
  console.log('=== Import Summary ===');
  console.log(`Tickets inserted: ${inserted}`);
  console.log(`Line items inserted: ${lineItemsInserted}`);
  console.log(`Tickets skipped (already exist): ${skipped}`);
  console.log(`Tickets skipped (no company): ${noCompany}`);
  console.log(`Errors: ${errors}`);
  console.log(`Unmapped company IDs: ${[...unmappedCompanies].sort((a, b) => a - b).join(', ') || 'none'}`);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  prisma.$disconnect();
  process.exit(1);
});
