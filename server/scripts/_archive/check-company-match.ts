import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient();

function parseCSV(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || '').trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else current += ch;
  }
  result.push(current);
  return result;
}

async function main() {
  const companyRows = parseCSV('C:\\Users\\mbart\\OneDrive\\Desktop\\NOTREBLE\\Company_202602230955.csv');
  const sundogCompanies = await prisma.company.findMany({
    select: { id: true, name: true, qbCustomerFullName: true },
  });

  const qbNameToId = new Map<string, string>();
  const nameToId = new Map<string, string>();
  for (const c of sundogCompanies) {
    if (c.qbCustomerFullName) qbNameToId.set(c.qbCustomerFullName.toLowerCase().trim(), c.id);
    nameToId.set(c.name.toLowerCase().trim(), c.id);
  }

  console.log('=== Unmatched Azure Companies ===\n');

  // Count locations per company
  const locationRows = parseCSV('C:\\Users\\mbart\\OneDrive\\Desktop\\NOTREBLE\\Location_202602191538.csv');
  const locsPerCompany = new Map<string, number>();
  for (const l of locationRows) {
    const cid = l['CompanyId'];
    locsPerCompany.set(cid, (locsPerCompany.get(cid) || 0) + 1);
  }

  for (const row of companyRows) {
    const azureId = row['Id'];
    const qbName = (row['QuickBooksName'] || '').trim();
    const name = (row['Name'] || '').trim();
    const isDeleted = row['IsDeleted'] === '1';
    const status = row['Status'];

    if (isDeleted) continue;

    let match = qbName ? qbNameToId.get(qbName.toLowerCase()) : undefined;
    if (!match) match = nameToId.get(name.toLowerCase());
    if (!match && qbName) match = nameToId.get(qbName.toLowerCase());

    if (!match) {
      const locCount = locsPerCompany.get(azureId) || 0;
      console.log(`Azure #${azureId} | "${name}" | QB: "${qbName}" | Status: ${status} | Locations: ${locCount}`);

      // Try to find close matches
      const searchName = (qbName || name).toLowerCase();
      const close = sundogCompanies.filter(c =>
        c.name.toLowerCase().includes(searchName.slice(0, 8)) ||
        (c.qbCustomerFullName && c.qbCustomerFullName.toLowerCase().includes(searchName.slice(0, 8)))
      );
      if (close.length > 0) {
        for (const c of close.slice(0, 3)) {
          console.log(`  -> Possible: "${c.name}" (qb: "${c.qbCustomerFullName}")`);
        }
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
