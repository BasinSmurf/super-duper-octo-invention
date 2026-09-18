/**
 * qbInvoiceDiffWatcher.ts
 *
 * Wave 4 Slice F — periodically queues a fresh InvoiceQuery against QB for
 * each Sundog invoice that already has a qbInvoiceTxnId. The QBWC response
 * handler (qbwc.ts) compares QB's total + line count against Sundog's and
 * flags any divergence on Invoice.qbDiff*.
 *
 * Sundog is canonical. This watcher detects divergence; auto-correction
 * (push InvoiceMod back to QB) is deferred to a follow-up slice.
 *
 * Watch window — exits naturally on:
 *   - Invoice status terminal (paid/voided/closed)         → state exit
 *   - Invoice older than DIFF_MAX_AGE_DAYS (default 90)    → time exit
 *   - qbLastCheckedAt within DIFF_COOLING_HOURS (default 6) → cooling off
 *
 * That triple-cap keeps the active watch window to a few hundred invoices
 * even on a long-running install.
 */

import { prisma } from '../db.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';


const ENABLED = process.env.QB_INVOICE_DIFF_ENABLED !== 'false';
export const CHECK_INTERVAL_MS = parseInt(
  process.env.QB_INVOICE_DIFF_CHECK_INTERVAL_MS || `${30 * 60 * 1000}`, // 30 min
  10,
);
const COOLING_HOURS = parseInt(process.env.QB_INVOICE_DIFF_COOLING_HOURS || '6', 10);
const MAX_AGE_DAYS = parseInt(process.env.QB_INVOICE_DIFF_MAX_AGE_DAYS || '90', 10);
const BATCH_SIZE = parseInt(process.env.QB_INVOICE_DIFF_BATCH || '20', 10);

let timer: ReturnType<typeof setInterval> | null = null;

async function processTick(): Promise<void> {
  const now = Date.now();
  const coolingCutoff = new Date(now - COOLING_HOURS * 60 * 60 * 1000);
  const ageCutoff = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  // Candidates: Sundog invoice has a QB TxnID, isn't terminal, isn't too old,
  // and hasn't been checked recently. Sundog statuses we treat as terminal:
  // 'paid' (collected), 'void' (cancelled). 'closed' if/when added.
  const candidates = await prisma.invoice.findMany({
    where: {
      qbInvoiceTxnId: { not: null },
      status: { notIn: ['paid', 'void'] },
      createdAt: { gte: ageCutoff },
      OR: [
        { qbLastCheckedAt: null },
        { qbLastCheckedAt: { lt: coolingCutoff } },
      ],
    },
    select: { id: true, invoiceNumber: true },
    orderBy: { qbLastCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: BATCH_SIZE,
  });

  if (candidates.length === 0) return;

  let queued = 0;
  for (const inv of candidates) {
    // Skip if a query is already in flight for this invoice (avoid stacking)
    const existing = await prisma.qbSyncQueue.findFirst({
      where: {
        entityType: 'invoice',
        action: 'query',
        entityId: inv.id,
        status: { in: ['pending', 'sent'] },
      },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.qbSyncQueue.create({
      data: {
        entityType: 'invoice',
        action: 'query',
        entityId: inv.id,
        status: 'pending',
        priority: 20, // lower than SO push (5) and SO-conversion query (10)
      },
    });
    queued++;
  }

  if (queued > 0) {
    console.log(`[QB Diff] Queued ${queued} InvoiceQuery diff check${queued === 1 ? '' : 's'}`);
  }
}

export function startQbInvoiceDiffWatcher(): void {
  if (!ENABLED) {
    console.log('[QB Diff] Skipped — QB_INVOICE_DIFF_ENABLED=false');
    return;
  }

  console.log(
    `[QB Diff] Starting watcher (check every ${CHECK_INTERVAL_MS / 1000}s, cooling ${COOLING_HOURS}h, max age ${MAX_AGE_DAYS}d)`,
  );

  // TTL = 10 min — generous; the job just enqueues, doesn't wait for QBWC.
  const runTick = () => { heartbeat('qb-diff'); return runScheduledJob('qb.invoice-diff', 600, processTick); };

  timer = setInterval(runTick, CHECK_INTERVAL_MS);
  // Slight startup delay so we don't enqueue before the API is fully warm.
  setTimeout(runTick, 60_000);
}

export function stopQbInvoiceDiffWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
