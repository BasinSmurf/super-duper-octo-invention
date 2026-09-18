/**
 * Compare buyer-rule dumps across all customers and surface the divergent fields.
 *
 * Input:  the JSON file produced by dump-enverus-buyer-rules.ts
 * Output: console table of divergent fields, plus optional markdown report.
 *
 * Each rule entry shape:
 *   { visible: bool, editable?: bool, requiredOn?: 'Submit'|..., customLabel?: string }
 *
 * Run:
 *   npx tsx scripts/compare-enverus-buyer-rules.ts \
 *     scripts/data/enverus-buyer-rules-lem-<ts>.json [--out report.md]
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

interface RuleSpec {
  visible?: boolean;
  editable?: boolean;
  requiredOn?: string;
  customLabel?: string;
  [k: string]: unknown;
}

interface DumpEntry {
  duns: string;
  customerNames: string[];
  status: 'ok' | 'error';
  body?: Record<string, RuleSpec> | unknown;
}

interface Dump {
  results: DumpEntry[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  let inputFile = '';
  let outFile = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') outFile = args[++i];
    else if (!a.startsWith('--')) inputFile = a;
  }
  if (!inputFile) {
    console.error(
      'usage: tsx compare-enverus-buyer-rules.ts <dump.json> [--out report.md]',
    );
    process.exit(1);
  }
  return { inputFile, outFile };
}

// Compact cell representation
//   -  = field missing on this buyer
//   R  = required (requiredOn set)
//   O  = optional (visible & editable, no requiredOn)
//   RO = read-only (visible but not editable)
//   ?  = present but visible: false (effectively hidden)
function cellOf(spec: RuleSpec | undefined): string {
  if (!spec) return '-';
  if (spec.visible === false) return '?';
  if (spec.requiredOn) return 'R';
  if (spec.editable === false) return 'RO';
  return 'O';
}

function labelOf(spec: RuleSpec | undefined): string | null {
  return spec && spec.customLabel ? String(spec.customLabel) : null;
}

function shortName(names: string[]): string {
  const n = names[0] || '';
  return n.length > 22 ? n.slice(0, 21) + '…' : n;
}

function main() {
  const { inputFile, outFile } = parseArgs();
  const dump = JSON.parse(readFileSync(inputFile, 'utf-8')) as Dump;

  const buyers = dump.results.filter(
    (r): r is DumpEntry & { body: Record<string, RuleSpec> } =>
      r.status === 'ok' && !!r.body && typeof r.body === 'object',
  );

  if (buyers.length === 0) {
    console.error('No ok buyers in dump');
    process.exit(1);
  }

  // Collect every field name across every buyer
  const allFields = new Set<string>();
  for (const b of buyers) for (const k of Object.keys(b.body)) allFields.add(k);
  const fields = [...allFields].sort();

  // Per-field: gather (cell, label) per buyer; flag as divergent if cells/labels differ
  type FieldRow = {
    field: string;
    cells: string[]; // one per buyer
    labels: (string | null)[]; // one per buyer
    divergent: boolean;
    cellCounts: Map<string, number>;
    labelCounts: Map<string, number>;
  };

  const rows: FieldRow[] = fields.map((f) => {
    const cells: string[] = [];
    const labels: (string | null)[] = [];
    const cellCounts = new Map<string, number>();
    const labelCounts = new Map<string, number>();
    for (const b of buyers) {
      const c = cellOf(b.body[f]);
      const l = labelOf(b.body[f]);
      cells.push(c);
      labels.push(l);
      cellCounts.set(c, (cellCounts.get(c) || 0) + 1);
      const lk = l ?? '(none)';
      labelCounts.set(lk, (labelCounts.get(lk) || 0) + 1);
    }
    const divergent =
      new Set(cells).size > 1 ||
      new Set(labels.map((l) => l ?? '(none)')).size > 1;
    return { field: f, cells, labels, divergent, cellCounts, labelCounts };
  });

  const divergent = rows.filter((r) => r.divergent);
  const universal = rows.filter((r) => !r.divergent);

  // ── Console summary ────────────────────────────────────────────────
  console.log(`buyers:    ${buyers.length}`);
  console.log(`fields:    ${fields.length} total`);
  console.log(`universal: ${universal.length} (same shape on every buyer — hidden)`);
  console.log(`divergent: ${divergent.length}`);
  console.log('');

  // Always-required (R on every buyer) is useful baseline
  const alwaysRequired = universal
    .filter((r) => r.cells.every((c) => c === 'R'))
    .map((r) => r.field);
  if (alwaysRequired.length) {
    console.log(`always required (${alwaysRequired.length}): ${alwaysRequired.join(', ')}`);
    console.log('');
  }

  // Top divergence summary
  console.log('=== top divergent fields ===');
  for (const r of divergent.slice(0, 30)) {
    const cellSummary = [...r.cellCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c}×${n}`)
      .join(' ');
    const labelSummary =
      r.labelCounts.size > 1
        ? '  labels:{' +
          [...r.labelCounts.entries()]
            .filter(([l]) => l !== '(none)')
            .map(([l, n]) => `"${l}"×${n}`)
            .join(', ') +
          '}'
        : '';
    console.log(`  ${r.field.padEnd(28)} ${cellSummary}${labelSummary}`);
  }
  if (divergent.length > 30) {
    console.log(`  …and ${divergent.length - 30} more (see markdown report)`);
  }

  // ── Markdown report ────────────────────────────────────────────────
  if (outFile) {
    const lines: string[] = [];
    lines.push(`# Enverus buyer-rule divergence`);
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Source:    ${path.basename(inputFile)}`);
    lines.push(`Buyers:    ${buyers.length}`);
    lines.push(
      `Fields:    ${fields.length} total — ${universal.length} universal, ${divergent.length} divergent`,
    );
    lines.push('');
    lines.push('Cells: `R`=required, `O`=optional, `RO`=read-only, `?`=hidden, `-`=field missing on buyer');
    lines.push('');

    if (alwaysRequired.length) {
      lines.push(`## Always required across all ${buyers.length} buyers`);
      lines.push('');
      lines.push(alwaysRequired.map((f) => `\`${f}\``).join(', '));
      lines.push('');
    }

    lines.push('## Divergent fields — wide matrix');
    lines.push('');
    const header = ['field', ...buyers.map((b) => `${shortName(b.customerNames)} (${b.duns})`)];
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push('|' + header.map(() => '---').join('|') + '|');
    for (const r of divergent) {
      const row = [r.field, ...r.cells.map((c, i) => {
        const lbl = r.labels[i];
        return lbl ? `${c}*` : c;
      })];
      lines.push('| ' + row.join(' | ') + ' |');
    }
    lines.push('');
    lines.push('Cells marked `*` have a `customLabel`; see per-field detail below.');
    lines.push('');

    lines.push('## Divergent fields — per-field detail');
    lines.push('');
    for (const r of divergent) {
      lines.push(`### \`${r.field}\``);
      lines.push('');
      const cellTally = [...r.cellCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `\`${c}\` × ${n}`)
        .join(', ');
      lines.push(`Cells: ${cellTally}`);
      if (r.labelCounts.size > 1 || (r.labelCounts.size === 1 && !r.labelCounts.has('(none)'))) {
        const labelTally = [...r.labelCounts.entries()]
          .map(([l, n]) => `${l === '(none)' ? '_no label_' : `"${l}"`} × ${n}`)
          .join(', ');
        lines.push('');
        lines.push(`Labels: ${labelTally}`);
      }
      lines.push('');
      // Per-buyer drill-down only if interesting
      const interesting: string[] = [];
      for (let i = 0; i < buyers.length; i++) {
        const c = r.cells[i];
        const l = r.labels[i];
        const tag = c === '-' ? 'missing' : c === 'R' ? 'required' : c === 'O' ? 'optional' : c;
        const labelStr = l ? ` (label: "${l}")` : '';
        interesting.push(`- **${buyers[i].customerNames[0]}** \`${buyers[i].duns}\` — ${tag}${labelStr}`);
      }
      lines.push(interesting.join('\n'));
      lines.push('');
    }

    writeFileSync(outFile, lines.join('\n'), 'utf-8');
    console.log('');
    console.log(`wrote markdown report → ${outFile}`);
  }
}

main();
