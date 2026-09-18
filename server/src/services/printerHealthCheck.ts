/**
 * printerHealthCheck.ts — periodic TCP liveness probe for every active
 * printer. Updates Printer.lastSeenAt on success, Printer.lastError on
 * failure. The admin UI and print-time banner read those fields.
 */

import { prisma } from '../db.js';
import { runScheduledJob } from './jobs.js';
import { heartbeat } from './supervisor.js';
import { pingPrinter } from './printing.js';


const ENABLED = process.env.PRINTER_HEALTH_ENABLED !== 'false';
export const INTERVAL_MS = parseInt(process.env.PRINTER_HEALTH_INTERVAL_MS || '60000', 10);

let timer: ReturnType<typeof setInterval> | null = null;

async function processTick(): Promise<void> {
  const printers = await prisma.printer.findMany({
    where: { active: true },
    select: { id: true, ipAddress: true, port: true },
  });

  for (const p of printers) {
    try {
      await pingPrinter(p);
      await prisma.printer.update({
        where: { id: p.id },
        data: { lastSeenAt: new Date(), lastError: null },
      });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await prisma.printer.update({
        where: { id: p.id },
        data: { lastError: message },
      });
    }
  }
}

export function startPrinterHealthCheck(): void {
  if (!ENABLED) {
    console.log('[PrinterHealth] Skipped — PRINTER_HEALTH_ENABLED=false');
    return;
  }
  console.log(`[PrinterHealth] Starting (every ${INTERVAL_MS / 1000}s)`);
  const run = () => { heartbeat('printer-health'); return runScheduledJob('printer.health-check', 120, processTick); };
  timer = setInterval(run, INTERVAL_MS);
  setTimeout(run, 30_000);
}

export function stopPrinterHealthCheck(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
