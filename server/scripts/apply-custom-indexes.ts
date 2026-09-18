/**
 * Apply custom pg_trgm indexes that Prisma doesn't support natively.
 * Run after Prisma migrations: npx tsx scripts/apply-custom-indexes.ts
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';


async function main() {
  const sqlPath = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/custom_indexes.sql');
  const sql = readFileSync(sqlPath, 'utf-8');

  // Split by semicolons and execute each statement
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  console.log(`Applying ${statements.length} custom index statements...`);

  for (const stmt of statements) {
    try {
      await prisma.$executeRawUnsafe(stmt + ';');
      // Extract index name for logging
      const match = stmt.match(/INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
      console.log(`  ✓ ${match ? match[1] : 'statement applied'}`);
    } catch (e) {
      console.error(`  ✗ Error: ${(e as Error).message}`);
    }
  }

  console.log('Done.');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Fatal:', e);
    prisma.$disconnect();
    process.exit(1);
  });
