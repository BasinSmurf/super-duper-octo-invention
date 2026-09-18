/**
 * Import air system data from Azure AirSystem + AirBottle CSVs into Prisma WorkPoints.
 *
 * Data flow:
 *   AirSystem.LocationId → pad.customData.azureLocationId → WorkPoint.padId
 *   AirSystem serial numbers → WorkPoint.reelSerialNumber / standSerialNumber
 *   AirBottle.SystemId → AirSystem.Id → stored as JSONB in WorkPoint.customData.bottles
 *   Wells with air systems → well.hasSuppliedAir = true
 *
 * Usage:
 *   npx tsx server/scripts/import-air-systems.ts
 */

import { prisma } from '../src/db.js';
import * as fs from 'fs';


// ----- CSV Parsing -----
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
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
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }
  return rows;
}

// ----- Name → WorkPointType mapping -----
function inferWorkPointName(name: string): string {
  // Normalize the name slightly for consistency
  const lower = name.toLowerCase().trim();

  if (lower.includes('wellhead') || lower.includes('well head')) return 'Wellhead';
  if (lower.includes('separator') || lower.includes('seperator')) return 'Separator';
  if (lower.includes('treater')) return 'Treater';
  if (lower.includes('tank')) return name.trim(); // Keep original casing — "Tank Battery", "South Tanks", etc
  if (lower.includes('truck cylinder')) return 'Truck Cylinder';
  if (lower.includes('compressor')) return name.trim();
  if (lower.includes('pig launcher')) return 'Pig Launcher';
  if (lower.includes('receiver')) return 'Receiver';
  if (lower.includes('building')) return name.trim();

  return name.trim();
}

async function main() {
  const airSystemPath = 'C:/Users/mbart/OneDrive/Desktop/NOTREBLE/AirSystem_202602191538.csv';
  const airBottlePath = 'C:/Users/mbart/OneDrive/Desktop/NOTREBLE/AirBottle_202602191700.csv';

  console.log('=== Air System Import ===\n');

  // 1. Parse CSVs
  console.log('Parsing CSVs...');
  const airSystems = parseCSV(airSystemPath);
  const airBottles = parseCSV(airBottlePath);
  console.log(`  AirSystem rows: ${airSystems.length}`);
  console.log(`  AirBottle rows: ${airBottles.length}`);

  // 2. Build bottle lookup: SystemId → bottles[]
  console.log('\nBuilding bottle lookup by SystemId...');
  const bottlesBySystem = new Map<string, Array<{
    id: string;
    serialNumber: string;
    hydroDate: string | null;
    status: number;
  }>>();

  for (const b of airBottles) {
    const sysId = b.SystemId;
    if (!sysId) continue;

    const entry = {
      id: b.Id,
      serialNumber: (b.SerialNumber || '').trim(),
      hydroDate: b.HydroDate && b.HydroDate !== '' ? b.HydroDate.split(' ')[0] : null, // Just date part
      status: parseInt(b.Status) || 0,
    };

    if (!bottlesBySystem.has(sysId)) {
      bottlesBySystem.set(sysId, []);
    }
    bottlesBySystem.get(sysId)!.push(entry);
  }
  console.log(`  Unique system IDs with bottles: ${bottlesBySystem.size}`);

  // 3. Build pad lookup: azureLocationId → pad record
  console.log('\nLoading pads with azureLocationId from customData...');
  const allPads = await prisma.pad.findMany({
    where: { customData: { not: undefined } },
    select: { id: true, name: true, customData: true },
  });

  const padByAzureLocId = new Map<number, { id: string; name: string }>();
  let padsWithAzureId = 0;

  for (const pad of allPads) {
    const cd = pad.customData as any;
    if (cd && cd.azureLocationId) {
      const azId = typeof cd.azureLocationId === 'number' ? cd.azureLocationId : parseInt(cd.azureLocationId);
      if (!isNaN(azId)) {
        padByAzureLocId.set(azId, { id: pad.id, name: pad.name });
        padsWithAzureId++;
      }
    }
  }
  console.log(`  Pads with azureLocationId: ${padsWithAzureId}`);

  // 4. Also build a well lookup for pads — we'll set hasSuppliedAir on wells
  // Get wells per pad to set the flag
  console.log('Loading wells per pad...');
  const wellsByPad = new Map<string, string[]>();
  const allWells = await prisma.well.findMany({
    where: { padId: { not: null } },
    select: { id: true, padId: true },
  });
  for (const w of allWells) {
    if (!w.padId) continue;
    if (!wellsByPad.has(w.padId)) wellsByPad.set(w.padId, []);
    wellsByPad.get(w.padId)!.push(w.id);
  }
  console.log(`  Wells loaded: ${allWells.length}`);

  // 5. Delete existing work points (since they got wiped and we're reimporting)
  const existingWpCount = await prisma.workPoint.count();
  console.log(`\nExisting work points: ${existingWpCount}`);
  if (existingWpCount > 0) {
    console.log('  Deleting existing work points...');
    await prisma.workPoint.deleteMany({});
    console.log('  Deleted.');
  }

  // 6. Import air systems as work points
  console.log('\nImporting air systems as WorkPoints...');

  let created = 0;
  let skippedDeleted = 0;
  let skippedNoLocation = 0;
  let skippedNoPadMatch = 0;
  const unmatchedLocationIds = new Set<number>();
  const padsWithAirSystems = new Set<string>();

  // Batch for efficiency
  const BATCH_SIZE = 100;
  const workPointsToCreate: any[] = [];

  for (const sys of airSystems) {
    // Skip deleted records
    if (sys.IsDeleted === '1') {
      skippedDeleted++;
      continue;
    }

    const azureLocId = parseInt(sys.LocationId);
    if (!azureLocId || isNaN(azureLocId)) {
      skippedNoLocation++;
      continue;
    }

    const pad = padByAzureLocId.get(azureLocId);
    if (!pad) {
      unmatchedLocationIds.add(azureLocId);
      skippedNoPadMatch++;
      continue;
    }

    const azureSystemId = sys.Id;
    const isActive = sys.Status === '0'; // Status 0 = active in Azure
    const name = inferWorkPointName(sys.Name || 'Tank Battery');
    const reelSerial = sys.ReelSerialNumber?.trim() || null;
    const standSerial = sys.StandSerialNumber?.trim() || null;

    // Get bottles for this system
    const bottles = bottlesBySystem.get(azureSystemId) || [];
    const activeBottles = bottles.filter(b => b.status === 0);

    // Build customData
    const customData: any = {
      azureAirSystemId: parseInt(azureSystemId),
      azureLocationId: azureLocId,
      azureType: parseInt(sys.Type) || 0,
      azureDateCreated: sys.DateCreated || null,
      azureDateModified: sys.DateModified || null,
    };

    if (bottles.length > 0) {
      customData.bottles = bottles.map(b => ({
        azureBottleId: parseInt(b.id),
        serialNumber: b.serialNumber,
        hydroDate: b.hydroDate,
        isActive: b.status === 0,
      }));
      customData.activeBottleCount = activeBottles.length;
      customData.totalBottleCount = bottles.length;
    }

    workPointsToCreate.push({
      name,
      workPointType: 'air_system_location' as const,
      padId: pad.id,
      hasSuppliedAir: true,
      hasAreaMonitor: false,
      reelSerialNumber: reelSerial,
      standSerialNumber: standSerial,
      airSystemType: name, // Use the name as the type descriptor
      legacyAirSystemId: azureSystemId,
      isActive,
      customData,
    });

    padsWithAirSystems.add(pad.id);
    created++;
  }

  // Execute in batches
  console.log(`\nCreating ${workPointsToCreate.length} WorkPoints in batches of ${BATCH_SIZE}...`);
  let batchNum = 0;
  for (let i = 0; i < workPointsToCreate.length; i += BATCH_SIZE) {
    const batch = workPointsToCreate.slice(i, i + BATCH_SIZE);
    await prisma.workPoint.createMany({ data: batch });
    batchNum++;
    if (batchNum % 5 === 0) {
      console.log(`  Batch ${batchNum}: ${Math.min(i + BATCH_SIZE, workPointsToCreate.length)} / ${workPointsToCreate.length}`);
    }
  }

  // 7. Set hasSuppliedAir on wells at pads that have air systems
  console.log('\nSetting hasSuppliedAir on wells at air system pads...');
  let wellsUpdated = 0;
  for (const padId of padsWithAirSystems) {
    const wellIds = wellsByPad.get(padId);
    if (wellIds && wellIds.length > 0) {
      await prisma.well.updateMany({
        where: { id: { in: wellIds } },
        data: { hasSuppliedAir: true },
      });
      wellsUpdated += wellIds.length;
    }
  }

  // 8. Try to relink orphaned AirSystemInspection records
  console.log('\nChecking for orphaned AirSystemInspection records...');
  const orphanedInspections = await prisma.airSystemInspection.findMany({
    where: { workPointId: { equals: null as any } },
    select: { id: true, workPointId: true },
  });

  // Also check ones that reference non-existent work points
  const allInspections = await prisma.airSystemInspection.findMany({
    select: { id: true, workPointId: true },
  });
  let orphanCount = 0;
  for (const insp of allInspections) {
    if (!insp.workPointId) {
      orphanCount++;
      continue;
    }
    const wp = await prisma.workPoint.findUnique({ where: { id: insp.workPointId } });
    if (!wp) orphanCount++;
  }

  console.log(`  Total inspections: ${allInspections.length}`);
  console.log(`  Orphaned (null or missing workPointId): ${orphanCount}`);

  // 9. Summary
  console.log('\n=== Import Summary ===');
  console.log(`Air system records in CSV: ${airSystems.length}`);
  console.log(`  - Skipped (deleted):        ${skippedDeleted}`);
  console.log(`  - Skipped (no location ID):  ${skippedNoLocation}`);
  console.log(`  - Skipped (no pad match):    ${skippedNoPadMatch}`);
  console.log(`  - Created as WorkPoints:     ${created}`);
  console.log(`\nBottle records in CSV: ${airBottles.length}`);
  console.log(`  - Linked to work points via customData.bottles`);
  console.log(`\nPads with air systems: ${padsWithAirSystems.size}`);
  console.log(`Wells flagged hasSuppliedAir: ${wellsUpdated}`);

  if (unmatchedLocationIds.size > 0) {
    console.log(`\nUnmatched Azure Location IDs (${unmatchedLocationIds.size}):`);
    const sorted = Array.from(unmatchedLocationIds).sort((a, b) => a - b);
    // Show first 20
    const sample = sorted.slice(0, 20);
    console.log(`  Sample: ${sample.join(', ')}${sorted.length > 20 ? ` ... and ${sorted.length - 20} more` : ''}`);
  }

  // Verify
  const finalCount = await prisma.workPoint.count();
  const activeCount = await prisma.workPoint.count({ where: { isActive: true } });
  const wellsWithAir = await prisma.well.count({ where: { hasSuppliedAir: true } });
  console.log(`\n=== Verification ===`);
  console.log(`Total WorkPoints in DB: ${finalCount}`);
  console.log(`  Active: ${activeCount}`);
  console.log(`  Inactive: ${finalCount - activeCount}`);
  console.log(`Wells with hasSuppliedAir: ${wellsWithAir}`);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
