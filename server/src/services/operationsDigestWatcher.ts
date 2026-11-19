import { prisma } from '../db.js';
import { getOperationsReport } from './operationsReport.js';
import { digestSlot, deliverOperationsDigest, renderOperationsDigest } from './operationsDigest.js';
import { mailerConfigured, sendMail, FROM_ADDRESS } from './mailer.js';
import { runScheduledJob } from './jobs.js';
import { REPORT_TYPES, canReceiveReport, reportPreferences, selectReport } from './reportSubscriptions.js';
import { heartbeat } from './supervisor.js';

export const CHECK_INTERVAL_MS = 15 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let initial: ReturnType<typeof setTimeout> | null = null;
async function tick() {
  if (!mailerConfigured || !process.env.PUBLIC_APP_URL) return;
  const now = new Date();
  const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, email: true, role: true, notificationPrefs: true } });
  const recipients = users.flatMap(u => {
    const prefs = reportPreferences(u.notificationPrefs);
    return REPORT_TYPES.flatMap(type => {
      if (!canReceiveReport(u.role, type.id)) return [];
      const slot = digestSlot(prefs[type.id]?.cadence, now, process.env.OPS_DIGEST_TIMEZONE || 'America/Chicago');
      return slot && u.email ? [{ ...u, slot, type }] : [];
    });
  });
  if (!recipients.length) return;
  const report = await getOperationsReport(prisma, now);
  const failures: string[] = [];
  for (const u of recipients) {
    const scoped = selectReport(report, u.type.id);
    const html = renderOperationsDigest(scoped, process.env.PUBLIC_APP_URL, u.type.id, u.type.name);
    try {
      await deliverOperationsDigest(prisma, `${u.id}:${u.type.id}`, u.slot, async () => {
        await sendMail({ from: FROM_ADDRESS, to: u.email, subject: `${u.type.name} — ${report.date}`, html });
      }, now);
    } catch (err) { failures.push(`${u.id}: ${String(err)}`) }
  }
  if (failures.length) throw new Error(failures.join('; '));
}
export function startOperationsDigestWatcher() {
  // Explicit rollout switch; tests and sandbox never send email merely by starting the server.
  if (process.env.OPS_DIGEST_ENABLED !== 'true') return;
  const run = () => { heartbeat('operations-digest'); void runScheduledJob('operations.digest', 600, tick) };
  timer = setInterval(run, CHECK_INTERVAL_MS);
  initial = setTimeout(run, 60_000);
}
export function stopOperationsDigestWatcher() {
  if (timer) clearInterval(timer);
  if (initial) clearTimeout(initial);
  timer = initial = null;
}
