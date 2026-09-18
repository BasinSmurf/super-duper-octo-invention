/**
 * Import DoForms ticket JSON blobs as real ServiceTicket + TicketLineItem records.
 * Also archives each into legacy_tickets for raw reference.
 *
 * Usage:
 *   npx tsx prisma/import-doforms-tickets.ts [json-dir]
 *
 * Defaults to: ../preload/json/
 *
 * What it does:
 *  1. Ensures all DoForms companies exist in the companies table (creates missing ones)
 *  2. Matches DoForms SKUs to products by partNumber
 *  3. Matches tech names to users by name
 *  4. Creates ServiceTicket (status=completed) + TicketLineItems
 *  5. Archives raw JSON into legacy_tickets
 *  6. Skips duplicates by ticketNumber
 */
import { prisma, TicketType, ServiceSubtype, LineItemType } from '../src/db.js';
import fs from 'fs';
import path from 'path';


// ── DoForms types ───────────────────────────────────────────────

interface DoFormsField {
  name: string;
  data?: string;
  type?: string;
  text?: string;
  integer?: number;
  number?: number;
  datetime?: string;
  fields?: DoFormsField[];
  rows?: { index: number; fields: DoFormsField[] }[];
  location?: { latitude: number; longitude: number; altitude?: number; accuracy?: number };
  blob?: { key: string; id: string; fileName: string; type: string };
  selection?: { text: string; label: { en: string } };
}

interface DoFormsSubmission {
  fields: DoFormsField[];
  key: string;
  id: string;
  index: number;
  name: string;
  type: string;
  formName: string;
  formVersion: number;
  ownerName?: string;
  openTime?: string;
  createTime?: string;
  receiveTime?: string;
  sourceName?: string;
  sourceType?: string;
  status?: string;
  statusTime?: string;
  updateTime?: string;
  updateUser?: string;
  timezone?: string;
  offset?: number;
}

// ── Field extraction helpers ────────────────────────────────────

function findField(fields: DoFormsField[], name: string): DoFormsField | undefined {
  for (const f of fields) {
    if (f.name === name) return f;
    if (f.fields) {
      const found = findField(f.fields, name);
      if (found) return found;
    }
  }
  return undefined;
}

function extractText(fields: DoFormsField[], name: string): string | null {
  const f = findField(fields, name);
  return f?.text?.trim() || null;
}

function extractDatetime(fields: DoFormsField[], name: string): Date | null {
  const f = findField(fields, name);
  if (f?.datetime) {
    const d = new Date(f.datetime);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function extractTechNames(fields: DoFormsField[]): string[] {
  const techs: string[] = [];
  const techGrid = findField(fields, 'Techs');
  if (techGrid?.fields) {
    // Sort by field name so Tech_1 comes before Tech_2
    const sorted = [...techGrid.fields].sort((a, b) => a.name.localeCompare(b.name));
    for (const tf of sorted) {
      if (tf.name.startsWith('Tech_') && tf.text?.trim()) {
        techs.push(tf.text.trim());
      }
    }
  }
  return techs;
}

function extractVisitTypeCode(fields: DoFormsField[]): string | null {
  const f = findField(fields, 'Visit_Typer');
  return f?.text || null;
}

function extractVisitTypeLabel(fields: DoFormsField[]): string | null {
  const f = findField(fields, 'Visit_Typer');
  if (f?.selection?.label?.en) return f.selection.label.en;
  return f?.text || null;
}

function extractServiceRows(fields: DoFormsField[]): { sku: string; name: string; qty: number }[] {
  const rows: { sku: string; name: string; qty: number }[] = [];
  const services = findField(fields, 'Services');
  if (services?.rows) {
    for (const row of services.rows) {
      let sku = '';
      let name = '';
      let qty = 0;
      for (const rf of row.fields || []) {
        if (rf.name === 'SKU') sku = rf.text?.trim() || '';
        if (rf.name === 'NAmePartName') name = rf.text?.trim() || '';
        if (rf.name === 'Quantity') qty = rf.number ?? 0;
      }
      if (sku || name) {
        rows.push({ sku, name: decodeHtmlEntities(name), qty });
      }
    }
  }
  return rows;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ── Visit type → ticketType + serviceSubtype mapping ────────────

function mapVisitType(code: string | null): { ticketType: TicketType; serviceSubtype: ServiceSubtype | null } {
  switch (code) {
    case 'Monthly_Inspection':
      return { ticketType: 'field_service', serviceSubtype: 'air_system' };
    case 'H2S_Testing':
      return { ticketType: 'field_service', serviceSubtype: 'ih_h2s' };
    case 'O2_Service':
      return { ticketType: 'field_service', serviceSubtype: 'ih_o2_voc' };
    case 'New_BAS_Installation':
      return { ticketType: 'field_service', serviceSubtype: 'air_system' };
    case 'Routine_Call_Out':
      return { ticketType: 'field_service', serviceSubtype: 'general' };
    case 'ECO':
      return { ticketType: 'field_service', serviceSubtype: 'general' };
    case 'Other':
      return { ticketType: 'field_service', serviceSubtype: 'general' };
    default:
      return { ticketType: 'field_service', serviceSubtype: 'general' };
  }
}

// ── SKU → LineItemType mapping ──────────────────────────────────

function mapLineItemType(sku: string, productName: string): LineItemType {
  // Labor SKUs
  if (sku === '406' || sku === '104') return 'labor';
  if (productName.toLowerCase().includes('labor')) return 'labor';

  // Mileage / delivery = service
  if (sku === '101' || sku === '10003' || sku === '210') return 'service';

  // Parts (hardware items with specific part numbers)
  if (['113', '117', '121', '122', '123', '126', '185', '186', '187', '1269', '1333', '1355'].includes(sku)) return 'part';

  // Everything else is a service (inspections, tests, refills, etc.)
  return 'service';
}

// ── Company name normalization for matching ─────────────────────

function normalizeCompanyName(name: string): string {
  return decodeHtmlEntities(name)
    .replace(/,?\s*(Inc\.?|LLC|Corporation|Corp\.?)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const jsonDir = process.argv[2] || path.resolve(__dirname, '../../preload/json');

  if (!fs.existsSync(jsonDir)) {
    console.error(`Directory not found: ${jsonDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(jsonDir)
    .filter(f => f.endsWith('.json') && f.startsWith('SVC'))
    .sort((a, b) => {
      const numA = parseInt(a.replace('SVC', '').replace('.json', ''), 10);
      const numB = parseInt(b.replace('SVC', '').replace('.json', ''), 10);
      return numA - numB;
    });

  console.log(`Found ${files.length} DoForms JSON files in ${jsonDir}`);

  // ── Step 1: Check for existing tickets to skip duplicates ─────
  const existingTickets = await prisma.serviceTicket.findMany({
    where: { ticketNumber: { startsWith: 'SVC' } },
    select: { ticketNumber: true },
  });
  const existingTicketNumbers = new Set(existingTickets.map(t => t.ticketNumber));
  console.log(`${existingTicketNumbers.size} SVC tickets already in service_tickets`);

  const existingLegacy = await prisma.legacyTicket.findMany({
    select: { doformsTicketId: true },
  });
  const existingLegacyIds = new Set(existingLegacy.map(e => e.doformsTicketId));
  console.log(`${existingLegacyIds.size} legacy tickets already in DB`);

  // ── Step 2: Build company lookup (name → id) ─────────────────
  console.log('\nBuilding company lookup...');
  const allCompanies = await prisma.company.findMany({ select: { id: true, name: true } });
  // Map normalized name → company id
  const companyMap = new Map<string, string>();
  for (const c of allCompanies) {
    companyMap.set(normalizeCompanyName(c.name), c.id);
  }

  // Collect all unique company names from DoForms
  const doformsCompanyNames = new Set<string>();
  for (const file of files) {
    const data: DoFormsSubmission = JSON.parse(fs.readFileSync(path.join(jsonDir, file), 'utf8'));
    const companyRaw = extractText(data.fields, 'Company');
    if (companyRaw) doformsCompanyNames.add(decodeHtmlEntities(companyRaw));
  }

  // Create missing companies
  let companiesCreated = 0;
  for (const rawName of doformsCompanyNames) {
    const norm = normalizeCompanyName(rawName);
    if (!companyMap.has(norm)) {
      // Try partial match (e.g. "Hess Bakken Investments" → "Hess")
      let matched = false;
      for (const [existingNorm, existingId] of companyMap.entries()) {
        if (norm.includes(existingNorm) || existingNorm.includes(norm)) {
          companyMap.set(norm, existingId);
          console.log(`  Fuzzy match: "${rawName}" → existing company id ${existingId}`);
          matched = true;
          break;
        }
      }
      if (!matched) {
        const created = await prisma.company.create({
          data: {
            name: rawName,
            companyType: 'operator',
            state: 'ND',
            isActive: true,
          },
        });
        companyMap.set(norm, created.id);
        companiesCreated++;
        console.log(`  Created company: "${rawName}" → ${created.id}`);
      }
    }
  }
  console.log(`Companies: ${allCompanies.length} existing, ${companiesCreated} created`);

  // ── Step 3: Build product lookup (partNumber/SKU → id) ────────
  console.log('\nBuilding product lookup...');
  const allProducts = await prisma.product.findMany({
    select: { id: true, partNumber: true, name: true },
  });
  const productBySku = new Map<string, { id: string; name: string }>();
  for (const p of allProducts) {
    productBySku.set(p.partNumber, { id: p.id, name: p.name });
  }
  console.log(`Products in DB: ${allProducts.length}`);

  // ── Step 4: Build user/tech lookup (name → id) ────────────────
  console.log('\nBuilding tech lookup...');
  const allUsers = await prisma.user.findMany({
    select: { id: true, name: true },
  });
  const userByName = new Map<string, string>();
  for (const u of allUsers) {
    if (u.name) userByName.set(u.name.toLowerCase(), u.id);
  }
  console.log(`Users in DB: ${allUsers.length}`);

  // ── Step 5: Import tickets ────────────────────────────────────
  console.log('\nImporting tickets...');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let ticketsCreated = 0;
  let legacyCreated = 0;
  let skipped = 0;
  let errors = 0;
  let lineItemsCreated = 0;
  let unmatchedProducts = new Set<string>();
  let unmatchedTechs = new Set<string>();

  for (const file of files) {
    const ticketNumber = file.replace('.json', ''); // e.g. "SVC100"

    if (existingTicketNumbers.has(ticketNumber)) {
      skipped++;
      continue;
    }

    try {
      const raw = fs.readFileSync(path.join(jsonDir, file), 'utf8');
      const data: DoFormsSubmission = JSON.parse(raw);
      const fields = data.fields || [];

      // Extract fields
      const companyRaw = extractText(fields, 'Company');
      const companyName = companyRaw ? decodeHtmlEntities(companyRaw) : null;
      const locationRaw = extractText(fields, 'Location');
      const locationDisplay = locationRaw ? decodeHtmlEntities(locationRaw) : null;
      const arrivalTime = extractDatetime(fields, 'Arrival_Date_Time');
      const departureTime = extractDatetime(fields, 'Departure_Date');
      const techNames = extractTechNames(fields);
      const visitCode = extractVisitTypeCode(fields);
      const visitLabel = extractVisitTypeLabel(fields);
      const comments = extractText(fields, 'ClientComments');
      const afeRaw = extractText(fields, 'AFE');
      const poRaw = extractText(fields, 'PO');
      const serviceRows = extractServiceRows(fields);

      // Resolve company
      const companyNorm = companyName ? normalizeCompanyName(companyName) : null;
      const companyId = companyNorm ? companyMap.get(companyNorm) : null;
      if (!companyId) {
        console.error(`  SKIP ${ticketNumber}: no company match for "${companyName}"`);
        errors++;
        continue;
      }

      // Resolve tech (use Tech_1 as assignedTech)
      let assignedTechId: string | null = null;
      for (const tn of techNames) {
        const uid = userByName.get(tn.toLowerCase());
        if (uid) {
          assignedTechId = uid;
          break;
        }
        unmatchedTechs.add(tn);
      }

      // Map visit type
      const { ticketType, serviceSubtype } = mapVisitType(visitCode);

      // Service date (date-only from arrival)
      const serviceDate = arrivalTime || new Date();

      // Completion timestamp
      const completedAt = departureTime || arrivalTime || new Date();

      // AFE/PO — skip placeholder values
      const afe = afeRaw && afeRaw !== 'MANUAL-REQUIRED' ? afeRaw : null;
      const po = poRaw && poRaw !== 'MANUAL-REQUIRED' ? poRaw : null;

      // GPS
      const gpsField = findField(fields, 'GPS_Location');
      const gps = gpsField?.location || null;

      // Create ServiceTicket + TicketLineItems in a transaction
      await prisma.$transaction(async (tx) => {
        const ticket = await tx.serviceTicket.create({
          data: {
            ticketNumber,
            ticketType,
            serviceSubtype,
            status: 'completed',
            companyId,
            locationDisplay,
            assignedTechId,
            serviceDate,
            arrivalTime,
            departureTime,
            afeNumber: afe,
            poNumber: po,
            workDescription: comments,
            completedAt,
            sourceType: 'self_created',
            customData: {
              doformsImport: true,
              doformsKey: data.key,
              doformsId: data.id,
              doformsFormName: data.formName,
              doformsOwner: data.ownerName || null,
              doformsVisitType: visitLabel,
              doformsTechs: techNames,
              gps: gps ? { lat: gps.latitude, lng: gps.longitude } : null,
            },
          },
        });

        // Create line items
        for (let i = 0; i < serviceRows.length; i++) {
          const row = serviceRows[i];
          const product = productBySku.get(row.sku);
          if (!product && row.sku) unmatchedProducts.add(`${row.sku} (${row.name})`);

          const lineType = mapLineItemType(row.sku, row.name);

          await tx.ticketLineItem.create({
            data: {
              ticketId: ticket.id,
              lineNumber: i + 1,
              lineType,
              productId: product?.id || null,
              description: row.name || product?.name || `SKU ${row.sku}`,
              quantity: row.qty,
              sortOrder: i + 1,
              partNumber: row.sku || null,
            },
          });
          lineItemsCreated++;
        }

        // Also archive into legacy_tickets
        if (!existingLegacyIds.has(ticketNumber)) {
          await tx.legacyTicket.create({
            data: {
              doformsTicketId: ticketNumber,
              ticketDate: arrivalTime,
              customerNameRaw: companyName,
              locationTextRaw: locationDisplay,
              techNameRaw: techNames.join(', ') || null,
              ticketTypeRaw: visitLabel,
              notesFullText: comments,
              rawJson: data as any,
              matchedCompanyId: companyId,
              matchedUserId: assignedTechId,
              importDate: today,
            },
          });
          legacyCreated++;
        }
      });

      ticketsCreated++;
      if (ticketsCreated % 50 === 0) {
        console.log(`  ... ${ticketsCreated} tickets created (at ${ticketNumber})`);
      }
    } catch (err: any) {
      errors++;
      console.error(`  ERROR on ${file}: ${err.message}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('Import Complete');
  console.log('========================================');
  console.log(`  ServiceTickets created: ${ticketsCreated}`);
  console.log(`  TicketLineItems created: ${lineItemsCreated}`);
  console.log(`  LegacyTickets archived: ${legacyCreated}`);
  console.log(`  Skipped (already exists): ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Companies created: ${companiesCreated}`);
  console.log(`  Total files: ${files.length}`);

  if (unmatchedProducts.size > 0) {
    console.log(`\n  Unmatched SKUs (no product in DB — line items created with description only):`);
    for (const p of [...unmatchedProducts].sort()) {
      console.log(`    - ${p}`);
    }
  }

  if (unmatchedTechs.size > 0) {
    console.log(`\n  Unmatched tech names (no user in DB — assignedTechId left null):`);
    for (const t of [...unmatchedTechs].sort()) {
      console.log(`    - ${t}`);
    }
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
