/**
 * Auto-clean pad data:
 * 1. Deactivate junk pads ("n/a", "oops", "DO NOT USE", etc.)
 * 2. For duplicate groups where one pad has data and others are empty,
 *    deactivate the empties
 * 3. Report remaining conflicts for manual merge
 */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

function normalizeForGrouping(name: string): string {
  let n = name.toUpperCase();
  // Remove parenthetical suffixes
  n = n.replace(/\([^)]*\)/g, '');
  // Remove common suffixes
  n = n.replace(/\b(CTB|DUAL|PAD|BATTERY|FACILITY|LW)\b/g, '');
  // Remove well identifiers at end
  n = n.replace(/\s*H\d+[-,]?\d*\s*$/g, '');
  n = n.replace(/\s*\d+H\s*$/g, '');
  // Strip punctuation and collapse
  n = n.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return n;
}

async function main() {
  console.log('=== Auto-Clean Pads ===\n');

  // ---- Step 1: Deactivate junk pads ----
  console.log('Step 1: Deactivating junk pads...');
  const junkPatterns = [
    'oops',
    'do not use',
    'dont use',
    "don't use",
    'donotuse',
    'test location',
    'test pad',
    'delete me',
    'deleteme',
  ];

  let junkDeactivated = 0;

  // Handle n/a separately (exact or near-exact match)
  const naPads = await p.pad.findMany({
    where: {
      isActive: true,
      OR: [
        { name: { equals: 'n/a', mode: 'insensitive' } },
        { name: { equals: 'N/A', mode: 'insensitive' } },
        { name: { equals: 'na', mode: 'insensitive' } },
        { name: { equals: 'none', mode: 'insensitive' } },
        { name: { equals: '-', mode: 'insensitive' } },
        { name: { equals: '.', mode: 'insensitive' } },
        { name: { equals: '0', mode: 'insensitive' } },
        { name: { equals: 'x', mode: 'insensitive' } },
        { name: { equals: 'xx', mode: 'insensitive' } },
        { name: { equals: 'xxx', mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, _count: { select: { wells: true, workPoints: true, serviceTickets: true } } },
  });

  for (const pad of naPads) {
    if (pad._count.wells === 0 && pad._count.workPoints === 0 && pad._count.serviceTickets === 0) {
      await p.pad.update({ where: { id: pad.id }, data: { isActive: false } });
      junkDeactivated++;
    }
  }

  for (const pattern of junkPatterns) {
    const junkPads = await p.pad.findMany({
      where: {
        isActive: true,
        name: { contains: pattern, mode: 'insensitive' },
      },
      select: { id: true, name: true, _count: { select: { wells: true, workPoints: true, serviceTickets: true } } },
    });
    for (const pad of junkPads) {
      if (pad._count.wells === 0 && pad._count.workPoints === 0 && pad._count.serviceTickets === 0) {
        await p.pad.update({ where: { id: pad.id }, data: { isActive: false } });
        junkDeactivated++;
        if (junkDeactivated <= 20) console.log('  Deactivated: ' + pad.name);
      }
    }
  }
  console.log('  Total junk deactivated: ' + junkDeactivated);

  // ---- Step 2: Deactivate empty pads in duplicate groups ----
  console.log('\nStep 2: Deactivating empty dupes...');

  const activePads = await p.pad.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      currentOperatorId: true,
      customData: true,
      _count: { select: { wells: true, workPoints: true, serviceTickets: true } },
    },
  });

  // Group by operator + normalized name
  const groups = new Map<string, typeof activePads>();
  for (const pad of activePads) {
    const key = (pad.currentOperatorId || 'none') + '::' + normalizeForGrouping(pad.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(pad);
  }

  let emptyDupesDeactivated = 0;
  let trivialGroupsCleaned = 0;

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Find pads with actual data
    const withData = group.filter(p => p._count.wells > 0 || p._count.workPoints > 0 || p._count.serviceTickets > 0);
    const empty = group.filter(p => p._count.wells === 0 && p._count.workPoints === 0 && p._count.serviceTickets === 0);

    // Only auto-clean if at least one pad has data and there are empty ones
    if (withData.length > 0 && empty.length > 0) {
      for (const emptyPad of empty) {
        await p.pad.update({ where: { id: emptyPad.id }, data: { isActive: false } });
        emptyDupesDeactivated++;
      }
      trivialGroupsCleaned++;
    }

    // Also handle: ALL pads are empty — keep the first one, deactivate rest
    if (withData.length === 0 && empty.length > 1) {
      for (const emptyPad of empty.slice(1)) {
        await p.pad.update({ where: { id: emptyPad.id }, data: { isActive: false } });
        emptyDupesDeactivated++;
      }
      trivialGroupsCleaned++;
    }
  }
  console.log('  Empty dupes deactivated: ' + emptyDupesDeactivated);
  console.log('  Trivial groups cleaned: ' + trivialGroupsCleaned);

  // ---- Step 3: Report remaining conflicts ----
  console.log('\nStep 3: Remaining conflicts needing manual merge...');

  // Reload active pads
  const remaining = await p.pad.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      currentOperatorId: true,
      currentOperator: { select: { name: true } },
      _count: { select: { wells: true, workPoints: true } },
    },
  });

  const remainingGroups = new Map<string, typeof remaining>();
  for (const pad of remaining) {
    const key = (pad.currentOperatorId || 'none') + '::' + normalizeForGrouping(pad.name);
    if (!remainingGroups.has(key)) remainingGroups.set(key, []);
    remainingGroups.get(key)!.push(pad);
  }

  const conflicts = Array.from(remainingGroups.entries())
    .filter(([, pads]) => pads.length > 1)
    .sort((a, b) => {
      const aTotal = a[1].reduce((s, p) => s + p._count.wells + p._count.workPoints, 0);
      const bTotal = b[1].reduce((s, p) => s + p._count.wells + p._count.workPoints, 0);
      return bTotal - aTotal;
    });

  console.log('  Remaining duplicate groups: ' + conflicts.length);
  for (const [, group] of conflicts.slice(0, 15)) {
    console.log('\n  ' + group[0].currentOperator?.name + ':');
    for (const pad of group) {
      console.log('    ' + pad.name + ' | wells=' + pad._count.wells + ' | wp=' + pad._count.workPoints);
    }
  }

  // ---- Summary ----
  const finalActive = await p.pad.count({ where: { isActive: true } });
  const finalInactive = await p.pad.count({ where: { isActive: false } });

  console.log('\n\n=== SUMMARY ===');
  console.log('Junk pads deactivated: ' + junkDeactivated);
  console.log('Empty dupes deactivated: ' + emptyDupesDeactivated);
  console.log('Total deactivated this run: ' + (junkDeactivated + emptyDupesDeactivated));
  console.log('Active pads now: ' + finalActive);
  console.log('Inactive pads: ' + finalInactive);
  console.log('Remaining dupe groups for merge UI: ' + conflicts.length);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
