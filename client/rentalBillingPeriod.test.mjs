import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('./src/lib/rentalBillingPeriod.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { defaultRentalBillingPeriod: period } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('15th to EOM then 1st to pickup on the 5th', () => {
  assert.deepEqual(period({ startDate:'2026-06-15' }), { start:'2026-06-15', end:'2026-06-30' });
  assert.deepEqual(period({ startDate:'2026-06-15', lastBilledThrough:'2026-06-30', endDate:'2026-07-05' }), { start:'2026-07-01', end:'2026-07-05' });
});
test('unfinished month and overdue closed rentals remain calendar bounded', () => {
  assert.deepEqual(period({ startDate:'2024-02-15', endDate:'2024-03-05' }), { start:'2024-02-15', end:'2024-02-29' });
  assert.deepEqual(period({ startDate:'2026-06-15', lastBilledThrough:'2026-06-20T00:00:00.000Z' }), { start:'2026-06-21', end:'2026-06-30' });
});
