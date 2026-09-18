/**
 * printing.ts — low-level ZPL rendering + raw-socket transport.
 *
 * Zebra printers accept ZPL II over a raw TCP socket on port 9100. There is
 * no driver and no ack protocol: a successful socket write is the closest
 * thing to a "print succeeded" signal. These helpers are intentionally dumb —
 * the queue worker (printQueue.ts) owns retries and status.
 */

import net from 'net';
import { workTypeShort, formatLabelDate, unitLine } from './labelFields.js';

const CONNECT_TIMEOUT_MS = 5000;

/** Strip ZPL control chars so interpolated data can't break the label format. */
function sanitizeZplValue(v: string): string {
  return v.replace(/[\^~]/g, ' ');
}

/**
 * Substitute `${variable}` placeholders in a ZPL template. Unknown or
 * null-valued variables render as an empty string.
 */
export function renderLabel(
  template: string,
  vars: Record<string, string | null | undefined>,
): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
    const val = vars[key];
    return val == null ? '' : sanitizeZplValue(String(val));
  });
}

interface SocketTarget {
  ipAddress: string;
  port: number;
}

/**
 * Open a TCP socket to a Zebra printer and write the ZPL `copies` times.
 * Resolves once the socket closes cleanly; rejects on connection error or
 * timeout.
 */
export function sendZpl(printer: SocketTarget, zpl: string, copies = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const socket = net.createConnection(printer.port, printer.ipAddress);
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('connect', () => {
      for (let i = 0; i < Math.max(1, copies); i++) socket.write(zpl);
      socket.end();
    });
    socket.on('close', () => done());
    socket.on('error', err => done(err));
    socket.on('timeout', () => {
      socket.destroy();
      done(new Error('Print timed out — printer unreachable'));
    });
  });
}

/** TCP-connect to a printer and immediately close it — a liveness probe. */
export function pingPrinter(printer: SocketTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const socket = net.createConnection(printer.port, printer.ipAddress);
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.destroy();
      done();
    });
    socket.on('error', err => done(err));
    socket.on('timeout', () => {
      socket.destroy();
      done(new Error('Connection timed out'));
    });
  });
}

/** A throwaway ZPL label for the printer test-print button (300dpi ZD411). */
export function testLabelZpl(printerName: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return [
    '^XA',
    '^FO44,44^A0N,59,59^FDPRINTER TEST^FS',
    `^FO44,133^A0N,41,41^FD${sanitizeZplValue(printerName)}^FS`,
    `^FO44,192^A0N,35,35^FD${stamp}^FS`,
    '^XZ',
  ].join('\n');
}

/**
 * Render the real shop-label template with obviously-sample data so the
 * test-print button shows the exact production layout (customer / job / date /
 * work type / unit line / QR) without inventing a work order. The QR points at
 * a non-existent /shop/sample so a scanned test tag dead-ends harmlessly.
 */
export function sampleLabelZpl(template: string): string {
  const appUrl = process.env.PUBLIC_APP_URL || 'https://service.basinsafetyus.com';
  return renderLabel(template, {
    customerName: 'Sample Customer Co',
    workOrderNumber: 'WO-TEST',
    intakeDate: formatLabelDate(new Date()),
    workType: workTypeShort('fire_extinguisher', 'recharge'),
    unitLine: unitLine(1, 3),
    // Both serial rows filled so a test print exercises the full child-item
    // layout (real order-level labels leave them blank).
    itemSerial: 'SAMPLE-00123',
    parentLine: 'PART OF SAMPLE-00099',
    qrPayload: `${appUrl}/shop/sample`,
  });
}
