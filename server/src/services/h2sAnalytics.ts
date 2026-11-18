import { Prisma, type TicketStatus } from '../db.js';
import { prisma } from '../db.js';

// H2S readings at or above this many ppm flag a location as elevated.
export const H2S_ELEVATED_PPM = 10;

interface H2SPoint {
  ticketId: string;
  ticketNumber: string;
  serviceDate: string;
  value: number;
  context: string;
  readingType: string;
}

export interface H2sLocation {
  locationKey: string;
  locationName: string;
  locationType: 'well' | 'pad' | 'field' | 'unknown';
  wellId: string | null;
  padId: string | null;
  fieldId: string | null;
  readingCount: number;
  maxH2S: number;
  latestH2S: number | null;
  elevated: boolean;
  readings: H2SPoint[];
}

export interface H2sAnalytics {
  companyId: string;
  totalLocations: number;
  elevatedCount: number;
  safeCount: number;
  locations: H2sLocation[];
}

// Optional service-date window (inclusive, YYYY-MM-DD). serviceDate is a pure
// @db.Date, so both bounds match the named day.
export interface H2sDateFilter {
  dateFrom?: string;
  dateTo?: string;
  visibleStatuses?: TicketStatus[];
}

// Per-location H2S history from structured IH tests, with legacy ticket
// gas readings as a fallback. Shared by the
// internal dashboard (/dashboard/h2s-analytics) and the customer portal
// (/portal/h2s) so both render identical numbers.
export async function computeH2sAnalytics(
  companyId: string,
  filter: H2sDateFilter = {},
): Promise<H2sAnalytics> {
  const where: Prisma.ServiceTicketWhereInput = {
    companyId,
    status: filter.visibleStatuses ? { in: filter.visibleStatuses } : { not: 'draft' },
  };

  if (filter.dateFrom || filter.dateTo) {
    where.serviceDate = {};
    if (filter.dateFrom) where.serviceDate.gte = new Date(filter.dateFrom);
    if (filter.dateTo) where.serviceDate.lte = new Date(filter.dateTo);
  }

  const tickets = await prisma.serviceTicket.findMany({
    where,
    select: {
      id: true,
      ticketNumber: true,
      serviceDate: true,
      customData: true,
      ihTestRecords: {
        where: { testType: 'ih_h2s' },
        select: { testData: true, locationPoint: true },
        orderBy: { testedAt: 'asc' },
      },
      wellId: true,
      well: { select: { wellName: true } },
      padId: true,
      pad: { select: { name: true } },
      fieldId: true,
      field: { select: { name: true } },
      locationDisplay: true,
    },
    orderBy: [{ serviceDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });

  // Group readings by the most specific location available: well > pad > field.
  const locationMap = new Map<string, Omit<H2sLocation,
    'readingCount' | 'maxH2S' | 'latestH2S' | 'elevated'>>();

  for (const t of tickets) {
    const cd = t.customData as any;
    const legacy = Array.isArray(cd?.gasReadings)
      ? cd.gasReadings.filter((r: any) => r?.type === 'h2s' && (!r.unit || (typeof r.unit === 'string' && r.unit.toLowerCase() === 'ppm'))) : [];
    const structured = t.ihTestRecords.flatMap(rec => {
      const readings = (rec.testData as any)?.readings;
      return Array.isArray(readings) ? readings.map((r: any) => ({
        value: r?.ppmReading, context: r?.locationPoint || rec.locationPoint, readingType: 'test',
      })) : [];
    });
    // Structured records are authoritative when present; legacy data may mirror them.
    const h2sReadings = (t.ihTestRecords.length ? structured : legacy)
      .filter((r: any) => typeof r.value === 'number' && Number.isFinite(r.value) && r.value >= 0);
    if (h2sReadings.length === 0) continue;

    let locationKey: string;
    let locationName: string;
    let locationType: 'well' | 'pad' | 'field' | 'unknown';

    if (t.wellId && t.well) {
      locationKey = `well:${t.wellId}`;
      locationName = t.well.wellName || 'Unknown Well';
      locationType = 'well';
    } else if (t.padId && t.pad) {
      locationKey = `pad:${t.padId}`;
      locationName = t.pad.name;
      locationType = 'pad';
    } else if (t.fieldId && t.field) {
      locationKey = `field:${t.fieldId}`;
      locationName = t.field.name;
      locationType = 'field';
    } else {
      locationKey = `ticket:${t.id}`;
      locationName = t.locationDisplay || 'Unknown Location';
      locationType = 'unknown';
    }

    if (!locationMap.has(locationKey)) {
      locationMap.set(locationKey, {
        locationKey,
        locationName,
        locationType,
        wellId: t.wellId,
        padId: t.padId,
        fieldId: t.fieldId,
        readings: [],
      });
    }

    const loc = locationMap.get(locationKey)!;
    for (const r of h2sReadings) {
      loc.readings.push({
        ticketId: t.id,
        ticketNumber: t.ticketNumber || '',
        serviceDate: (t.serviceDate as Date).toISOString().slice(0, 10),
        value: r.value,
        context: r.context || 'general',
        readingType: r.readingType || 'test',
      });
    }
  }

  const locations: H2sLocation[] = Array.from(locationMap.values()).map(loc => {
    const maxH2S = Math.max(...loc.readings.map(r => r.value));
    return {
      ...loc,
      readingCount: loc.readings.length,
      maxH2S,
      latestH2S: loc.readings[loc.readings.length - 1]?.value ?? null,
      elevated: maxH2S >= H2S_ELEVATED_PPM,
    };
  });

  // Elevated locations first, then by max reading descending.
  locations.sort((a, b) => {
    if (a.elevated !== b.elevated) return a.elevated ? -1 : 1;
    return b.maxH2S - a.maxH2S;
  });

  return {
    companyId,
    totalLocations: locations.length,
    elevatedCount: locations.filter(l => l.elevated).length,
    safeCount: locations.filter(l => !l.elevated).length,
    locations,
  };
}
