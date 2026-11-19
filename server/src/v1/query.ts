import type { RequestHandler } from 'express';
import {
  BlueLionQueueStatus, CompanyType, EquipmentInspectionCategory, EquipmentOwnership, EquipmentStatus,
  FacilityType, InspectionOutcome, InvoiceStatus, ProductCategory, RentalStatus,
  TicketStatus, TicketType,
} from '../generated/prisma/enums.js';
import { decodeCursor, parseLimit, V1Error } from './respond.js';

interface QueryRules {
  strings?: string[];
  enums?: Record<string, readonly string[]>;
  booleans?: string[];
  dates?: string[];
  timestamps?: string[];
}

const rules: Record<string, QueryRules> = {
  '/tickets': { strings: ['companyId'], enums: { status: Object.values(TicketStatus), ticketType: Object.values(TicketType) }, timestamps: ['updatedSince'] },
  '/invoices': { strings: ['companyId'], enums: { status: Object.values(InvoiceStatus) }, timestamps: ['updatedSince'] },
  '/equipment': { strings: ['serialNumber', 'companyId'], enums: { status: Object.values(EquipmentStatus), ownership: Object.values(EquipmentOwnership), productCategory: Object.values(ProductCategory) }, timestamps: ['updatedSince'] },
  '/equipment-inspections': { strings: ['serialNumber', 'ticketId'], enums: { category: Object.values(EquipmentInspectionCategory), outcome: Object.values(InspectionOutcome) }, timestamps: ['updatedSince'] },
  '/rentals': { strings: ['companyId', 'fieldId'], enums: { status: Object.values(RentalStatus) }, timestamps: ['updatedSince'] },
  '/rentals/:id/daily-logs': { dates: ['from', 'to'] },
  '/fields': { booleans: ['isActive'], timestamps: ['updatedSince'] },
  '/pads': { strings: ['fieldId', 'operatorId'], booleans: ['isActive'], timestamps: ['updatedSince'] },
  '/wells': { strings: ['fieldId', 'padId', 'operatorId', 'apiNumber'], timestamps: ['updatedSince'] },
  '/facilities': { strings: ['fieldId'], enums: { facilityType: Object.values(FacilityType) }, booleans: ['isActive'], timestamps: ['updatedSince'] },
  '/companies': { enums: { companyType: Object.values(CompanyType) }, booleans: ['isActive'], timestamps: ['updatedSince'] },
  '/trainings': { strings: ['companyId', 'course'], enums: { status: Object.values(TicketStatus) }, timestamps: ['updatedSince'] },
  '/bluelion/queue': { enums: { status: Object.values(BlueLionQueueStatus) } },
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimestamp(value: string): boolean {
  const parts = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  return !!parts && validDate(parts[1]) && +parts[2] < 24 && +parts[3] < 60 && +parts[4] < 60
    && +(parts[5] ?? 0) < 24 && +(parts[6] ?? 0) < 60 && Number.isFinite(new Date(value).getTime());
}

/** Applied after route authentication; reject malformed filters before any DB read. */
export const validateListQuery: RequestHandler = (req, _res, next) => {
  const rule = rules[req.route.path as string];
  if (!rule) return next();
  const params = new Set(['cursor', 'limit', ...(rule.strings ?? []), ...Object.keys(rule.enums ?? {}),
    ...(rule.booleans ?? []), ...(rule.dates ?? []), ...(rule.timestamps ?? [])]);
  for (const param of params) {
    const value = req.query[param];
    if (value === undefined) continue;
    const invalid = (message: string, extra?: Record<string, unknown>): never => {
      throw new V1Error(400, 'invalid_parameter', `Invalid ${param}: ${message}`, { param, ...extra });
    };
    if (typeof value !== 'string' || !value.trim()) invalid('expected a single non-empty value');
    // Express query values may also be arrays or nested objects; narrow only
    // after rejecting those, rather than silently dropping the requested filter.
    const text = value as string;
    const allowed = rule.enums?.[param];
    if (allowed && !allowed.includes(text)) invalid('unsupported value', { allowed });
    if (rule.booleans?.includes(param) && text !== 'true' && text !== 'false') invalid('expected true or false');
    if (rule.dates?.includes(param) && !validDate(text)) invalid('expected a valid YYYY-MM-DD date');
    if (rule.timestamps?.includes(param) && !validTimestamp(text)) invalid('expected an RFC 3339 timestamp with a timezone');
  }
  parseLimit(req.query.limit, 50, req.route.path === '/bluelion/queue' ? 500 : 200);
  if (typeof req.query.cursor === 'string' && !decodeCursor(req.query.cursor)) {
    throw new V1Error(400, 'bad_cursor', 'Invalid pagination cursor');
  }
  if (rule.dates?.includes('from') && typeof req.query.from === 'string' && typeof req.query.to === 'string'
    && req.query.from > req.query.to) {
    throw new V1Error(400, 'invalid_parameter', 'Invalid to: must be on or after from', { param: 'to' });
  }
  next();
};
