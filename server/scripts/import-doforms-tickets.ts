/**
 * Import historical DoForms "D3 Ticket" exports into ServiceTicket.
 *
 * DoForms was the field-tech form system before ServicePRO. Each CSV row is
 * one completed field visit. Two form generations exist (mk1 / mk2) with
 * slightly different columns — this script reads columns by header NAME, so
 * it handles both transparently.
 *
 * Run:
 *   npx tsx scripts/import-doforms-tickets.ts [--dry-run] [--limit N] <file.csv> [file2.csv ...]
 *
 * Behaviour:
 *   - Scope: Continental Resources only (other operators in the file are skipped).
 *   - Dedup: a row whose JobID (SVC###) already exists as a ServiceTicket
 *     ticketNumber is skipped — that ticket is already in SP.
 *   - Every imported ticket: ticketType='field_service', status='closed'.
 *   - Parts (NAmePartName/SKU/Quantity) become TicketLineItems; SKU is matched
 *     to Product.partNumber where possible.
 *   - H2S readings are parsed out of the free-text ClientComments (techs log
 *     them as "Casing - 75ppm" lists) into customData.gasReadings, which is
 *     what the H2S dashboard / customer-portal H2S tab read.
 */

import { prisma, Prisma } from '../src/db.js';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';


const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.indexOf('--limit');
const LIMIT = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : 0;
const CSV_FILES = process.argv
  .slice(2)
  .filter(a => a.toLowerCase().endsWith('.csv'));

const TARGET_COMPANY = 'Continental Resources, Inc';

// ─── CSV parsing (quote-aware, handles newlines inside quoted fields) ───

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function readCSV(path: string): { headers: string[]; rows: Record<string, string>[] } {
  const raw = readFileSync(path, 'utf8');
  const logical: string[] = [];
  let cur = '';
  let inQ = false;
  for (const ch of raw) {
    if (ch === '"') { inQ = !inQ; cur += ch; }
    else if ((ch === '\n' || ch === '\r') && !inQ) {
      if (cur.trim()) logical.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) logical.push(cur);

  const headers = parseCSVLine(logical[0]).map(h => h.replace(/^"|"$/g, '').trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < logical.length; i++) {
    const cells = parseCSVLine(logical[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (cells[idx] ?? '').trim(); });
    rows.push(row);
  }
  return { headers, rows };
}

// ─── Field helpers ───

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function lineTypeFor(name: string): string {
  const n = name.toLowerCase();
  if (/labor/.test(n)) return 'labor';
  if (/mileage/.test(n)) return 'travel';
  if (/call.?out|\bfee\b/.test(n)) return 'misc_charge';
  return 'service';
}

// ─── H2S extraction from free-text ClientComments ───
//
// Techs log results as line lists: "Casing - 75ppm", "V-700 - 4ppm",
// "Star Federal 6-14H - 2ppm". Capture <label before ' - '> and the ppm value.
// Non-numeric results ("Casing - down", "too much fluid") are skipped.

interface GasReading {
  type: 'h2s';
  value: number;
  unit: 'ppm';
  context: string;
  readingType: 'test';
}

function extractH2sReadings(notes: string): GasReading[] {
  const out: GasReading[] = [];
  if (!notes) return out;
  for (const raw of notes.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || /calibrat/i.test(line)) continue;
    const m = line.match(/(-?\d+(?:\.\d+)?)\s*ppm\b/i);
    if (!m) continue;
    const value = parseFloat(m[1]);
    if (isNaN(value) || value < 0 || value > 10000) continue;
    const dash = line.search(/\s[-–]\s/);
    let context = dash > 0 ? line.slice(0, dash) : '';
    context = context.toLowerCase().replace(/["':]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    out.push({ type: 'h2s', value, unit: 'ppm', context: context || 'general', readingType: 'test' });
  }
  return out;
}

// ─── Main ───

async function main() {
  console.log(`\n=== Import DoForms Tickets ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${LIMIT ? ` | Limit: ${LIMIT}` : ''}`);
  console.log(`Scope: ${TARGET_COMPANY} only\n`);

  if (CSV_FILES.length === 0) {
    console.error('Error: pass at least one .csv file path as an argument.');
    process.exit(1);
  }

  // Resolve target company
  const company = await prisma.company.findFirst({ where: { name: TARGET_COMPANY } });
  if (!company) {
    console.error(`Error: company "${TARGET_COMPANY}" not found in the database.`);
    process.exit(1);
  }
  console.log(`Company resolved: ${company.name} (${company.id})`);

  // Existing ticket numbers — dedup target
  const existing = await prisma.serviceTicket.findMany({ select: { ticketNumber: true } });
  const existingNumbers = new Set(existing.map(t => t.ticketNumber));
  console.log(`Existing tickets in DB: ${existingNumbers.size}`);

  // SKU → Product map
  const products = await prisma.product.findMany({
    select: { id: true, partNumber: true, unitOfMeasure: true },
  });
  const productBySku = new Map(products.map(p => [p.partNumber, p]));

  // Gather + filter rows
  const allRows: Record<string, string>[] = [];
  for (const file of CSV_FILES) {
    const { rows } = readCSV(file);
    console.log(`  ${file}: ${rows.length} rows`);
    allRows.push(...rows);
  }

  let inserted = 0, skippedExisting = 0, skippedCompany = 0,
    skippedNoJob = 0, skippedDupInFile = 0, errors = 0,
    lineItemsInserted = 0, h2sReadingsExtracted = 0;
  const seenJobIds = new Set<string>();

  let processed = 0;
  for (const row of allRows) {
    if (LIMIT && inserted >= LIMIT) break;

    if (row['Company'] !== TARGET_COMPANY) { skippedCompany++; continue; }

    const jobId = row['JobID']?.trim();
    if (!jobId) { skippedNoJob++; continue; }
    if (seenJobIds.has(jobId)) { skippedDupInFile++; continue; }
    seenJobIds.add(jobId);
    if (existingNumbers.has(jobId)) { skippedExisting++; continue; }

    processed++;

    const arrival = parseDate(row['Arrival_Date_Time']);
    const created = parseDate(row['Date_Created']);
    const departure = parseDate(row['Departure_Date']);
    const serviceBasis = arrival || created;
    if (!serviceBasis) { errors++; console.error(`  ${jobId}: no usable date — skipped`); continue; }

    const clientComments = row['ClientComments'] || '';
    const gasReadings = extractH2sReadings(clientComments);
    h2sReadingsExtracted += gasReadings.length;

    const customData: Record<string, any> = {
      source: 'doforms-import',
      doformsJobId: jobId,
      doformsRecordKey: row['Record_Key'] || null,
      doformsFormRecord: row['Form_Record'] || null,
      doformsApprovalStatus: row['Approval_Status'] || null,
      division: row['Division'] || null,
      visitType: row['Visit_Typer'] || null,
      tier1: row['Tier1'] || null,
      technicians: [row['Tech_1'], row['Tech_2']].filter(Boolean),
      temperatureF: num(row['Temperature']),
      signatureUrl: row['Signature'] || null,
    };
    const lat = num(row['GPS_Location Latitude']);
    const lng = num(row['GPS_Location Longitude']);
    if (lat != null && lng != null) customData.gps = { lat, lng };
    if (gasReadings.length > 0) customData.gasReadings = gasReadings;

    const ticketId = randomUUID();
    const ticketData: Prisma.ServiceTicketCreateManyInput = {
      id: ticketId,
      ticketNumber: jobId,
      ticketType: 'field_service',
      status: 'closed',
      companyId: company.id,
      serviceDate: dateOnly(serviceBasis),
      arrivalTime: arrival,
      departureTime: departure,
      locationDisplay: row['Location'] || null,
      workDescription: clientComments || null,
      internalNotes: row['InternalComments'] || null,
      afeNumber: row['AFE'] || null,
      poNumber: row['PO'] || null,
      customerRepName: row['CustomerSignatureName'] || null,
      customData: customData as any,
      createdAt: created || serviceBasis,
      completedAt: departure || arrival || created,
    };

    // Line items from the 20 part slots
    const lineItems: Prisma.TicketLineItemCreateManyInput[] = [];
    for (let n = 1; n <= 20; n++) {
      const name = row[`NAmePartName(${n})`]?.trim();
      if (!name) continue;
      const sku = row[`SKU(${n})`]?.trim() || null;
      const qty = num(row[`Quantity(${n})`]) ?? 1;
      const product = sku ? productBySku.get(sku) : undefined;
      lineItems.push({
        id: randomUUID(),
        ticketId,
        lineNumber: lineItems.length + 1,
        sortOrder: lineItems.length + 1,
        lineType: lineTypeFor(name) as any,
        description: name,
        quantity: qty,
        partNumber: sku,
        productId: product?.id ?? null,
        unitOfMeasure: product?.unitOfMeasure ?? null,
      });
    }

    if (DRY_RUN) {
      inserted++;
      lineItemsInserted += lineItems.length;
      continue;
    }

    try {
      await prisma.$transaction([
        prisma.serviceTicket.create({ data: ticketData }),
        ...(lineItems.length > 0
          ? [prisma.ticketLineItem.createMany({ data: lineItems })]
          : []),
      ]);
      inserted++;
      lineItemsInserted += lineItems.length;
    } catch (e: any) {
      errors++;
      if (errors <= 10) console.error(`  ${jobId}: ${String(e.message).slice(0, 160)}`);
    }

    if (processed % 50 === 0) {
      process.stdout.write(`\r  ${inserted} inserted, ${skippedExisting} already in SP…`);
    }
  }

  console.log('\n');
  console.log('=== Import Summary ===');
  console.log(`Tickets inserted:            ${inserted}`);
  console.log(`Line items inserted:         ${lineItemsInserted}`);
  console.log(`H2S readings extracted:      ${h2sReadingsExtracted}`);
  console.log(`Skipped — already in SP:     ${skippedExisting}`);
  console.log(`Skipped — other company:     ${skippedCompany}`);
  console.log(`Skipped — no JobID:          ${skippedNoJob}`);
  console.log(`Skipped — duplicate in file: ${skippedDupInFile}`);
  console.log(`Errors:                      ${errors}`);
  if (DRY_RUN) console.log('\n(DRY RUN — nothing was written)');

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  prisma.$disconnect();
  process.exit(1);
});
