/**
 * printQueue.ts — background worker that drains the PrintJob queue.
 *
 * Every tick it claims QUEUED jobs (atomic QUEUED -> PRINTING update, so the
 * claim is safe even across multiple API instances), renders the label, and
 * writes ZPL to the printer over a raw socket. Failures retry with
 * exponential backoff up to 3 attempts, then land in FAILED.
 *
 * Postgres-backed rather than BullMQ — keeps the dependency surface small and
 * matches the repo's existing scheduled-job approach.
 */

import { prisma } from '../db.js';
import { renderLabel, sendZpl } from './printing.js';
import { workTypeShort, formatLabelDate, unitLine } from './labelFields.js';
import { heartbeat } from './supervisor.js';


const ENABLED = process.env.PRINT_QUEUE_ENABLED !== 'false';
export const TICK_MS = parseInt(process.env.PRINT_QUEUE_TICK_MS || '8000', 10);
const BATCH = parseInt(process.env.PRINT_QUEUE_BATCH || '10', 10);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 4000, 16000];
// A job stuck in PRINTING this long is assumed orphaned (worker crashed
// mid-send) and gets requeued.
const STALE_PRINTING_MS = 3 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function appBaseUrl(): string {
  return process.env.PUBLIC_APP_URL || 'https://service.basinsafetyus.com';
}

async function processJob(jobId: string): Promise<void> {
  // Atomic claim — only the worker that flips QUEUED -> PRINTING owns the job.
  const claim = await prisma.printJob.updateMany({
    where: { id: jobId, status: 'QUEUED' },
    data: { status: 'PRINTING' },
  });
  if (claim.count !== 1) return;

  const job = await prisma.printJob.findUnique({
    where: { id: jobId },
    include: {
      printer: true,
      template: true,
      shopWorkOrder: {
        select: {
          id: true,
          workOrderNumber: true,
          totalItems: true,
          intakeDate: true,
          primaryCategory: true,
          company: { select: { name: true } },
        },
      },
      shopWorkOrderItem: {
        select: {
          itemNumber: true,
          equipmentCategory: true,
          serviceType: true,
          serialNumber: true,
          parentItem: { select: { serialNumber: true } },
        },
      },
    },
  });
  if (!job) return;

  try {
    if (!job.printer.active) throw new Error('Printer is inactive');
    if (!job.template.active) throw new Error('Label template is inactive');

    // The 2x2 tag (Canva layout): customer, job #, intake date, a work-type
    // shorthand, "Unit N of M", the unit's serial, and a QR deep-link back to
    // the ticket. Sub-components (SCBA bottle/mask/regulator/harness) also get
    // "PART OF <parent serial>" so a loose child tag points back at its
    // assembly. Order-level packet/bin labels (no item) fall back to the
    // order's category + a piece count, with the serial rows blank.
    const wo = job.shopWorkOrder;
    const item = job.shopWorkOrderItem;
    const zpl = renderLabel(job.template.template, {
      customerName: wo.company.name,
      workOrderNumber: wo.workOrderNumber,
      intakeDate: formatLabelDate(wo.intakeDate),
      workType: item
        ? workTypeShort(item.equipmentCategory, item.serviceType)
        : workTypeShort(wo.primaryCategory, null),
      unitLine: item
        ? unitLine(item.itemNumber, wo.totalItems)
        : `${wo.totalItems} PCS`,
      itemSerial: item?.serialNumber ?? null,
      parentLine: item?.parentItem ? `PART OF ${item.parentItem.serialNumber}` : null,
      qrPayload: `${appBaseUrl()}/shop/${wo.id}`,
    });

    await sendZpl(job.printer, zpl, job.copies);

    await prisma.printJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        attempts: { increment: 1 },
        errorMessage: null,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;

    if (attempts >= MAX_ATTEMPTS) {
      await prisma.printJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', attempts, errorMessage: message, completedAt: new Date() },
      });
      console.warn(`[PrintQueue] job ${job.id} FAILED after ${attempts} attempts: ${message}`);
    } else {
      await prisma.printJob.update({
        where: { id: job.id },
        data: {
          status: 'QUEUED',
          attempts,
          errorMessage: message,
          nextAttemptAt: new Date(Date.now() + BACKOFF_MS[attempts - 1]),
        },
      });
    }
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Reclaim orphaned PRINTING jobs from a crashed worker.
    await prisma.printJob.updateMany({
      where: { status: 'PRINTING', updatedAt: { lt: new Date(Date.now() - STALE_PRINTING_MS) } },
      data: { status: 'QUEUED' },
    });

    const now = new Date();
    const jobs = await prisma.printJob.findMany({
      where: {
        status: 'QUEUED',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true },
    });
    for (const j of jobs) await processJob(j.id);
  } catch (err) {
    console.warn('[PrintQueue] tick error:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

export function startPrintQueueProcessor(): void {
  if (!ENABLED) {
    console.log('[PrintQueue] Skipped — PRINT_QUEUE_ENABLED=false');
    return;
  }
  console.log(`[PrintQueue] Starting worker (tick every ${TICK_MS / 1000}s)`);
  timer = setInterval(() => { heartbeat('print-queue'); void tick(); }, TICK_MS);
}

export function stopPrintQueueProcessor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
