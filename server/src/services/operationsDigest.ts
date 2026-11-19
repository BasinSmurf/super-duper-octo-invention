import type { PrismaClient } from '../db.js';
import type { OperationsReport, OperationsRow } from './operationsReport.js';

export function digestSlot(cadence: string | undefined, now: Date, timezone = 'America/Chicago'): string | null {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const part = (name: string) => parts.find(p => p.type === name)?.value;
  if (Number(part('hour')) < 7 || !['daily', 'weekly'].includes(cadence ?? '')) return null;
  if (cadence === 'weekly' && part('weekday') !== 'Mon') return null;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function renderOperationsDigest(report: OperationsReport, baseUrl: string, reportType = 'operations', title = 'Daily operations report'): string {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('PUBLIC_APP_URL must use HTTP or HTTPS');
  const section = (title: string, rows: OperationsRow[]) => `<h2>${title} (${rows.length})</h2><ul>${rows.slice(0, 100).map(r => `<li><a href="${escapeHtml(new URL(r.href, base).href)}">${escapeHtml(r.number)}</a> — ${escapeHtml(r.customer)} — ${escapeHtml(r.owner ?? 'Unassigned / unknown')} — ${r.ageDays}d since ${escapeHtml(r.ageBasis)} — ${escapeHtml([r.coverage, r.overdue ? 'OVERDUE' : '', r.detail].filter(Boolean).join(' · '))}</li>`).join('')}</ul>${rows.length > 100 ? '<p>First 100 shown; open the full report for all records.</p>' : ''}`;
  return `<h1>${escapeHtml(title)}</h1><p>Snapshot ${escapeHtml(report.generatedAt)}</p><p>${escapeHtml(report.dateBasis)}</p><p>${Object.entries(report.amounts).map(([stage, total]) => `${stage === 'accepted' ? 'QB accepted' : stage}: $${total.toFixed(2)}`).join(' · ')}</p><p>Last connector contact: ${report.lastConnectorContactAt ?? 'Not recorded'}; last successful QB response: ${report.lastSuccessfulQbResponseAt ?? 'Not recorded'}</p>${reportType === 'operations' ? `<p>${escapeHtml(report.coverageBasis)}</p>${section('Jobs in progress / scheduled', report.jobs)}${section('Coverage update', report.coverage)}` : ''}${section('Actionable exceptions', report.exceptions)}<p><a href="${escapeHtml(new URL(`/operations-report?type=${encodeURIComponent(reportType)}`, base).href)}">Open current report</a></p>`;
}

/** Unique durable claim prevents duplicate sends across processes/restarts, even without Redis.
 * A crash during delivery leaves 'running' for manual reconciliation: never blindly resend an ambiguous email. */
export async function deliverOperationsDigest(db: PrismaClient, userId: string, slot: string, send: () => Promise<void>, now = new Date()) {
  const id = `operations-digest:${userId}:${slot}`;
  try {
    await db.jobRun.create({ data: { id, jobName: 'operations.digest.delivery', status: 'running', startedAt: now } });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    const claim = await db.jobRun.updateMany({ where: { id, status: 'error' }, data: { status: 'running', startedAt: now, errorMessage: null } });
    if (!claim.count) return false;
  }
  try { await send() }
  catch (err) {
    await db.jobRun.update({ where: { id }, data: { status: 'error', finishedAt: new Date(), errorMessage: String(err).slice(0, 2000) } });
    throw err;
  }
  await db.jobRun.update({ where: { id }, data: { status: 'success', finishedAt: new Date() } });
  return true;
}
