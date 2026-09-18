/**
 * Import QuickBooks product CSV into Sundog.
 *
 * Usage:
 *   npx tsx prisma/import-qb-products.ts <path-to-csv>
 *
 * Only imports Active items of types: Service, Inventory Part,
 * Non-inventory Part, Inventory Assembly, Other Charge.
 * Skips Discount, Group, Subtotal, Sales Tax items.
 * Imports pricing (defaultSellPrice) from the Price column.
 */
import { prisma } from '../src/db.js';
import fs from 'fs';
import path from 'path';


// ── CSV Parsing (handles quoted fields with commas) ──────────

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
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

// ── Mapping helpers ──────────────────────────────────────────

type ProductCategory =
  | 'monitor_personal' | 'monitor_area' | 'supplied_air_component'
  | 'sensor' | 'calibration_gas' | 'accessory' | 'consumable'
  | 'assembly' | 'labor' | 'misc';

type ProductType = 'sale' | 'rental' | 'both' | 'service';
type QbItemType = 'inventory' | 'non_inventory' | 'service' | 'inventory_assembly' | 'other_charge';

const QB_TYPE_MAP: Record<string, { productType: ProductType; qbItemType: QbItemType }> = {
  'Service':            { productType: 'service',  qbItemType: 'service' },
  'Inventory Part':     { productType: 'sale',     qbItemType: 'inventory' },
  'Non-inventory Part': { productType: 'sale',     qbItemType: 'non_inventory' },
  'Inventory Assembly': { productType: 'sale',     qbItemType: 'inventory_assembly' },
  'Other Charge':       { productType: 'service',  qbItemType: 'other_charge' },
};

const SKIP_TYPES = new Set(['Discount', 'Group', 'Subtotal', 'Sales Tax Item', 'Sales Tax Group']);

// Map QB Account → ProductCategory by keyword matching
function guessCategory(account: string, description: string, qbType: string): ProductCategory {
  const desc = description.toLowerCase();
  const acct = account.toLowerCase();

  // Assembly type → assembly
  if (qbType === 'Inventory Assembly') return 'assembly';

  // Keyword-based on description
  if (desc.includes('monitor') || desc.includes('g7') || desc.includes('mx6') || desc.includes('ibrid') || desc.includes('altair') || desc.includes('bw ') || desc.includes('ventis') || desc.includes('gas detect'))
    return 'monitor_personal';
  if (desc.includes('area monitor') || desc.includes('rae guard'))
    return 'monitor_area';
  if (desc.includes('scba') || desc.includes('supplied air') || desc.includes('respirator') || desc.includes('regulator') || desc.includes('cascade'))
    return 'supplied_air_component';
  if (desc.includes('sensor') && !desc.includes('motion sensor'))
    return 'sensor';
  if (desc.includes('calibration') || desc.includes('cal gas') || desc.includes('bump gas') || desc.includes('4-gas') || desc.includes('zero air'))
    return 'calibration_gas';

  // Account-based
  if (acct.includes('training')) return 'labor';
  if (acct.includes('consulting')) return 'labor';
  if (acct.includes('service income')) return 'labor';
  if (acct.includes('remediation')) return 'labor';

  // Remaining physical inventory → consumable or accessory
  if (qbType === 'Inventory Part' || qbType === 'Non-inventory Part') return 'consumable';

  return 'misc';
}

// Normalize unit of measure
function normalizeUoM(raw: string): string {
  if (!raw) return 'EA';
  const lower = raw.toLowerCase();
  if (lower.includes('hour') || lower === 'hr') return 'HR';
  if (lower.includes('day')) return 'DAY';
  if (lower.includes('mile') || lower === 'mi') return 'MI';
  if (lower.includes('each') || lower === 'ea') return 'EA';
  if (lower.includes('case')) return 'CS';
  if (lower.includes('box')) return 'BX';
  if (lower.includes('pair')) return 'PR';
  if (lower.includes('pack')) return 'PK';
  if (lower.includes('roll')) return 'RL';
  if (lower.includes('ft') || lower.includes('foot') || lower.includes('feet')) return 'FT';
  return raw.substring(0, 10).toUpperCase();
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: npx tsx prisma/import-qb-products.ts <path-to-csv>');
    process.exit(1);
  }

  const fullPath = path.resolve(csvPath);
  console.log(`Reading CSV: ${fullPath}`);
  const raw = fs.readFileSync(fullPath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());

  // Skip header row
  const dataLines = lines.slice(1);
  console.log(`Found ${dataLines.length} rows (including inactive/skipped types)`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const line of dataLines) {
    const cols = parseCSVLine(line);
    // Columns: [0]=empty, [1]=Active Status, [2]=Type, [3]=Item, [4]=Description,
    //          [5]=Sales Tax Code, [6]=Account, ..., [12]=U/M, ..., [15]=Price
    const activeStatus = cols[1] || '';
    const qbType = cols[2] || '';
    const partNumber = cols[3] || '';
    const description = cols[4] || '';
    const taxCode = cols[5] || '';
    const account = cols[6] || '';
    const uom = cols[12] || '';
    const costStr = cols[13] || '0';
    const priceStr = cols[16] || '0';
    const cost = parseFloat(costStr) || 0;
    const price = parseFloat(priceStr.replace('%', '')) || 0;  // some tax items have "8%" — filter those

    // Skip non-active
    if (activeStatus !== 'Active') {
      skipped++;
      continue;
    }

    // Skip types we don't import
    if (SKIP_TYPES.has(qbType)) {
      skipped++;
      continue;
    }

    // Skip if no part number
    if (!partNumber) {
      skipped++;
      continue;
    }

    const typeMapping = QB_TYPE_MAP[qbType];
    if (!typeMapping) {
      console.warn(`  Unknown QB type "${qbType}" for item "${partNumber}" — skipping`);
      skipped++;
      continue;
    }

    const category = guessCategory(account, description, qbType);
    const isTaxable = taxCode === 'Tax';
    const isSerialized = category === 'monitor_personal' || category === 'monitor_area' || category === 'supplied_air_component';

    try {
      await prisma.product.upsert({
        where: { partNumber },
        update: {
          name: description || partNumber,
          category,
          productType: typeMapping.productType,
          unitOfMeasure: normalizeUoM(uom),
          defaultSellPrice: price,
          cost: cost,
          isTaxable,
          isSerialized,
          isAssembly: qbType === 'Inventory Assembly',
          qbItemFullName: partNumber,
          qbItemType: typeMapping.qbItemType,
          isActive: true,
        },
        create: {
          partNumber,
          name: description || partNumber,
          category,
          productType: typeMapping.productType,
          unitOfMeasure: normalizeUoM(uom),
          defaultSellPrice: price,
          cost: cost,
          isTaxable,
          isSerialized,
          isAssembly: qbType === 'Inventory Assembly',
          qbItemFullName: partNumber,
          qbItemType: typeMapping.qbItemType,
          isActive: true,
        },
      });
      imported++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Error on "${partNumber}": ${msg}`);
      errors++;
    }
  }

  console.log('\n── Import Summary ──');
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped:  ${skipped} (inactive / non-product types)`);
  console.log(`  Errors:   ${errors}`);
  console.log('Done.');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Import failed:', e);
    prisma.$disconnect();
    process.exit(1);
  });
