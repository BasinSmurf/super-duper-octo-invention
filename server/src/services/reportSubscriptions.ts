import type { PrismaClient } from '../db.js';
import { roleHasCapability } from './permissions.js';
import { AppError } from '../middleware/errorHandler.js';
import type { OperationsReport } from './operationsReport.js';

export const REPORT_TYPES = [
  { id: 'operations', name: 'Daily operations', description: 'Jobs in progress, route coverage, and operational exceptions.', capability: 'reports:ops' },
  { id: 'billing', name: 'Billing and QuickBooks', description: 'Invoice approval, QB delivery, and rental billing exceptions with invoice-stage totals.', capability: 'reports:financial' },
  { id: 'shop', name: 'Shop blockers', description: 'Quotes, parts, QA, and customer pickup blockers.', capability: 'reports:ops' },
  { id: 'training', name: 'Training closeout', description: 'Roster, payer mapping, and card issuance exceptions.', capability: 'tickets:view_all' },
] as const;
export type ReportType = typeof REPORT_TYPES[number]['id'];
export type ReportPreferences = Record<string, { cadence?: string; assignedById?: string; updatedAt?: string }>;
export function canReceiveReport(role: string, type: ReportType) {
  const report = REPORT_TYPES.find(r => r.id === type)!;
  if (!roleHasCapability(role, 'tickets:view_all')) return false;
  if (type === 'operations' || type === 'shop') return roleHasCapability(role, 'reports:ops') || roleHasCapability(role, 'reports:financial');
  return roleHasCapability(role, report.capability);
}
export function reportPreferences(value: unknown): ReportPreferences {
  const prefs = value as { reports?: ReportPreferences } | null;
  return prefs?.reports && typeof prefs.reports === 'object' ? prefs.reports : {};
}
export function selectReport(report: OperationsReport, type: ReportType): OperationsReport {
  const base = { ...report, amounts: {}, noChargeRecorded: 0, jobs: [], coverage: [], exceptions: [] } as OperationsReport;
  if (type === 'billing') return { ...base, amounts: report.amounts, noChargeRecorded: report.noChargeRecorded, exceptions: report.exceptions.filter(r => r.href.startsWith('/billing/') || r.href.startsWith('/rentals/') || r.detail.includes('Completed work:')) };
  if (type === 'shop') return { ...base, exceptions: report.exceptions.filter(r => r.href.startsWith('/shop/')) };
  if (type === 'training') return { ...base, exceptions: report.exceptions.filter(r => r.category === 'training') };
  return { ...report, amounts: {}, noChargeRecorded: 0, exceptions: report.exceptions.filter(r => !r.href.startsWith('/billing/')) };
}
export function validateReportPreference(type: unknown, cadence: unknown): asserts type is ReportType {
  if (!REPORT_TYPES.some(r => r.id === type) || !['off', 'daily', 'weekly'].includes(String(cadence))) throw new AppError(400, 'Choose a valid report and off, daily, or weekly cadence');
}
export async function saveReportPreference(db: PrismaClient, userId: string, actorId: string, type: unknown, cadence: unknown) {
  validateReportPreference(type, cadence);
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } });
  if (!user) throw new AppError(404, 'User not found');
  if (cadence !== 'off' && (!user.isActive || !canReceiveReport(user.role, type))) throw new AppError(403, 'Recipient must be active and have permission to view this report');
  const pref = JSON.stringify({ cadence, channel: 'email', assignedById: actorId, updatedAt: new Date().toISOString() });
  // Atomic JSON merge preserves unrelated preferences and simultaneous edits to other report types.
  await db.$executeRaw`UPDATE users SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || jsonb_build_object('reports', COALESCE(notification_prefs->'reports', '{}'::jsonb) || jsonb_build_object(${type}::text, ${pref}::jsonb)), updated_at = NOW() WHERE id = ${userId}`;
}
export async function getReportSubscriptions(db: PrismaClient, userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true, notificationPrefs: true } });
  if (!user) throw new AppError(404, 'User not found');
  const prefs = reportPreferences(user.notificationPrefs);
  return { deliveryEnabled: process.env.OPS_DIGEST_ENABLED === 'true' && !!process.env.PUBLIC_APP_URL && !!process.env.GOOGLE_SA_KEY_PATH && !!process.env.GOOGLE_MAIL_FROM, timezone: process.env.OPS_DIGEST_TIMEZONE || 'America/Chicago',
    reports: REPORT_TYPES.map(r => ({ id: r.id, name: r.name, description: r.description, eligible: user.isActive && canReceiveReport(user.role, r.id), cadence: prefs[r.id]?.cadence ?? 'off', assignedByAdmin: !!prefs[r.id]?.assignedById && prefs[r.id].assignedById !== userId })) };
}
