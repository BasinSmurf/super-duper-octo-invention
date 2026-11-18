import { generateInvoicePdf } from '../../invoicePdfGenerator.js';
import { generateTicketPdf } from '../../ticketPdfGenerator.js';
import { generateRentalAgreementPdf } from '../../rentalAgreementPdfGenerator.js';
import { generateShopWorkOrderPdf } from '../../shopWorkOrderPdfGenerator.js';
import { generateOccHealthPdf } from '../../occHealthPdfGenerator.js';
import { generateEquipmentInspectionPdf } from '../../equipmentInspectionPdfGenerator.js';
import { generateEquipmentBadgePdf } from '../../equipmentLabel.js';
import type { PdfBranding } from '../../pdfBranding.js';

const date = '2026-11-16';
export const invoiceFixture: Parameters<typeof generateInvoicePdf>[0] = {
  invoiceNumber: 'INV-2026-00123', status: 'approved', sourceType: 'manual', companyName: 'Example Energy',
  poNumber: 'PO-123', afeNumber: 'AFE-456', costCenter: 'North field', invoiceDate: date, dueDate: '2026-12-16',
  periodStart: date, periodEnd: date, subtotal: 172.5, taxAmount: 5, total: 177.5,
  notes: 'Thank you for your business.', internalNotes: null, qbSalesOrderNumber: null, qbInvoiceNumber: null,
  lineItems: [{ lineNumber: 1, description: 'Gas monitor inspection and calibration', productId: 'product', partNumber: '0610003',
    quantity: 1.5, rate: 115, amount: 172.5, unitOfMeasure: 'HR', isTaxable: true, notes: null, sortOrder: 0 }],
};
const ticket: Parameters<typeof generateTicketPdf>[0] = {
  ticketNumber: 'FS-2026-00123', ticketType: 'field_service', serviceSubtype: 'gas_detection', status: 'completed',
  serviceDate: date, arrivalTime: `${date}T15:00:00Z`, departureTime: `${date}T16:30:00Z`,
  locationDisplay: 'North field - Example pad', afeNumber: 'AFE-456', poNumber: 'PO-123', customerRepName: 'Jamie Customer',
  workDescription: 'Inspected the monitor, replaced the filter, and completed calibration.', dispatchNotes: null, internalNotes: null,
  subtotal: 172.5, total: 172.5, techSignature: null, customerRepSignature: null,
  company: { name: 'Example Energy' }, assignedTech: { name: 'Taylor Technician' },
  lineItems: [{ lineNumber: 1, lineType: 'labor', description: 'Inspection and calibration', quantity: 1.5, rate: 115, total: 172.5,
    unitOfMeasure: 'HR', sortOrder: 0, notes: null, serialNumberInstalled: null, serialNumberRemoved: null, testResult: 'pass' }],
};
const rental: Parameters<typeof generateRentalAgreementPdf>[0] = {
  agreementNumber: 'RA-2026-00123', status: 'active', pickupType: 'dispatch', startDate: date, endDate: '2026-11-30', billingRateType: 'daily',
  poNumber: 'PO-123', afeNumber: 'AFE-456', notes: 'Return to the shop when the job is complete.', isManned: false, isRigJob: false, monitorsIncluded: true,
  liabilityAcknowledged: true, liabilitySignedByName: 'Jamie Customer', liabilitySignature: null, liabilitySignedAt: date,
  siteContactName: 'Jamie Customer', siteContactPhone: '555-0100', personCallingName: null, personCallingPhone: null,
  company: { name: 'Example Energy' }, pad: { name: 'Example pad' },
  items: [{ rate: 100, rateType: 'daily', deployedDate: date, returnedDate: null, status: 'deployed',
    product: { name: 'Area gas monitor', partNumber: '0410003', category: 'monitor_area' }, serializedEquipment: { serialNumber: 'EQP-12345' } }],
};
const shop: Parameters<typeof generateShopWorkOrderPdf>[0] = {
  workOrderNumber: 'WO-2026-00123', status: 'completed', isInternal: false, poNumber: 'PO-123', afeNumber: null, intakeDate: date,
  intakeNotes: 'Inspect and calibrate before pickup.', promisedDate: '2026-11-17', completedDate: date, returnedDate: null, notes: null,
  dropOffContactName: 'Jamie Customer', dropOffContactPhone: '555-0100', pickupContactName: null, pickupContactPhone: null,
  pickupSignedByName: null, pickupSignature: null, pickupSignedAt: null, pickupNotes: null, totalItems: 1, completedItems: 1,
  company: { name: 'Example Energy' }, intakeBy: { name: 'Taylor Technician' },
  items: [{ itemNumber: 1, serialNumber: 'EQP-12345', equipmentCategory: 'personal_monitor', equipmentDescription: 'Personal gas monitor',
    fexBrand: null, fexSize: null, fexType: null, serviceType: 'calibrate', reportedIssue: 'Calibration due', status: 'shop_complete',
    diagnosisNotes: 'Routine service', workNotes: 'Calibration completed and verified.', estimatedCost: 87.5, isWarranty: false,
    warrantyVendor: null, sentOutTo: null, qcResult: 'pass', qcNotes: 'Verified with test gas', parentItemId: null }],
};
const health: Parameters<typeof generateOccHealthPdf>[0] = {
  ticketNumber: 'FT-2026-00123', serviceDate: date, locationDisplay: 'Example Training Room', company: { name: 'Example Energy' },
  assignedTech: { name: 'Taylor Technician' }, fitTestRecords: [{ employeeName: 'Jamie Participant', employeeId: 'EMP-123', employerName: 'Example Energy',
    jobTitle: 'Field operator', respiratorMake: 'Example', respiratorModel: 'Full face', respiratorSize: 'Medium', respiratorType: 'full_face',
    respiratorClass: 'apr', secondMask: null, testType: 'quantitative', testMethod: 'portacount', fitFactor: 500, passFail: 'pass',
    testDate: date, expiryDate: '2027-11-16', notes: 'Fit test completed.', meqAccepted: true, meqDate: date, includesFitTest: true,
    includesAudiometric: true, audiometricResult: 'normal', disclosureConditions: [], isCleanShaven: true, wearsGlassesContacts: false,
    criteriaAcknowledged: true, participantSignature: null, adverseReactions: [] }],
};
const inspection: Parameters<typeof generateEquipmentInspectionPdf>[0] = {
  serialNumber: 'EQP-12345', category: 'gas_detection', outcome: 'condemn', inspectedOn: date, condemnedOn: date,
  serviceActions: ['inspection', 'condemn'], notes: 'Damaged enclosure. Removed from service and marked for disposal.',
  technician: 'Taylor Technician', customer: 'Example Energy', manualRefs: [{ key: 'inspection', doc: 'Manufacturer service manual', section: 'Inspection' }],
};

export const pdfBrandingCases: Array<{ name: string; render: (branding: PdfBranding) => Promise<PDFKit.PDFDocument> }> = [
  { name: 'invoice', render: branding => generateInvoicePdf(invoiceFixture, branding) },
  { name: 'ticket', render: branding => generateTicketPdf(ticket, branding) },
  { name: 'rental', render: branding => generateRentalAgreementPdf(rental, branding) },
  { name: 'shop', render: branding => generateShopWorkOrderPdf(shop, branding) },
  { name: 'occupational-health', render: branding => generateOccHealthPdf(health, branding) },
  { name: 'condemnation', render: branding => generateEquipmentInspectionPdf(inspection, branding) },
  { name: 'equipment-badge', render: branding => generateEquipmentBadgePdf('EQP-12345', 'Personal gas monitor', branding) },
];
