// Generates the client mirror of the inspection-checklist catalog from the
// server's single source of truth. The server module is pure (no imports), so
// we copy it verbatim under a "do not edit" banner.
//
//   Source: server/src/services/inspectionChecklist.ts   (authoritative)
//   Output: client/src/lib/inspectionChecklist.ts         (generated, committed)
//
// Run from the repo root:  npm run gen:checklist
//
// The output is committed because the client Docker build context is ./client
// only — server/ is not available at client build time, so the mirror must
// already exist in the tree.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'server', 'src', 'services', 'inspectionChecklist.ts');
const OUT = join(root, 'client', 'src', 'lib', 'inspectionChecklist.ts');

const banner = `// ============================================================================
// AUTO-GENERATED — DO NOT EDIT.
// Mirror of server/src/services/inspectionChecklist.ts (the single source of
// truth for the QA-checklist catalog + gate logic). Regenerate after editing
// the server file:   npm run gen:checklist   (from the repo root)
// ============================================================================

`;

const source = readFileSync(SRC, 'utf8');
writeFileSync(OUT, banner + source, 'utf8');
console.log(`Generated ${OUT} from ${SRC}`);
