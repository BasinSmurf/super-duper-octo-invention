/**
 * Standalone DMR reference-well dedupe.
 *
 * Usage: npx tsx scripts/dedupe-dmr.ts
 *
 * Merges dmr_reference_wells rows that stacked up under different API-number
 * formats (dashed / 10-digit / 14-digit) or under no API at all (joined by DMR
 * file number). Match links and wells.dmr_reference_id pointers are preserved.
 * The same pass also runs automatically at the start of every CSV import — this
 * script exists so prod can be cleaned without uploading a file.
 */

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { dedupeDmrReferenceWells } from '../src/services/dmrDedupe.js';

async function main() {
  const before = await prisma.dmrReferenceWell.count();
  console.log(`dmr_reference_wells before: ${before}`);

  const result = await dedupeDmrReferenceWells();

  const after = await prisma.dmrReferenceWell.count();
  console.log(`\nDedupe complete:`);
  console.log(`  Renamed (api normalized in place): ${result.renamed}`);
  console.log(`  Duplicate clusters merged:         ${result.groupsMerged}`);
  console.log(`  Duplicate rows removed:            ${result.duplicatesRemoved}`);
  console.log(`  dmr_reference_wells after:         ${after}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Fatal error:', e);
    prisma.$disconnect();
    process.exit(1);
  });
