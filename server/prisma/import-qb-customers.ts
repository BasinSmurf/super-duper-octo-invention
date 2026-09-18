/**
 * Import QuickBooks customer list CSV into Sundog companies table.
 * Upserts by qbCustomerFullName — creates new companies or updates QB mapping on existing ones.
 *
 * Usage: npx tsx prisma/import-qb-customers.ts <path-to-csv>
 */
import { prisma } from '../src/db.js';
import { readFileSync } from 'fs';


// Simple CSV parser that handles quoted fields with commas
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
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

async function main() {
  const csvPath = process.argv[2] || 'C:/turdhurdles/customers.CSV';
  console.log(`Reading ${csvPath}...`);
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  // Parse header
  const header = parseCSVLine(lines[0]);
  const col = (name: string) => header.indexOf(name);

  const statusIdx = col('Active Status');
  const customerIdx = col('Customer');
  const companyIdx = col('Company');
  const phoneIdx = col('Main Phone');
  const emailIdx = col('Main Email');
  const bill1Idx = col('Bill to 1');
  const bill2Idx = col('Bill to 2');
  const bill3Idx = col('Bill to 3');
  const termsIdx = col('Terms');
  const contactIdx = col('Primary Contact');

  let created = 0, updated = 0, skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const status = fields[statusIdx];
    const customerName = fields[customerIdx];
    const companyName = fields[companyIdx] || customerName;

    if (!customerName) { skipped++; continue; }
    if (status === 'Not-active') { skipped++; continue; }

    const phone = fields[phoneIdx] || null;
    const email = fields[emailIdx] || null;
    const billLine1 = fields[bill1Idx] || null;
    const billLine2 = fields[bill2Idx] || null;
    const billLine3 = fields[bill3Idx] || null;
    const terms = fields[termsIdx] || null;
    const contactName = fields[contactIdx] || null;

    // Parse city/state/zip from billing address (usually bill3 = "City, ST ZIP")
    let billingCity = null, billingState = null, billingZip = null;
    const cityLine = billLine3 || billLine2 || '';
    const cityMatch = cityLine.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/);
    if (cityMatch) {
      billingCity = cityMatch[1];
      billingState = cityMatch[2];
      billingZip = cityMatch[3];
    }

    // Check if this customer already exists in our DB (by qbCustomerFullName or name)
    const existing = await prisma.company.findFirst({
      where: {
        OR: [
          { qbCustomerFullName: customerName },
          { name: { equals: customerName, mode: 'insensitive' } },
          { name: { equals: companyName, mode: 'insensitive' } },
        ],
      },
    });

    if (existing) {
      // Update with QB mapping
      await prisma.company.update({
        where: { id: existing.id },
        data: {
          qbCustomerFullName: customerName,
          qbSyncStatus: 'synced',
          // Only update blank fields — don't overwrite manually-entered data
          ...((!existing.phone && phone) ? { phone } : {}),
          ...((!existing.email && email) ? { email } : {}),
        },
      });
      updated++;
    } else {
      // Create new company from QB customer
      const id = 'qb-' + customerName.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50);

      try {
        await prisma.company.create({
          data: {
            id,
            name: companyName || customerName,
            phone,
            email,
            address: [billLine1, billLine2].filter(Boolean).join(', ') || null,
            city: billingCity,
            state: billingState,
            zip: billingZip,
            paymentTerms: terms,
            qbCustomerFullName: customerName,
            qbSyncStatus: 'synced',
            companyType: 'customer',
            isActive: true,
          },
        });
        created++;
      } catch (err: any) {
        if (err.code === 'P2002') {
          // Duplicate ID — try with a suffix
          try {
            await prisma.company.create({
              data: {
                id: id + '-' + i,
                name: companyName || customerName,
                displayName: customerName,
                phone,
                email,
                billingAddress: [billLine1, billLine2, billLine3].filter(Boolean).join(', ') || null,
                billingCity,
                billingState,
                billingZip,
                paymentTerms: terms,
                qbCustomerFullName: customerName,
                qbSyncStatus: 'synced',
                companyType: 'customer',
                isActive: true,
              },
            });
            created++;
          } catch {
            console.error(`  SKIP duplicate: ${customerName}`);
            skipped++;
          }
        } else {
          console.error(`  ERROR on "${customerName}":`, err.message);
          skipped++;
        }
      }
    }
  }

  console.log(`\nDone! Created: ${created}, Updated: ${updated}, Skipped: ${skipped}`);
  console.log(`Total active companies in DB: ${await prisma.company.count()}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
