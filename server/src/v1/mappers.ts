/**
 * v1/mappers.ts — Prisma row → v1 DTO.
 *
 * This is the curated boundary: nothing reaches the wire except what these
 * functions emit. Field sourcing is documented in openapi/DTO-MAPPING.md.
 * Rows are typed `any` because the Prisma include graphs are deep; the mapper
 * is the single place that pins the output shape.
 */
import { num, dateOnly, iso } from './respond.js';
import { getAvailableTransitions } from '../services/ticketStateMachine.js';
import type { TicketStatus, UserRole } from '../db.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── shared mini-DTOs ────────────────────────────────────────────────────────
const companyRef = (c: any) => (c ? { id: c.id, name: c.name } : null);
const userRef = (u: any) => (u ? { id: u.id, name: u.name } : null);
const productRef = (p: any) =>
  p ? { id: p.id, partNumber: p.partNumber, name: p.name, category: p.category } : null;
const fieldRef = (f: any) => (f ? { id: f.id, name: f.name } : null);
const padRef = (p: any) => (p ? { id: p.id, name: p.name } : null);

function locationSummary(t: any) {
  const display =
    t.locationDisplay ||
    [t.field?.name, t.pad?.name, t.well?.wellName].filter(Boolean).join(' → ') ||
    'Unknown';
  return {
    display,
    fieldName: t.field?.name ?? t.fieldAreaName ?? null,
    padName: t.pad?.name ?? null,
    wellName: t.well?.wellName ?? null,
    apiNumber: t.well?.apiNumber ?? null,
  };
}

const signatureSummary = (s: any) =>
  s
    ? {
        status: s.status,
        sentToEmail: s.sentToEmail ?? null,
        sentToName: s.sentToName ?? null,
        sendCount: s.sendCount,
        firstSentAt: iso(s.firstSentAt),
        lastSentAt: iso(s.lastSentAt),
      }
    : null;

const ticketLineItem = (li: any) => ({
  id: li.id,
  description: li.description ?? '',
  partNumber: li.partNumber ?? null,
  quantity: num(li.quantity),
  unitPrice: num(li.rate),
  total: num(li.total),
  sortOrder: li.sortOrder,
});

const invoiceLineItem = (li: any) => ({
  id: li.id,
  description: li.description,
  partNumber: li.partNumber ?? null,
  quantity: num(li.quantity),
  unitPrice: num(li.rate),
  total: num(li.amount),
  sortOrder: li.sortOrder,
});

// ── Tickets ───────────────────────────────────────────────────────────────────
export function ticketSummary(t: any) {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    ticketType: t.ticketType,
    serviceSubtype: t.serviceSubtype ?? null,
    status: t.status,
    serviceDate: dateOnly(t.serviceDate),
    company: companyRef(t.company),
    location: locationSummary(t),
    assignedTech: userRef(t.assignedTech),
    updatedAt: iso(t.updatedAt),
  };
}

export function ticketDetail(t: any, role?: string) {
  return {
    ...ticketSummary(t),
    createdAt: iso(t.createdAt),
    createdBy: userRef(t.createdBy),
    customerContact: t.customerContact
      ? {
          name: t.customerContact.name ?? null,
          email: t.customerContact.email ?? null,
          phone: t.customerContact.phone ?? null,
        }
      : null,
    lineItems: (t.lineItems ?? []).map(ticketLineItem),
    attachments: (t.attachments ?? []).map((a: any) => ({
      id: a.id,
      filename: a.fileName,
      uploadedAt: iso(a.uploadedAt),
      url: `/api/v1/files/${a.id}`,
    })),
    signature: signatureSummary(t.signatureRequest),
    availableTransitions: role
      ? getAvailableTransitions(t.status as TicketStatus, role as UserRole)
      : [],
    recordCounts: {
      fitTest: t.fitTestRecords?.length ?? 0,
      airSystemInspection: t.airSystemInspections?.length ?? 0,
      ihTest: t.ihTestRecords?.length ?? 0,
      trainingRoster: t.trainingRosterRecords?.length ?? 0,
    },
  };
}

// ── Invoices ────────────────────────────────────────────────────────────────
export function invoiceSummary(inv: any) {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber ?? null,
    status: inv.status,
    company: { id: inv.companyId, name: inv.companyName },
    invoiceDate: dateOnly(inv.invoiceDate),
    total: num(inv.total),
    updatedAt: iso(inv.updatedAt),
  };
}

function qbStatus(inv: any): string | null {
  if (inv.qbInvoiceNumber) return 'invoiced';
  if (inv.qbSalesOrderNumber) return 'so_created';
  return null;
}

/** `locations` is derived in the route (needs billingGroup tickets / source lookup). */
export function invoiceDetail(inv: any, locations: any[]) {
  return {
    ...invoiceSummary(inv),
    createdAt: iso(inv.createdAt),
    subtotal: num(inv.subtotal),
    tax: num(inv.taxAmount),
    locationSummary: { locations },
    lineItems: (inv.lineItems ?? []).map(invoiceLineItem),
    signature: signatureSummary(inv.signatureRequest),
    delivery: {
      enverusStatus: inv.enverusStatus ?? null,
      qbStatus: qbStatus(inv),
      qbDiffDetected: inv.qbDiffDetectedAt != null,
    },
    pdfUrl: `/api/v1/invoices/${inv.id}/pdf`,
  };
}

// ── Equipment ───────────────────────────────────────────────────────────────
export function equipmentSummary(e: any) {
  return {
    id: e.id,
    serialNumber: e.serialNumber,
    product: productRef(e.product),
    ownership: e.ownership,
    status: e.status,
    calibrationDueDate: dateOnly(e.calibrationDueDate),
    bumpTestDueDate: dateOnly(e.bumpTestDueDate),
    updatedAt: iso(e.updatedAt),
  };
}

export function equipmentDetail(e: any) {
  return {
    ...equipmentSummary(e),
    createdAt: iso(e.createdAt),
    lastCalibrationDate: dateOnly(e.lastCalibrationDate),
    purchaseDate: dateOnly(e.purchaseDate),
    warrantyExpiry: dateOnly(e.warrantyExpiry),
    safeCoreSerial: e.safeCoreSerial ?? null,
    conditionNotes: e.conditionNotes ?? null,
    parentEquipmentId: e.parentEquipmentId ?? null,
    currentLocation: {
      pad: e.currentPad ? { id: e.currentPad.id, name: e.currentPad.name } : null,
      well: e.currentWell
        ? { id: e.currentWell.id, wellName: e.currentWell.wellName ?? null, apiNumber: e.currentWell.apiNumber ?? null }
        : null,
      facility: e.currentFacility ? { id: e.currentFacility.id, name: e.currentFacility.name } : null,
      customer: companyRef(e.currentCustomer),
      rentalId: e.currentRentalId ?? null,
    },
    latestInspection: e.equipmentInspections?.[0]
      ? equipmentInspectionSummary(e.equipmentInspections[0])
      : null,
  };
}

// ── Equipment inspections ─────────────────────────────────────────────────────
export function equipmentInspectionSummary(i: any) {
  return {
    id: i.id,
    serialNumber: i.serialNumber,
    serializedEquipmentId: i.serializedEquipmentId ?? null,
    category: i.category,
    outcome: i.outcome,
    serviceActions: Array.isArray(i.serviceActions) ? i.serviceActions : [],
    inspectedBy: userRef(i.inspectedBy),
    inspectedAt: iso(i.inspectedAt),
    lockedAt: iso(i.lockedAt),
    source: {
      type: i.ticketId ? 'ticket' : i.shopItemId ? 'shop_item' : null,
      ticketId: i.ticketId ?? null,
      shopItemId: i.shopItemId ?? null,
    },
  };
}

export function equipmentInspectionDetail(i: any) {
  return {
    ...equipmentInspectionSummary(i),
    data: i.data ?? {},
    partsReplaced: i.partsReplaced ?? null,
    notes: i.notes ?? null,
    customerApproval: { name: i.customerApprovedName ?? null, at: iso(i.customerApprovedAt) },
    correctsId: i.correctsId ?? null,
    createdAt: iso(i.createdAt),
    updatedAt: iso(i.updatedAt),
  };
}

// ── Rentals ───────────────────────────────────────────────────────────────────
export function rentalSummary(r: any) {
  return {
    id: r.id,
    agreementNumber: r.agreementNumber,
    status: r.status,
    company: companyRef(r.company),
    startDate: dateOnly(r.startDate),
    endDate: dateOnly(r.endDate),
    billingRateType: r.billingRateType,
    pickupType: r.pickupType,
    location: locationSummary(r),
    updatedAt: iso(r.updatedAt),
  };
}

export function rentalDetail(r: any) {
  const logs = r.dailyLogs ?? [];
  const lastLog = logs.reduce(
    (acc: Date | null, l: any) => (acc && acc >= l.logDate ? acc : l.logDate),
    null as Date | null,
  );
  return {
    ...rentalSummary(r),
    createdAt: iso(r.createdAt),
    poNumber: r.poNumber ?? null,
    afeNumber: r.afeNumber ?? null,
    isManned: r.isManned,
    isRigJob: r.isRigJob,
    monitorsIncluded: r.monitorsIncluded,
    siteContact: {
      name: r.siteContactName ?? null,
      phone: r.siteContactPhone ?? null,
      email: r.siteContactEmail ?? null,
    },
    items: (r.items ?? []).map(rentalItem),
    dailyLogCount: logs.length,
    lastLoggedOn: dateOnly(lastLog),
  };
}

const rentalItem = (it: any) => ({
  id: it.id,
  product: productRef(it.product),
  serialNumber: it.serializedEquipment?.serialNumber ?? null,
  rate: num(it.rate),
  rateType: it.rateType,
  deployedDate: dateOnly(it.deployedDate),
  returnedDate: dateOnly(it.returnedDate),
  status: it.status,
});

export function rentalDailyLog(l: any) {
  return {
    id: l.id,
    logDate: dateOnly(l.logDate),
    loggedBy: userRef(l.loggedBy),
    equipmentPresent: l.equipmentPresent,
    equipmentStatus: l.equipmentStatus,
    cascadeStatus: l.cascadeStatus ?? null,
    bottlesFullCount: l.bottlesFullCount ?? null,
    bottlesTotalCount: l.bottlesTotalCount ?? null,
    monitorsBumpTested: l.monitorsBumpTested ?? null,
    monitorsOperationalCount: l.monitorsOperationalCount ?? null,
    monitorsTotalCount: l.monitorsTotalCount ?? null,
    notes: l.notes ?? null,
    entries: l.entries ?? null,
  };
}

// ── Locations ───────────────────────────────────────────────────────────────
export function fieldDto(f: any) {
  return {
    id: f.id,
    name: f.name,
    county: f.county ?? null,
    state: f.state,
    notes: f.notes ?? null,
    isActive: f.isActive,
    createdAt: iso(f.createdAt),
    updatedAt: iso(f.updatedAt),
  };
}

export function padSummary(p: any) {
  return {
    id: p.id,
    name: p.name,
    field: fieldRef(p.field),
    county: p.county ?? null,
    currentOperator: companyRef(p.currentOperator),
    tier1: p.tier1,
    latitude: num(p.latitude),
    longitude: num(p.longitude),
    isActive: p.isActive,
    updatedAt: iso(p.updatedAt),
  };
}
export function padDetail(p: any) {
  return {
    ...padSummary(p),
    section: p.section ?? null,
    township: p.township ?? null,
    range: p.range ?? null,
    directions: p.directions ?? null,
    accessNotes: p.accessNotes ?? null,
    manuallyVerified: p.manuallyVerified,
    pendingReview: p.pendingReview,
    createdAt: iso(p.createdAt),
  };
}

export function wellSummary(w: any) {
  return {
    id: w.id,
    wellName: w.wellName ?? null,
    apiNumber: w.apiNumber ?? null,
    field: fieldRef(w.field),
    pad: padRef(w.pad),
    currentOperator: companyRef(w.currentOperator),
    wellType: w.wellType ?? null,
    wellStatus: w.wellStatus ?? null,
    county: w.county ?? null,
    tier1: w.tier1,
    updatedAt: iso(w.updatedAt),
  };
}
export function wellDetail(w: any) {
  return {
    ...wellSummary(w),
    apiShort: w.apiShort ?? null,
    dmrFileNumber: w.dmrFileNumber ?? null,
    totalDepth: w.totalDepth ?? null,
    spudDate: dateOnly(w.spudDate),
    section: w.section ?? null,
    township: w.township ?? null,
    range: w.range ?? null,
    quarterQuarter: w.quarterQuarter ?? null,
    feetNs: w.feetNs ?? null,
    nsLine: w.nsLine ?? null,
    feetEw: w.feetEw ?? null,
    ewLine: w.ewLine ?? null,
    latitude: num(w.latitude),
    longitude: num(w.longitude),
    hasSuppliedAir: w.hasSuppliedAir,
    hasAreaMonitors: w.hasAreaMonitors,
    isHighRisk: w.isHighRisk,
    riskNotes: w.riskNotes ?? null,
    isActiveForService: w.isActiveForService,
    serviceNotes: w.serviceNotes ?? null,
    createdAt: iso(w.createdAt),
  };
}

export function facilitySummary(f: any) {
  return {
    id: f.id,
    name: f.name,
    facilityType: f.facilityType,
    field: fieldRef(f.field),
    pad: padRef(f.pad),
    currentOperator: companyRef(f.currentOperator),
    county: f.county ?? null,
    isActive: f.isActive,
    updatedAt: iso(f.updatedAt),
  };
}
export function facilityDetail(f: any) {
  return {
    ...facilitySummary(f),
    latitude: num(f.latitude),
    longitude: num(f.longitude),
    section: f.section ?? null,
    township: f.township ?? null,
    range: f.range ?? null,
    directions: f.directions ?? null,
    accessNotes: f.accessNotes ?? null,
    hasSuppliedAir: f.hasSuppliedAir,
    hasAreaMonitors: f.hasAreaMonitors,
    serviceNotes: f.serviceNotes ?? null,
    createdAt: iso(f.createdAt),
  };
}

// ── Companies ─────────────────────────────────────────────────────────────────
export function companySummary(c: any) {
  return {
    id: c.id,
    name: c.name,
    legalName: c.legalName ?? null,
    companyType: c.companyType,
    city: c.city ?? null,
    state: c.state ?? null,
    isActive: c.isActive,
    updatedAt: iso(c.updatedAt),
  };
}
export function companyDetail(c: any) {
  return {
    ...companySummary(c),
    parentCompanyId: c.parentCompanyId ?? null,
    address: c.address ?? null,
    zip: c.zip ?? null,
    phone: c.phone ?? null,
    email: c.email ?? null,
    website: c.website ?? null,
    paymentTerms: c.paymentTerms ?? null,
    createdAt: iso(c.createdAt),
  };
}

// ── Trainings ───────────────────────────────────────────────────────────────
function courseNameOf(t: any): string | null {
  return t.trainingRosterRecords?.[0]?.courseName ?? t.workDescription ?? null;
}

export function trainingClassSummary(t: any) {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    courseName: courseNameOf(t),
    status: t.status,
    serviceDate: dateOnly(t.serviceDate),
    company: companyRef(t.company),
    attendeeCount: t.trainingRosterRecords?.length ?? 0,
    updatedAt: iso(t.updatedAt),
  };
}

export function trainingClassDetail(t: any) {
  return {
    ...trainingClassSummary(t),
    createdAt: iso(t.createdAt),
    location: locationSummary(t),
    instructor: userRef(t.assignedTech),
    attendees: (t.trainingRosterRecords ?? []).map(trainingAttendee),
  };
}

const trainingAttendee = (a: any) => ({
  id: a.id,
  employeeName: a.employeeName,
  employerName: a.employerName ?? null,
  employerCompanyId: a.employerCompanyId ?? null,
  courseName: a.courseName,
  passed: a.passed,
  cardNumber: a.cardNumber ?? null,
  cardExpiryDate: dateOnly(a.cardExpiryDate),
  cardIssuedOnSite: a.cardIssuedOnSite,
  cardIssuedOfficial: a.cardIssuedOfficial,
  trainedAt: iso(a.trainedAt),
  blueLion: {
    personId: a.blueLionPersonId ?? null,
    trainingSeq: a.blueLionTrainingSeq ?? null,
    syncedAt: iso(a.blueLionSyncedAt),
  },
});

// ── BlueLion sync queue ────────────────────────────────────────────────────────
export function blueLionQueueEntry(q: any) {
  return {
    id: q.id,
    entityType: q.entityType,
    entityId: q.entityId,
    externalId: q.externalId ?? null,
    status: q.status,
    resultStatus: q.resultStatus ?? null,
    candidates: q.candidates ?? null,
    errorMessage: q.errorMessage ?? null,
    retryCount: q.retryCount,
    createdAt: iso(q.createdAt),
  };
}
