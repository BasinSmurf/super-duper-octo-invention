import { readFileSync } from 'node:fs';
import type { Prisma } from '../db.js';

type Scope = { invoiceIds: string[]; companyIds: string[] };
const TEST_FILE = 'C:\\Basin Test Company QB 2026\\TEST BASIN TEST 2026.qbw';

/** Fail closed: this opt-in load-test scope can never run against production. */
export function loadSandboxQbScope(env: NodeJS.ProcessEnv, read = readFileSync): Scope | null {
  if (!env.QBWC_SANDBOX_MANIFEST) return null;
  const db = new URL(env.DATABASE_URL || '');
  if (db.hostname !== '127.0.0.1' || db.port !== '5435' || db.pathname !== '/sandbox'
      || env.QBWC_COMPANY_FILE !== TEST_FILE || env.QBWC_RUN_EVERY_N_MINUTES !== '0') {
    throw Error('QB sandbox scope requires the local sandbox database, pinned TEST company, and manual pulls');
  }
  const scope = JSON.parse(read(env.QBWC_SANDBOX_MANIFEST, 'utf8') as string);
  for (const key of ['invoiceIds', 'companyIds']) {
    if (!Array.isArray(scope[key]) || !scope[key].length
        || scope[key].some((id: unknown) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
      throw Error(`Invalid QB sandbox manifest ${key}`);
    }
  }
  return { invoiceIds: scope.invoiceIds, companyIds: scope.companyIds };
}

export function sandboxQueueFilter(scope: Scope | null): Prisma.QbSyncQueueWhereInput {
  return scope ? { OR: [
    { entityType: 'customer', action: { in: ['add', 'query'] }, entityId: { in: scope.companyIds } },
    { entityType: { in: ['invoice', 'sales_order'] }, action: { in: ['add', 'query'] }, entityId: { in: scope.invoiceIds } },
  ] } : {};
}
