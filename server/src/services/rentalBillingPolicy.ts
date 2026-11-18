import { AppError } from '../middleware/errorHandler.js';

export type BillingPause = { startDate: string; endDate: string };
export type RentalBillingPolicy = {
  pauses: BillingPause[];
  ticketRates: { manned: number; unmanned: number } | null;
  compositionHistory?: { effectiveDate: string; composition: Record<string, any> }[];
  rateChanges?: { effectiveDate: string; manned: number; unmanned: number }[];
};

const DAY = 86_400_000;
const dateKey = (date: Date) => date.toISOString().slice(0, 10);

export function parseRentalBillingPolicy(raw: unknown): RentalBillingPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'Invalid rental billing settings');
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.pauses)) throw new AppError(400, 'Billing pauses must be an array');
  const validDate = (v: unknown): v is string => typeof v === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v))
    && dateKey(new Date(v)) === v;
  const pauses = value.pauses.map((pause: unknown) => {
    const p = pause as BillingPause | null;
    if (!p || !validDate(p.startDate) || !validDate(p.endDate) || p.endDate < p.startDate) {
      throw new AppError(400, 'Each billing pause needs valid start/end dates, with end on or after start');
    }
    return { startDate: p.startDate, endDate: p.endDate };
  }).sort((a, b) => a.startDate.localeCompare(b.startDate));
  let ticketRates: RentalBillingPolicy['ticketRates'] = null;
  if (value.ticketRates != null) {
    const rates = value.ticketRates as Record<string, unknown>;
    for (const key of ['manned', 'unmanned']) {
      if (typeof rates[key] !== 'number' || !Number.isFinite(rates[key]) || (rates[key] as number) < 0) {
        throw new AppError(400, 'Manned and unmanned daily rates must be non-negative numbers');
      }
    }
    ticketRates = { manned: rates.manned as number, unmanned: rates.unmanned as number };
  }
  if (value.rateChanges !== undefined && !Array.isArray(value.rateChanges)) throw new AppError(400, 'Rate changes must be an array');
  const rateChanges = ((value.rateChanges || []) as any[]).map(change => {
    if (!change || !validDate(change.effectiveDate) || !['manned', 'unmanned'].every(k => typeof change[k] === 'number' && Number.isFinite(change[k]) && change[k] >= 0)) {
      throw new AppError(400, 'Rate changes require a valid effective date and non-negative rates');
    }
    return { effectiveDate: change.effectiveDate, manned: change.manned as number, unmanned: change.unmanned as number };
  }).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  if (rateChanges.length && !ticketRates) throw new AppError(400, 'Rate history requires ticket-based rates');
  if (new Set(rateChanges.map(c => c.effectiveDate)).size !== rateChanges.length) throw new AppError(400, 'Duplicate rate effective date');
  const compositionHistory = value.compositionHistory as RentalBillingPolicy['compositionHistory'];
  if (compositionHistory !== undefined && (!Array.isArray(compositionHistory) || compositionHistory.some(c => !c || !validDate(c.effectiveDate) || !c.composition || typeof c.composition !== 'object' || Array.isArray(c.composition)))) throw new AppError(400, 'Invalid composition history');
  return { pauses, ticketRates, ...(rateChanges.length ? { rateChanges } : {}), ...(compositionHistory?.length ? { compositionHistory } : {}) };
}

/** The manned/unmanned day rates in force on a given date: the latest dated
 * rate change on or before it, else the agreement's base ticket rates. */
export function ticketRatesOn(date: Date, policy: RentalBillingPolicy): { manned: number; unmanned: number } | null {
  if (!policy.ticketRates) return null;
  return [...(policy.rateChanges || [])].reverse().find(c => c.effectiveDate <= dateKey(date)) || policy.ticketRates;
}

export function dailyRentalCharges(start: Date, end: Date, policy: RentalBillingPolicy, mannedDates: Set<string>) {
  const charges = new Map<string, { mode: 'manned' | 'unmanned'; rate: number; days: number }>();
  if (!policy.ticketRates) return [];
  for (let time = +start; time <= +end; time += DAY) {
    const date = new Date(time);
    if (isBillingPaused(date, policy.pauses)) continue;
    const rates = ticketRatesOn(date, policy)!;
    const mode = mannedDates.has(dateKey(date)) ? 'manned' : 'unmanned';
    const key = `${mode}:${rates[mode]}`;
    const charge = charges.get(key) || { mode, rate: rates[mode], days: 0 };
    charge.days++; charges.set(key, charge);
  }
  return [...charges.values()];
}

export function isBillingPaused(date: Date, pauses: BillingPause[]): boolean {
  const key = dateKey(date);
  return pauses.some(p => p.startDate <= key && key <= p.endDate);
}

export function rentalBillingDays(start: Date, end: Date, pauses: BillingPause[] = [], mannedDates: Set<string> = new Set()) {
  const days = { total: 0, paused: 0, manned: 0, unmanned: 0 };
  for (let time = Date.parse(dateKey(start)); time <= Date.parse(dateKey(end)); time += DAY) {
    const date = new Date(time);
    days.total++;
    if (isBillingPaused(date, pauses)) days.paused++;
    else if (mannedDates.has(dateKey(date))) days.manned++;
    else days.unmanned++;
  }
  return days;
}

/** Keep the existing whole-period pricing when uninterrupted; prorate a
 * weekly/monthly charge by the fraction of its days that were not paused. */
export function billableRentalPeriods(start: Date, end: Date, rateType: string, pauses: BillingPause[] = []) {
  const days = rentalBillingDays(start, end, pauses);
  const active = days.total - days.paused;
  const uom = rateType === 'weekly' ? 'WK' : rateType === 'monthly' ? 'MO' : 'DAY';
  if (!active) return { qty: 0, uom };
  const full = rateType === 'weekly' ? Math.ceil(days.total / 7)
    : rateType === 'monthly' ? (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() + 1
    : days.total;
  // Invoice quantities persist to two decimal places; calculate amounts from
  // that same precision so stored quantity × rate agrees with the invoice.
  return { qty: Math.round(full * active / days.total * 100) / 100, uom };
}

export function isMannedDailyTicket(ticket: { status: string; customData?: unknown }): boolean {
  if (['draft', 'dispatched', 'void'].includes(ticket.status)) return false;
  const data = ticket.customData as { onSiteSubtype?: string } | null;
  return data?.onSiteSubtype === 'manned_trailer';
}

/** Bill occupied contract slots. A replacement on the return date occupies the
 * same slot; separately ordered units still accrue separately. Date-only
 * deployment/return boundaries are inclusive. */
export function occupiedRentalPeriods(start: Date, end: Date, rateType: string, pauses: BillingPause[],
  items: { deployedDate: Date; returnedDate: Date | null }[], slots: number) {
  const days = rentalBillingDays(start, end);
  if (!days.total) return 0;
  let unitDays = 0;
  for (let time = +start; time <= +end; time += DAY) {
    if (isBillingPaused(new Date(time), pauses)) continue;
    unitDays += Math.min(slots, items.filter(i => +i.deployedDate <= time && (!i.returnedDate || +i.returnedDate >= time)).length);
  }
  const full = billableRentalPeriods(start, end, rateType).qty;
  return Math.round(full * unitDays / days.total * 100) / 100;
}

/** Allocate periodic prices to calendar days in cents. Difference-of-cumulative
 * rounding makes the allocation independent of invoice slicing and keeps
 * quantity × rate exact at the existing two-decimal invoice precision. Days
 * with different penny allocations become separate DAY lines. */
export function proratedRentalCharges(start: Date, end: Date, rateType: string, periodRate: number,
  pauses: BillingPause[], units = 1, items?: { deployedDate: Date; returnedDate: Date | null }[]) {
  const groups = new Map<number, { quantity: number; rate: number; amount: number }>();
  const cents = Math.round(periodRate * 100);
  for (let time = +start; time <= +end; time += DAY) {
    const date = new Date(time);
    if (isBillingPaused(date, pauses)) continue;
    const occupied = items ? Math.min(units, items.filter(i => +i.deployedDate <= time && (!i.returnedDate || +i.returnedDate >= time)).length) : units;
    if (!occupied) continue;
    const divisor = rateType === 'monthly' ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate() : 7;
    const day = rateType === 'monthly' ? date.getUTCDate() : ((date.getUTCDay() + 6) % 7) + 1;
    const dayCents = Math.round(day * cents / divisor) - Math.round((day - 1) * cents / divisor);
    const group = groups.get(dayCents) || { quantity: 0, rate: dayCents / 100, amount: 0 };
    group.quantity += occupied;
    group.amount = Math.round(group.quantity * dayCents) / 100;
    groups.set(dayCents, group);
  }
  return [...groups.values()];
}
