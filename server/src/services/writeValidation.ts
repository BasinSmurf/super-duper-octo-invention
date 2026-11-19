import { AppError } from '../middleware/errorHandler.js';

export function objectBody(value: any): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'An object body is required');
  checkText(value);
}

function checkText(value: any): void {
  if (typeof value === 'string' && (value.includes('\0') || value.length > 1000000)) throw new AppError(400, 'Invalid text');
  if (value && typeof value === 'object') for (const child of Object.values(value)) checkText(child);
}

export function allowedFields(value: Record<string, any>, fields: string[]): void {
  const unknown = Object.keys(value).filter(key => !fields.includes(key));
  if (unknown.length) throw new AppError(400, `Fields are not editable: ${unknown.join(', ')}`);
}

export function enumValue(value: unknown, values: Record<string, string> | string[], name: string): void {
  if (value != null && !Object.values(values).includes(value as string)) throw new AppError(400, `Invalid ${name}`);
}

export function validDate(value: unknown, name: string): Date {
  if (typeof value !== 'string' && !(value instanceof Date)) throw new AppError(400, `Invalid ${name}`);
  const date = new Date(value);
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
    if (!match) throw new AppError(400, `Invalid ${name}: expected an ISO date`);
    const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (day.toISOString().slice(0, 10) !== match[0].slice(0, 10)) throw new AppError(400, `Invalid ${name}`);
  }
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > new Date().getUTCFullYear() + 5) throw new AppError(400, `Invalid ${name}: expected a date from 2000 through five years from now`);
  return date;
}

export function numberValue(value: unknown, name: string, min = 0, max = 9999999999.99): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new AppError(400, `Invalid ${name}`);
  return value;
}

export function cycleLength(value: unknown): number {
  if (typeof value !== 'number' || ![1, 2, 3, 6, 12].includes(value)) throw new AppError(400, 'cycleMonths must be 1, 2, 3, 6, or 12');
  return value;
}

export function validateRentalInput(data: any, create = false): void {
  objectBody(data);
  enumValue(data.billingRateType, ['daily', 'weekly', 'monthly'], 'billingRateType');
  if (create) enumValue(data.status, ['scheduled', 'active'], 'initial rental status');
  if (data.startDate != null) validDate(data.startDate, 'startDate');
  if (data.endDate != null) {
    validDate(data.endDate, 'endDate');
    if (!data.startDate || new Date(data.endDate) < new Date(data.startDate)) throw new AppError(400, 'endDate must be on or after startDate');
  }
  const composition = data.composition;
  if (composition != null) {
    objectBody(composition);
    const rows = [composition.trailer, composition.bomPackage];
    for (const key of ['gasMonitors', 'other', 'bom', 'bomExtras']) {
      if (composition[key] != null && !Array.isArray(composition[key])) throw new AppError(400, `Invalid composition.${key}`);
      rows.push(...(composition[key] || []));
    }
    for (const row of rows.filter(Boolean)) {
      objectBody(row);
      if (row.qty != null) numberValue(row.qty, 'quantity', 0.01, 100000);
      if (row.rate != null) numberValue(row.rate, 'rate');
    }
  }
  if (data.items != null && !Array.isArray(data.items)) throw new AppError(400, 'items must be an array');
  for (const item of data.items || []) {
    if (item.rate != null) numberValue(item.rate, 'rate');
    if (item.quantity != null) numberValue(item.quantity, 'quantity', 0.01, 100000);
    enumValue(item.rateType, ['daily', 'weekly', 'monthly'], 'rateType');
  }
}
