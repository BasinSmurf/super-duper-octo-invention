/**
 * Production Seed Script — Sundog
 *
 * Imports real data from QB exports + old ticketing DB SQL dumps.
 * Run: npx tsx scripts/prod-seed.ts [--clean]
 *
 * --clean: Wipe existing location data (WorkPoints, Wells, Pads, Fields) before reimporting.
 *          Companies and Products are always upserted (safe to re-run).
 *
 * Dependency order:
 *   1. QB Customers CSV → Company
 *   2. Old DB Company CSV → Enrich Company + build azureCompanyId map
 *   3. QB Products CSV → Product
 *   4. Fields SQL → Field
 *   5. Routes SQL → in-memory lookup map
 *   6. Locations SQL → Pad
 *   7. Wells SQL → Well
 *   8. Air Systems + Bottles SQL → WorkPoint
 */
import { prisma, Prisma } from '../src/db.js';
import { readFileSync } from 'fs';
import path from 'path';

const PRELOAD = path.resolve(__dirname, '../../preload');

// ═══════════════════════════════════════════════════════════════
//  SHARED PARSERS
// ═══════════════════════════════════════════════════════════════

/** Parse a CSV line handling quoted fields with embedded commas and escaped quotes */
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
 * Parse SQL INSERT statements into rows of string values.
 * Handles: N'string', 'string', NULL, numbers, escaped '' inside strings.
 * Returns 1-indexed ID alongside each row for cross-referencing.
 */
function parseSqlInserts(sql: string): { id: number; values: string[] }[] {
  const rows: { id: number; values: string[] }[] = [];
  let id = 1;

  // Match each VALUES block: everything between VALUES\n and the final semicolon
  // Each row is a (...) tuple separated by commas+newlines
  const valueBlockRe = /VALUES\s*\n([\s\S]*?)(?=;\s*(?:INSERT|$))/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = valueBlockRe.exec(sql)) !== null) {
    const block = blockMatch[1];
    // Extract individual row tuples
    const rowRe = /\(([^)]*(?:'[^']*'[^)]*)*)\)/g;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRe.exec(block)) !== null) {
      const rawRow = rowMatch[1];
      const vals = parseSqlRow(rawRow);
      rows.push({ id, values: vals });
      id++;
    }
  }
  return rows;
}

/** Parse the inside of a SQL VALUES tuple into individual values */
function parseSqlRow(raw: string): string[] {
  const values: string[] = [];
  let i = 0;
  const s = raw.trim();

  while (i < s.length) {
    // Skip whitespace and leading comma
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
    if (i >= s.length) break;
    if (s[i] === ',') { i++; continue; }

    // NULL
    if (s.substring(i, i + 4).toUpperCase() === 'NULL') {
      values.push('NULL');
      i += 4;
      continue;
    }

    // N'string' or 'string'
    if (s[i] === 'N' && s[i + 1] === "'") {
      i += 2; // skip N'
      let val = '';
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          val += "'";
          i += 2;
        } else if (s[i] === "'") {
          i++; // closing quote
          break;
        } else {
          val += s[i];
          i++;
        }
      }
      values.push(val);
      continue;
    }

    if (s[i] === "'") {
      i++; // skip opening quote
      let val = '';
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") {
          val += "'";
          i += 2;
        } else if (s[i] === "'") {
          i++;
          break;
        } else {
          val += s[i];
          i++;
        }
      }
      values.push(val);
      continue;
    }

    // Number or other literal
    let val = '';
    while (i < s.length && s[i] !== ',' && s[i] !== ')') {
      val += s[i];
      i++;
    }
    values.push(val.trim());
  }
  return values;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 50);
}

function normalizeUoM(raw: string): string {
  if (!raw) return 'EA';
  const lower = raw.toLowerCase().trim();
  // Handle "day (day)" format — extract the first word
  const match = lower.match(/^(\w+)/);
  const word = match ? match[1] : lower;

  if (['hour', 'hr', 'hours'].includes(word)) return 'HR';
  if (['day', 'days'].includes(word)) return 'DAY';
  if (['mile', 'mi', 'miles'].includes(word)) return 'MI';
  if (['each', 'ea'].includes(word)) return 'EA';
  if (['case', 'cs'].includes(word)) return 'CS';
  if (['box', 'bx'].includes(word)) return 'BX';
  if (['pair', 'pr'].includes(word)) return 'PR';
  if (['pack', 'pk'].includes(word)) return 'PK';
  if (['roll', 'rl'].includes(word)) return 'RL';
  if (['foot', 'ft', 'feet'].includes(word)) return 'FT';
  if (['year', 'yr'].includes(word)) return 'YR';
  if (['gallon', 'gal'].includes(word)) return 'GAL';
  if (['month', 'mo'].includes(word)) return 'MO';
  if (['week', 'wk'].includes(word)) return 'WK';
  return 'EA';
}

function guessCategory(description: string, itemType: string): string {
  const d = (description || '').toLowerCase();

  // Monitor — personal
  if (/\b(monitor|g7|mx6|ibrid|altair|bw |ventis|gas detect|multi.?gas|4.?gas)\b/.test(d)
      && !/area monitor/.test(d)) return 'monitor_personal';
  // Monitor — area
  if (/area monitor|rae guard/.test(d)) return 'monitor_area';
  // Supplied air
  if (/\b(scba|supplied air|respirator|regulator|cascade|breathing air|escape pack|air cylinder|air bottle)\b/.test(d)) return 'supplied_air_component';
  // Sensor
  if (/\bsensor\b/.test(d) && !/motion sensor/.test(d)) return 'sensor';
  // Calibration gas
  if (/\b(calibration|cal gas|bump gas|4-gas mix|zero air|span gas|test gas)\b/.test(d)) return 'calibration_gas';
  // Training / Labor / Service
  if (/\b(training|safeland|h2s clear|h2s aware|cpr|first aid|osha|msha|confined space|defensive driving|hazwoper|fork lift|forklift|fire ext|consultant|consulting|mileage|perdiem|per diem|flight reimb|inspection|fit test|medical eval|meq)\b/.test(d)) return 'labor';
  // Inventory Assembly
  if (itemType.toLowerCase() === 'inventory assembly') return 'assembly';
  // Inventory → consumable
  if (/inventory/i.test(itemType)) return 'consumable';
  // Default
  return 'misc';
}

function inferWorkPointName(name: string): string {
  const lower = (name || 'Tank Battery').toLowerCase().trim();
  if (lower.includes('wellhead') || lower.includes('well head')) return 'Wellhead';
  if (lower.includes('separator') || lower.includes('seperator')) return 'Separator';
  if (lower.includes('treater')) return 'Treater';
  if (lower.includes('tank')) return (name || 'Tank Battery').trim();
  if (lower.includes('truck cylinder')) return 'Truck Cylinder';
  if (lower.includes('compressor')) return (name || '').trim();
  if (lower.includes('pig launcher')) return 'Pig Launcher';
  if (lower.includes('receiver')) return 'Receiver';
  if (lower.includes('building')) return (name || '').trim();
  return (name || 'Tank Battery').trim();
}

const NULL_VAL = 'NULL';
function isNull(v: string): boolean { return !v || v === NULL_VAL; }
function toInt(v: string): number | null { return isNull(v) ? null : parseInt(v, 10) || null; }
function toFloat(v: string): number | null { return isNull(v) ? null : parseFloat(v) || null; }

// ═══════════════════════════════════════════════════════════════
//  STEP 1: QB Customers CSV → Company
// ═══════════════════════════════════════════════════════════════
async function importCustomers() {
  console.log('\n══════ STEP 1: QB Customers → Company ══════');
  const csv = readFileSync(path.join(PRELOAD, 'customers.csv'), 'utf-8');
  const lines = csv.split('\n').filter(l => l.trim());
  // Header: Customer, Bill to, Primary Contact, Main Phone
  const header = parseCSVLine(lines[0]);
  console.log(`  Columns: ${header.join(' | ')}`);

  let created = 0, updated = 0, skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const customerName = cols[0]?.trim();
    if (!customerName) { skipped++; continue; }

    const billTo = cols[1]?.trim() || '';
    const contact = cols[2]?.trim() || '';
    const phone = cols[3]?.trim() || '';

    // Parse address from "Bill to" field — it's all one field like:
    // "Company Name Address Line City, ST ZIP"
    // Strategy: the company name is cols[0], so strip it from billTo to get address
    let address = '';
    let city = '', state = '', zip = '';

    if (billTo) {
      // Try to extract "City, ST ZIP" from the end
      const cityStateZipRe = /,?\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/;
      const match = billTo.match(cityStateZipRe);
      if (match) {
        city = match[1].trim();
        state = match[2];
        zip = match[3];
        // Everything before the city/state/zip is the address
        const beforeMatch = billTo.substring(0, billTo.length - match[0].length).trim();
        // Strip the company name from the front if present
        if (beforeMatch.toLowerCase().startsWith(customerName.toLowerCase())) {
          address = beforeMatch.substring(customerName.length).trim();
        } else {
          address = beforeMatch;
        }
      } else {
        // No city/state/zip parseable — just store the whole thing minus company name
        if (billTo.toLowerCase().startsWith(customerName.toLowerCase())) {
          address = billTo.substring(customerName.length).trim();
        } else {
          address = billTo;
        }
      }
    }

    // Clean up address — remove leading/trailing commas
    address = address.replace(/^[,\s]+|[,\s]+$/g, '').trim();

    const idSlug = 'qb-' + slugify(customerName);

    // Check for existing company by QB name or regular name
    const existing = await prisma.company.findFirst({
      where: {
        OR: [
          { qbCustomerFullName: customerName },
          { name: { equals: customerName, mode: 'insensitive' } },
        ],
      },
    });

    if (existing) {
      // Update QB mapping + fill blanks
      await prisma.company.update({
        where: { id: existing.id },
        data: {
          qbCustomerFullName: customerName,
          qbSyncStatus: 'synced',
          ...((!existing.phone && phone) ? { phone } : {}),
          ...((!existing.address && address) ? { address } : {}),
          ...((!existing.city && city) ? { city } : {}),
          ...((!existing.state && state) ? { state } : {}),
          ...((!existing.zip && zip) ? { zip } : {}),
        },
      });
      updated++;
    } else {
      // Create new company
      try {
        await prisma.company.create({
          data: {
            id: idSlug,
            name: customerName,
            companyType: 'customer',
            isActive: true,
            qbCustomerFullName: customerName,
            qbSyncStatus: 'synced',
            phone: phone || null,
            address: address || null,
            city: city || null,
            state: state || null,
            zip: zip || null,
            customData: contact ? { primaryContact: contact } as any : Prisma.JsonNull,
          },
        });
        created++;
      } catch (e: any) {
        if (e.code === 'P2002') {
          // Slug collision — append row number
          await prisma.company.create({
            data: {
              id: `${idSlug}-${i}`,
              name: customerName,
              companyType: 'customer',
              isActive: true,
              qbCustomerFullName: customerName,
              qbSyncStatus: 'synced',
              phone: phone || null,
              address: address || null,
              city: city || null,
              state: state || null,
              zip: zip || null,
              customData: contact ? { primaryContact: contact } as any : Prisma.JsonNull,
            },
          });
          created++;
        } else {
          console.error(`  ✗ Error creating "${customerName}":`, e.message);
        }
      }
    }
  }

  console.log(`  ✓ Companies: ${created} created, ${updated} updated, ${skipped} skipped`);
}

// ═══════════════════════════════════════════════════════════════
//  STEP 2: Enrich Companies from Old DB + Build Azure Map
// ═══════════════════════════════════════════════════════════════
async function enrichCompanies(): Promise<Map<number, string>> {
  console.log('\n══════ STEP 2: Enrich Companies + Build Azure Map ══════');
  const csv = readFileSync(path.join(PRELOAD, 'Company_202603091336.csv'), 'utf-8');
  const lines = csv.split('\n').filter(l => l.trim());
  const header = parseCSVLine(lines[0]);
  console.log(`  Columns (${header.length}): ${header.slice(0, 8).join(', ')}...`);

  // Build column index map
  const col: Record<string, number> = {};
  header.forEach((h, idx) => col[h.replace(/"/g, '')] = idx);

  const azureToSundog = new Map<number, string>();
  let enriched = 0, matched = 0, unmatched = 0;

  // Load all companies from DB for matching
  const allCompanies = await prisma.company.findMany({
    select: { id: true, name: true, qbCustomerFullName: true },
  });

  const byQbName = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const c of allCompanies) {
    if (c.qbCustomerFullName) byQbName.set(c.qbCustomerFullName.toLowerCase(), c.id);
    byName.set(c.name.toLowerCase(), c.id);
  }

  for (let i = 1; i < lines.length; i++) {
    const r = parseCSVLine(lines[i]);
    const azureId = parseInt(r[col['Id']] || '0');
    const name = r[col['Name']]?.trim();
    const qbName = r[col['QuickBooksName']]?.trim();
    const isDeleted = r[col['IsDeleted']]?.trim() === '1';
    const status = r[col['Status']]?.trim(); // 1 = inactive in old DB

    if (!name && !qbName) continue;

    // Match to Sundog company
    let sundogId: string | undefined;
    if (qbName) sundogId = byQbName.get(qbName.toLowerCase());
    if (!sundogId && qbName) sundogId = byName.get(qbName.toLowerCase());
    if (!sundogId && name) sundogId = byName.get(name.toLowerCase());

    if (sundogId) {
      azureToSundog.set(azureId, sundogId);
      matched++;

      // Enrich with billing config + Enverus data
      const paymentTerms = r[col['PaymentTerms']]?.trim() || null;
      const dueDateOffset = toInt(r[col['DueDateOffset']] || '0');
      const afeLabel = r[col['AfeLabel']]?.trim() || null;
      const costCenterLabel = r[col['CostCenterLabel']]?.trim() || null;
      const poLabel = r[col['POLabel']]?.trim() || null;
      const woLabel = r[col['WOLabel']]?.trim() || null;
      const soLabel = r[col['SOLabel']]?.trim() || null;
      const attachFieldTicket = r[col['AttachFieldTicket']]?.trim() === '1';
      const attachInvoice = r[col['AttachInvoice']]?.trim() === '1';
      const priceBookNumber = r[col['PriceBookNumber']]?.trim() || null;
      const invoiceTemplateId = r[col['InvoiceTemplateId']]?.trim() || null;

      // Enverus config
      const enverusDuns = r[col['OpenInvoiceDuns']]?.replace(/"/g, '').trim() || null;
      const enverusName = r[col['OpenInvoiceName']]?.trim() || null;
      const enverusLocation = r[col['OpenInvoiceLocation']]?.trim() || null;
      const enverusDept = r[col['OpenInvoiceDepartment']]?.trim() || null;
      const enverusDuns4 = r[col['OpenInvoiceDuns4']]?.trim() || null;
      const openInvoiceId = r[col['OpenInvoiceId']]?.replace(/"/g, '').trim() || null;

      const productionForeman = r[col['ProductionForeman']]?.trim() || null;
      const discountRate = toFloat(r[col['DiscountRate']] || '0');
      const invoiceRouteMileage = r[col['InvoiceRouteMileage']]?.trim() === '1';

      // Build customData — merge with existing
      const existing = await prisma.company.findUnique({
        where: { id: sundogId },
        select: { customData: true },
      });
      const existingCustom = (existing?.customData as any) || {};

      const customData: any = {
        ...existingCustom,
        azureCompanyId: azureId,
      };

      // Only add Enverus block if there's data
      if (enverusDuns || openInvoiceId) {
        customData.enverus = {
          openInvoiceId,
          duns: enverusDuns,
          name: enverusName,
          location: enverusLocation,
          department: enverusDept,
          duns4: enverusDuns4,
        };
      }
      if (productionForeman) customData.productionForeman = productionForeman;
      if (discountRate) customData.discountRate = discountRate;
      if (invoiceRouteMileage) customData.invoiceRouteMileage = true;
      if (invoiceTemplateId) customData.legacyInvoiceTemplateId = invoiceTemplateId;

      const updateData: any = { customData };
      if (paymentTerms) updateData.paymentTerms = paymentTerms;
      if (dueDateOffset) updateData.dueDateOffset = dueDateOffset;
      if (afeLabel) updateData.afeLabel = afeLabel;
      if (costCenterLabel) updateData.costCenterLabel = costCenterLabel;
      if (poLabel) updateData.poLabel = poLabel;
      if (woLabel) updateData.woLabel = woLabel;
      if (attachFieldTicket) updateData.attachFieldTicket = true;
      if (attachInvoice) updateData.attachInvoice = true;
      if (priceBookNumber) updateData.priceBookNumber = priceBookNumber;

      await prisma.company.update({ where: { id: sundogId }, data: updateData });
      enriched++;
    } else {
      if (!isDeleted && name) {
        unmatched++;
        if (unmatched <= 20) console.log(`  ⚠ Unmatched: Azure #${azureId} "${name}" (QB: "${qbName || 'N/A'}")`);
      }
    }
  }

  console.log(`  ✓ Matched: ${matched}, Enriched: ${enriched}, Unmatched: ${unmatched}`);
  console.log(`  ✓ Azure→Sundog map: ${azureToSundog.size} entries`);
  return azureToSundog;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 3: QB Products → Product
// ═══════════════════════════════════════════════════════════════

const SKIP_TYPES = new Set(['discount', 'group', 'subtotal', 'sales tax item', 'sales tax group']);
const QB_TYPE_MAP: Record<string, { productType: string; qbItemType: string }> = {
  'service': { productType: 'service', qbItemType: 'service' },
  'inventory part': { productType: 'sale', qbItemType: 'inventory' },
  'non-inventory part': { productType: 'sale', qbItemType: 'non_inventory' },
  'inventory assembly': { productType: 'sale', qbItemType: 'inventory_assembly' },
  'other charge': { productType: 'service', qbItemType: 'other_charge' },
};

async function importProducts() {
  console.log('\n══════ STEP 3: QB Products → Product ══════');
  const csv = readFileSync(path.join(PRELOAD, 'itemList.csv'), 'utf-8');
  const lines = csv.split('\n').filter(l => l.trim());
  // Header: Active Status, Type, Item, Description, Sales Tax Code, U/M, Tax Agency, Price, MPN
  const header = parseCSVLine(lines[0]);
  console.log(`  Columns: ${header.join(' | ')}`);

  let imported = 0, skipped = 0, errors = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const activeStatus = cols[0]?.trim();
    const itemType = cols[1]?.trim() || '';
    const partNumber = cols[2]?.trim();
    const description = cols[3]?.trim() || '';
    const salesTaxCode = cols[4]?.trim() || '';
    const uom = cols[5]?.trim() || '';
    const priceStr = cols[7]?.trim() || '0';
    const mpn = cols[8]?.trim() || '';

    // Skip conditions
    if (activeStatus !== 'Active') { skipped++; continue; }
    if (SKIP_TYPES.has(itemType.toLowerCase())) { skipped++; continue; }
    if (!partNumber) { skipped++; continue; }

    const typeInfo = QB_TYPE_MAP[itemType.toLowerCase()];
    if (!typeInfo) { skipped++; continue; }

    const category = guessCategory(description, itemType);
    const unitOfMeasure = normalizeUoM(uom);
    const isTaxable = salesTaxCode?.toLowerCase() === 'tax';
    const isSerialized = ['monitor_personal', 'monitor_area', 'supplied_air_component'].includes(category);
    const isAssembly = itemType.toLowerCase() === 'inventory assembly';

    let price = parseFloat(priceStr.replace('%', ''));
    if (isNaN(price)) price = 0;

    try {
      await prisma.product.upsert({
        where: { partNumber },
        update: {
          name: description || partNumber,
          description: description || null,
          category: category as any,
          productType: typeInfo.productType as any,
          qbItemType: typeInfo.qbItemType as any,
          qbItemFullName: partNumber,
          unitOfMeasure,
          defaultSellPrice: price,
          isTaxable,
          isSerialized,
          isAssembly,
          isActive: true,
          ...(mpn ? { customData: { mpn } as any } : {}),
        },
        create: {
          partNumber,
          name: description || partNumber,
          description: description || null,
          category: category as any,
          productType: typeInfo.productType as any,
          qbItemType: typeInfo.qbItemType as any,
          qbItemFullName: partNumber,
          unitOfMeasure,
          defaultSellPrice: price,
          isTaxable,
          isSerialized,
          isAssembly,
          isActive: true,
          ...(mpn ? { customData: { mpn } as any } : {}),
        },
      });
      imported++;
    } catch (e: any) {
      errors++;
      if (errors <= 10) console.error(`  ✗ Product "${partNumber}":`, e.message);
    }
  }

  console.log(`  ✓ Products: ${imported} imported, ${skipped} skipped, ${errors} errors`);
}

// ═══════════════════════════════════════════════════════════════
//  STEP 4: Fields SQL → Field
// ═══════════════════════════════════════════════════════════════
async function importFields(azureCompanyMap: Map<number, string>): Promise<Map<number, string>> {
  console.log('\n══════ STEP 4: Fields → Field ══════');
  const sql = readFileSync(path.join(PRELOAD, 'Field_202603091322.sql'), 'utf-8');
  const rows = parseSqlInserts(sql);
  // Columns: Name, CompanyId, DateCreated, DateModified, DateDeleted, IsDeleted

  const fieldMap = new Map<number, string>(); // azureFieldId → sundogFieldId
  const seenNames = new Map<string, string>(); // name.upper → sundogFieldId
  let created = 0, skippedDeleted = 0, dupes = 0;

  // Create UNASSIGNED field first
  const unassigned = await prisma.field.upsert({
    where: { id: 'field-unassigned' },
    update: {},
    create: { id: 'field-unassigned', name: 'UNASSIGNED', state: 'ND', isActive: true },
  });
  seenNames.set('UNASSIGNED', unassigned.id);

  for (const row of rows) {
    const [name, companyIdStr, , , , isDeletedStr] = row.values;
    const isDeleted = isDeletedStr === '1';

    if (isDeleted) {
      // Still add to map so references resolve, but create as inactive
      skippedDeleted++;
    }

    if (!name || isNull(name)) continue;

    const nameUpper = name.toUpperCase().trim();
    if (seenNames.has(nameUpper)) {
      // Dedupe — map this azure ID to the existing field
      fieldMap.set(row.id, seenNames.get(nameUpper)!);
      dupes++;
      continue;
    }

    const companyId = toInt(companyIdStr);
    const sundogCompanyId = companyId ? azureCompanyMap.get(companyId) : null;

    try {
      // Field model has no customData — store azure refs in notes
      const noteParts: string[] = [`azure:${row.id}`];
      if (companyId) noteParts.push(`co:${companyId}`);

      const field = await prisma.field.create({
        data: {
          name: name.trim(),
          state: 'ND',
          isActive: !isDeleted,
          notes: noteParts.join(' | '),
        },
      });
      fieldMap.set(row.id, field.id);
      seenNames.set(nameUpper, field.id);
      created++;
    } catch (e: any) {
      console.error(`  ✗ Field "${name}":`, e.message);
    }
  }

  console.log(`  ✓ Fields: ${created} created, ${dupes} dupes, ${skippedDeleted} deleted`);
  console.log(`  ✓ Field map: ${fieldMap.size} entries + UNASSIGNED`);
  return fieldMap;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 5: Routes SQL → In-Memory Map
// ═══════════════════════════════════════════════════════════════
interface RouteInfo {
  name: string;
  area: string | null;
  companyId: number | null;
  number: number | null;
}

function loadRoutes(): Map<number, RouteInfo> {
  console.log('\n══════ STEP 5: Routes → Lookup Map ══════');
  const sql = readFileSync(path.join(PRELOAD, 'Route_202603091323.sql'), 'utf-8');
  const rows = parseSqlInserts(sql);
  // Columns: Name, Status, DateCreated, DateModified, DateDeleted, IsDeleted, CompanyId, Number, Area

  const routeMap = new Map<number, RouteInfo>();
  for (const row of rows) {
    const [name, , , , , , companyIdStr, numberStr, area] = row.values;
    routeMap.set(row.id, {
      name: name?.trim() || 'Unknown Route',
      area: isNull(area) ? null : area?.trim(),
      companyId: toInt(companyIdStr),
      number: toInt(numberStr),
    });
  }

  console.log(`  ✓ Routes loaded: ${routeMap.size} entries`);
  return routeMap;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 6: Locations SQL → Pad
// ═══════════════════════════════════════════════════════════════
interface PadInfo {
  id: string;
  fieldId: string;
  operatorId: string | null;
}

async function importPads(
  azureCompanyMap: Map<number, string>,
  fieldMap: Map<number, string>,
  routeMap: Map<number, RouteInfo>,
): Promise<Map<number, PadInfo>> {
  console.log('\n══════ STEP 6: Locations → Pad ══════');
  const sql = readFileSync(path.join(PRELOAD, 'Location_202603091323.sql'), 'utf-8');
  const rows = parseSqlInserts(sql);
  // Columns (21): Name, Status, DateCreated, DateModified, DateDeleted,
  //   RouteId, CompanyId, IsDeleted, WorkOrderNumber, RouteMileage,
  //   SalesTaxId, ProductionForeman, [Index], ClientName, Tier1,
  //   FieldId, ForemanId, AfeName, AfeNumber, CostCenterName, CostCenterNumber

  const padMap = new Map<number, PadInfo>();
  let created = 0, skippedDeleted = 0, errors = 0;
  let fieldMisses = 0, companyMisses = 0;

  for (const row of rows) {
    const v = row.values;
    const name = v[0]?.trim();
    const status = v[1]; // 0=active, 1=inactive
    const isDeleted = v[7] === '1';
    const routeIdNum = toInt(v[5]);
    const companyIdNum = toInt(v[6]);
    const workOrderNumber = isNull(v[8]) ? null : v[8]?.trim();
    const routeMileage = toFloat(v[9]);
    const productionForeman = isNull(v[11]) ? null : v[11]?.trim();
    const clientName = isNull(v[13]) ? null : v[13]?.trim();
    const fieldIdNum = toInt(v[15]);
    const afeName = isNull(v[17]) ? null : v[17]?.trim();
    const afeNumber = isNull(v[18]) ? null : v[18]?.trim();
    const costCenterName = isNull(v[19]) ? null : v[19]?.trim();
    const costCenterNumber = isNull(v[20]) ? null : v[20]?.trim();

    if (!name) continue;

    // Resolve field
    let fieldId = fieldIdNum ? fieldMap.get(fieldIdNum) : null;
    if (!fieldId) {
      fieldId = 'field-unassigned';
      if (fieldIdNum) fieldMisses++;
    }

    // Resolve company
    const operatorId = companyIdNum ? (azureCompanyMap.get(companyIdNum) || null) : null;
    if (companyIdNum && !operatorId) companyMisses++;

    // Resolve route
    const route = routeIdNum ? routeMap.get(routeIdNum) : null;

    const isActive = status === '0' && !isDeleted;

    const customData: any = {
      azureLocationId: row.id,
    };
    if (route) {
      customData.routeName = route.name;
      if (route.area) customData.routeArea = route.area;
      if (route.number) customData.routeNumber = route.number;
    }
    if (routeMileage) customData.routeMileage = routeMileage;
    if (clientName) customData.clientName = clientName;
    if (productionForeman) customData.productionForeman = productionForeman;
    if (workOrderNumber) customData.workOrderNumber = workOrderNumber;
    if (afeName) customData.afeName = afeName;
    if (afeNumber) customData.afeNumber = afeNumber;
    if (costCenterName) customData.costCenterName = costCenterName;
    if (costCenterNumber) customData.costCenterNumber = costCenterNumber;

    try {
      const pad = await prisma.pad.create({
        data: {
          name,
          fieldId,
          currentOperatorId: operatorId,
          isActive,
          customData: customData as any,
        },
      });
      padMap.set(row.id, { id: pad.id, fieldId, operatorId });
      created++;
    } catch (e: any) {
      errors++;
      if (errors <= 10) console.error(`  ✗ Pad "${name}" (loc #${row.id}):`, e.message);
    }
  }

  console.log(`  ✓ Pads: ${created} created, ${skippedDeleted} deleted-skip, ${errors} errors`);
  if (fieldMisses) console.log(`  ⚠ ${fieldMisses} pads had unresolved FieldId → assigned to UNASSIGNED`);
  if (companyMisses) console.log(`  ⚠ ${companyMisses} pads had unresolved CompanyId`);
  return padMap;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 7: Wells SQL → Well
// ═══════════════════════════════════════════════════════════════
async function importWells(padMap: Map<number, PadInfo>) {
  console.log('\n══════ STEP 7: Wells → Well ══════');
  const sql = readFileSync(path.join(PRELOAD, 'Well_202603091323.sql'), 'utf-8');
  const rows = parseSqlInserts(sql);
  // Columns: APIRef, WellName, Status, LocationId, DateCreated, DateModified, DateDeleted, IsDeleted

  let created = 0, skipped = 0, errors = 0, nopad = 0, dupeApi = 0;

  for (const row of rows) {
    const [apiRef, wellName, status, locationIdStr, , , , isDeletedStr] = row.values;
    const isDeleted = isDeletedStr === '1';
    if (isDeleted) { skipped++; continue; }

    const locationId = toInt(locationIdStr);
    if (!locationId) { skipped++; continue; }

    const padInfo = padMap.get(locationId);
    if (!padInfo) {
      nopad++;
      if (nopad <= 10) console.log(`  ⚠ Well "${wellName}" references LocationId=${locationId} — no pad found`);
      continue;
    }

    let apiNumber = isNull(apiRef) ? null : apiRef?.trim() || null;
    const isActive = status === '0';

    try {
      await prisma.well.create({
        data: {
          wellName: wellName?.trim() || 'Unknown Well',
          padId: padInfo.id,
          fieldId: padInfo.fieldId,
          currentOperatorId: padInfo.operatorId,
          apiNumber: apiNumber || undefined,
          isActiveForService: isActive,
          customData: {
            azureWellId: row.id,
            azureLocationId: locationId,
          } as any,
        },
      });
      created++;
    } catch (e: any) {
      if (e.code === 'P2002' && apiNumber) {
        // Duplicate API number — retry without it (store in customData instead)
        try {
          await prisma.well.create({
            data: {
              wellName: wellName?.trim() || 'Unknown Well',
              padId: padInfo.id,
              fieldId: padInfo.fieldId,
              currentOperatorId: padInfo.operatorId,
              isActiveForService: isActive,
              customData: {
                azureWellId: row.id,
                azureLocationId: locationId,
                duplicateApiNumber: apiNumber,
              } as any,
            },
          });
          created++;
          dupeApi++;
        } catch (e2: any) {
          errors++;
          if (errors <= 10) console.error(`  ✗ Well "${wellName}" (retry):`, e2.message);
        }
      } else {
        errors++;
        if (errors <= 10) console.error(`  ✗ Well "${wellName}":`, e.message);
      }
    }
  }

  console.log(`  ✓ Wells: ${created} created, ${skipped} skipped, ${nopad} no-pad, ${dupeApi} dupe-api, ${errors} errors`);
}

// ═══════════════════════════════════════════════════════════════
//  STEP 8: Air Systems + Bottles → WorkPoint
// ═══════════════════════════════════════════════════════════════
async function importAirSystems(padMap: Map<number, PadInfo>) {
  console.log('\n══════ STEP 8: Air Systems + Bottles → WorkPoint ══════');

  // --- Load bottles first ---
  const bottleSql = readFileSync(path.join(PRELOAD, 'AirBottle_202603091321.sql'), 'utf-8');
  const bottleRows = parseSqlInserts(bottleSql);
  // Columns: SerialNumber, HydroDate, Status, SystemId, DateCreated, DateModified, DateDeleted, IsDeleted

  const bottlesBySystem = new Map<number, any[]>();
  let bottleCount = 0;

  for (const row of bottleRows) {
    const [serialNumber, hydroDate, status, systemIdStr, , , , isDeletedStr] = row.values;
    const isDeleted = isDeletedStr === '1';
    if (isDeleted) continue;

    const systemId = toInt(systemIdStr);
    if (!systemId) continue;

    if (!bottlesBySystem.has(systemId)) bottlesBySystem.set(systemId, []);
    bottlesBySystem.get(systemId)!.push({
      azureBottleId: row.id,
      serialNumber: serialNumber?.trim() || '',
      hydroDate: isNull(hydroDate) ? null : hydroDate.split(' ')[0], // Extract YYYY-MM-DD
      isActive: status === '0',
    });
    bottleCount++;
  }
  console.log(`  ✓ Bottles parsed: ${bottleCount} across ${bottlesBySystem.size} systems`);

  // --- Import air systems ---
  const systemSql = readFileSync(path.join(PRELOAD, 'AirSystem_202603091322.sql'), 'utf-8');
  const systemRows = parseSqlInserts(systemSql);
  // Columns: Name, ReelSerialNumber, StandSerialNumber, Status, LocationId,
  //          DateCreated, DateModified, DateDeleted, IsDeleted, [Type]

  let created = 0, skippedDeleted = 0, nopad = 0, errors = 0;
  const padsWithAir = new Set<string>();

  for (const row of systemRows) {
    const v = row.values;
    const rawName = v[0]?.trim() || 'Tank Battery';
    const reelSerial = isNull(v[1]) ? null : v[1]?.trim() || null;
    const standSerial = isNull(v[2]) ? null : v[2]?.trim() || null;
    const status = v[3]; // 0=active, 1=inactive
    const locationId = toInt(v[4]);
    const isDeleted = v[8] === '1';
    const airType = toInt(v[9]);

    if (isDeleted) { skippedDeleted++; continue; }
    if (!locationId) { skippedDeleted++; continue; }

    const padInfo = padMap.get(locationId);
    if (!padInfo) {
      nopad++;
      if (nopad <= 10) console.log(`  ⚠ AirSystem "${rawName}" references LocationId=${locationId} — no pad`);
      continue;
    }

    const name = inferWorkPointName(rawName);
    const isActive = status === '0';

    // Get bottles for this system
    const bottles = bottlesBySystem.get(row.id) || [];
    const activeBottles = bottles.filter((b: any) => b.isActive);

    const customData: any = {
      azureAirSystemId: row.id,
      azureLocationId: locationId,
      azureType: airType || 0,
    };
    if (bottles.length > 0) {
      customData.bottles = bottles;
      customData.activeBottleCount = activeBottles.length;
      customData.totalBottleCount = bottles.length;
    }

    try {
      await prisma.workPoint.create({
        data: {
          name,
          workPointType: 'air_system_location',
          padId: padInfo.id,
          hasSuppliedAir: true,
          hasAreaMonitor: false,
          reelSerialNumber: reelSerial,
          standSerialNumber: standSerial,
          airSystemType: name,
          legacyAirSystemId: String(row.id),
          isActive,
          customData: customData as any,
        },
      });
      padsWithAir.add(padInfo.id);
      created++;
    } catch (e: any) {
      errors++;
      if (errors <= 10) console.error(`  ✗ AirSystem "${name}" (sys #${row.id}):`, e.message);
    }
  }

  console.log(`  ✓ WorkPoints: ${created} created, ${skippedDeleted} skipped, ${nopad} no-pad, ${errors} errors`);

  // --- Flag wells at pads with air systems ---
  if (padsWithAir.size > 0) {
    const result = await prisma.well.updateMany({
      where: { padId: { in: Array.from(padsWithAir) } },
      data: { hasSuppliedAir: true },
    });
    console.log(`  ✓ Flagged ${result.count} wells with hasSuppliedAir=true across ${padsWithAir.size} pads`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  const clean = process.argv.includes('--clean');

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        SUNDOG PRODUCTION SEED                   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Source: ${PRELOAD}`);
  console.log(`  Clean mode: ${clean}`);
  console.log(`  Database: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':****@') || 'default'}`);

  if (clean) {
    console.log('\n  🧹 Cleaning existing location data...');
    const wp = await prisma.workPoint.deleteMany({});
    console.log(`     Deleted ${wp.count} WorkPoints`);
    const w = await prisma.well.deleteMany({});
    console.log(`     Deleted ${w.count} Wells`);
    const p = await prisma.pad.deleteMany({});
    console.log(`     Deleted ${p.count} Pads`);
    const f = await prisma.field.deleteMany({});
    console.log(`     Deleted ${f.count} Fields`);
  }

  // Step 1: QB Customers
  await importCustomers();

  // Step 2: Enrich from old DB + build azure map
  const azureCompanyMap = await enrichCompanies();

  // Step 3: QB Products
  await importProducts();

  // Step 4: Fields
  const fieldMap = await importFields(azureCompanyMap);

  // Step 5: Routes
  const routeMap = loadRoutes();

  // Step 6: Locations → Pads
  const padMap = await importPads(azureCompanyMap, fieldMap, routeMap);

  // Step 7: Wells
  await importWells(padMap);

  // Step 8: Air Systems + Bottles
  await importAirSystems(padMap);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║        SEED COMPLETE                            ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

main()
  .catch(e => { console.error('Fatal:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
