const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  fields.push(current.trim());
  return fields;
}

const SKIP = new Set(['Discount', 'Group', 'Subtotal', 'Sales Tax Item', 'Sales Tax Group']);
const TYPE_MAP = {
  'Service': { pt: 'service', qt: 'service' },
  'Inventory Part': { pt: 'sale', qt: 'inventory' },
  'Non-inventory Part': { pt: 'sale', qt: 'non_inventory' },
  'Inventory Assembly': { pt: 'sale', qt: 'inventory_assembly' },
  'Other Charge': { pt: 'service', qt: 'other_charge' },
};

async function main() {
  const csvPath = process.argv[2] || '/tmp/qb-import.csv';
  const csv = fs.readFileSync(csvPath, 'utf8');
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  console.log('Total lines:', lines.length);
  let imported = 0, skipped = 0, errors = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const active = cols[1] || '';
    const qbType = cols[2] || '';
    const partNumber = cols[3] || '';
    const desc = cols[4] || '';
    const uom = (cols[12] || '').replace(/\s*\(.*\)/, '').toUpperCase() || 'EA';
    const cost = parseFloat(cols[13]) || 0;
    const price = parseFloat((cols[16] || '').replace('%', '')) || 0;

    if (active !== 'Active' || SKIP.has(qbType) || !partNumber || !TYPE_MAP[qbType]) { skipped++; continue; }
    const tm = TYPE_MAP[qbType];

    try {
      await prisma.product.upsert({
        where: { partNumber },
        update: {
          name: desc || partNumber,
          productType: tm.pt,
          qbItemFullName: partNumber,
          qbItemType: tm.qt,
          unitOfMeasure: uom,
          defaultSellPrice: price,
          cost,
          isActive: true,
        },
        create: {
          partNumber,
          name: desc || partNumber,
          category: 'misc',
          productType: tm.pt,
          qbItemFullName: partNumber,
          qbItemType: tm.qt,
          unitOfMeasure: uom,
          defaultSellPrice: price,
          cost,
          isActive: true,
        },
      });
      imported++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.log('ERR:', partNumber, e.message);
    }
  }

  console.log('Done. Imported:', imported, 'Skipped:', skipped, 'Errors:', errors);
  await prisma.$disconnect();
}

main();
