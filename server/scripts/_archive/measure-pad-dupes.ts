import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Load all active pads with their well counts, work point counts, and operator
  const pads = await p.pad.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      fieldId: true,
      currentOperatorId: true,
      customData: true,
      _count: { select: { wells: true, workPoints: true } },
    },
  });

  console.log('Total active pads: ' + pads.length);

  // Normalize pad names for fuzzy grouping
  function normalize(name: string): string {
    return name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, ' ')  // strip punctuation
      .replace(/\s+/g, ' ')          // collapse whitespace
      .trim();
  }

  // More aggressive normalize: strip H-numbers, well suffixes, facility tags
  function normalizeAggressive(name: string): string {
    let n = name.toUpperCase();
    // Remove parenthetical suffixes like "(New)", "(Keene)", "(10116 Facility)"
    n = n.replace(/\([^)]*\)/g, '');
    // Remove common suffixes: CTB, DUAL, PAD, BATTERY, FACILITY, LW
    n = n.replace(/\b(CTB|DUAL|PAD|BATTERY|FACILITY|LW)\b/g, '');
    // Remove well identifiers like H1-7, H2, -1H, etc. at end
    n = n.replace(/\s*H\d+[-,]?\d*\s*$/g, '');
    n = n.replace(/\s*\d+H\s*$/g, '');
    // Strip punctuation and collapse
    n = n.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    return n;
  }

  // Group by same operator + similar name
  const groups = new Map<string, typeof pads>();

  for (const pad of pads) {
    const key = (pad.currentOperatorId || 'none') + '::' + normalizeAggressive(pad.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(pad);
  }

  // Find groups with multiple pads (potential dupes)
  const dupeGroups = Array.from(groups.entries())
    .filter(([, pads]) => pads.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  console.log('\nPotential duplicate groups (same operator + similar name): ' + dupeGroups.length);

  let totalDupePads = 0;
  let groupsWithData = 0; // groups where multiple pads have wells or work points

  for (const [key, group] of dupeGroups.slice(0, 30)) {
    const padsWithWells = group.filter(p => p._count.wells > 0);
    const padsWithWPs = group.filter(p => p._count.workPoints > 0);
    const hasConflict = padsWithWells.length > 1 || padsWithWPs.length > 1;

    if (hasConflict) groupsWithData++;
    totalDupePads += group.length;

    console.log('\n  [' + group.length + ' pads] ' + key.split('::')[1]);
    for (const pad of group) {
      const cd = pad.customData as any;
      console.log('    ' + pad.name + ' | wells=' + pad._count.wells + ' | wp=' + pad._count.workPoints + ' | azLoc=' + (cd?.azureLocationId || '-'));
    }
  }

  // Summary stats
  const emptyPads = pads.filter(p => p._count.wells === 0 && p._count.workPoints === 0);
  const wellOnlyPads = pads.filter(p => p._count.wells > 0 && p._count.workPoints === 0);
  const wpOnlyPads = pads.filter(p => p._count.wells === 0 && p._count.workPoints > 0);
  const bothPads = pads.filter(p => p._count.wells > 0 && p._count.workPoints > 0);

  console.log('\n\n=== SUMMARY ===');
  console.log('Active pads: ' + pads.length);
  console.log('  Empty (no wells, no WPs): ' + emptyPads.length);
  console.log('  Wells only: ' + wellOnlyPads.length);
  console.log('  Work points only: ' + wpOnlyPads.length);
  console.log('  Both wells + WPs: ' + bothPads.length);
  console.log('\nDuplicate groups: ' + dupeGroups.length);
  console.log('  Total pads in dupe groups: ' + totalDupePads);
  console.log('  Groups with conflicting data (>1 pad has wells/WPs): ' + groupsWithData);
  console.log('  Groups where merge is trivial (1 pad has data, rest empty): ' + (dupeGroups.length - groupsWithData));

  // Count how many we could auto-merge vs need human review
  let autoMergeable = 0;
  let needsReview = 0;
  for (const [, group] of dupeGroups) {
    const withWells = group.filter(p => p._count.wells > 0);
    const withWPs = group.filter(p => p._count.workPoints > 0);
    if (withWells.length <= 1 && withWPs.length <= 1) {
      autoMergeable++;
    } else {
      needsReview++;
    }
  }
  console.log('\n  Auto-mergeable (clear winner): ' + autoMergeable);
  console.log('  Needs human review: ' + needsReview);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
