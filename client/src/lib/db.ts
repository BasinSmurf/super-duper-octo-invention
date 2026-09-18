import Dexie, { type EntityTable } from 'dexie'
import type {
  OfflineCompany,
  OfflineField,
  OfflinePad,
  OfflineWell,
  OfflineProduct,
  OfflinePriceLevel,
  OfflineCourse,
  OfflineEquipment,
  OfflineTicket,
  OfflineTicketLineItem,
  OfflineTicketAttachment,
  AirSystemDraftRecord,
  FitTestDraftRecord,
  IhTestDraftRecord,
  GasDetectionDraftRecord,
  TrainingRosterDraftRecord,
  OfflineRentalAgreement,
  OfflineRentalAgreementItem,
  OfflineRentalDailyLog,
  OfflineShopWorkOrder,
  OfflineShopWorkOrderItem,
  OfflineEquipmentInspection,
  OfflineEquipmentInspectionAttachment,
  OfflineAttachment,
  OfflineShopTransferEvent,
  OfflineDraft,
  MutationQueueEntry,
  SyncMeta,
} from './db-types'

class SundogDB extends Dexie {
  companies!: EntityTable<OfflineCompany, 'id'>
  fields!: EntityTable<OfflineField, 'id'>
  pads!: EntityTable<OfflinePad, 'id'>
  wells!: EntityTable<OfflineWell, 'id'>
  products!: EntityTable<OfflineProduct, 'id'>
  priceLevels!: EntityTable<OfflinePriceLevel, 'id'>
  courses!: EntityTable<OfflineCourse, 'id'>
  equipment!: EntityTable<OfflineEquipment, 'id'>
  tickets!: EntityTable<OfflineTicket, 'id'>
  ticketLineItems!: EntityTable<OfflineTicketLineItem, 'id'>
  ticketAttachments!: EntityTable<OfflineTicketAttachment, 'id'>
  airSystemRecords!: EntityTable<AirSystemDraftRecord, 'id'>
  fitTestRecords!: EntityTable<FitTestDraftRecord, 'id'>
  ihTestRecords!: EntityTable<IhTestDraftRecord, 'id'>
  gasDetectionRecords!: EntityTable<GasDetectionDraftRecord, 'id'>
  trainingRosterRecords!: EntityTable<TrainingRosterDraftRecord, 'id'>
  rentalAgreements!: EntityTable<OfflineRentalAgreement, 'id'>
  rentalAgreementItems!: EntityTable<OfflineRentalAgreementItem, 'id'>
  rentalDailyLogs!: EntityTable<OfflineRentalDailyLog, 'id'>
  shopWorkOrders!: EntityTable<OfflineShopWorkOrder, 'id'>
  shopWorkOrderItems!: EntityTable<OfflineShopWorkOrderItem, 'id'>
  equipmentInspections!: EntityTable<OfflineEquipmentInspection, 'id'>
  equipmentInspectionAttachments!: EntityTable<OfflineEquipmentInspectionAttachment, 'id'>
  attachments!: EntityTable<OfflineAttachment, 'id'>
  shopTransferEvents!: EntityTable<OfflineShopTransferEvent, 'id'>
  drafts!: EntityTable<OfflineDraft, 'id'>
  mutationQueue!: EntityTable<MutationQueueEntry, 'queueId'>
  syncMeta!: EntityTable<SyncMeta, 'table'>

  constructor() {
    super('SundogDB')

    this.version(1).stores({
      // Reference data (synced down)
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',

      // Writable data (synced both ways)
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',

      // Local-only
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
    })

    // v2: Add fitTestRecords table for offline fit test data
    this.version(2).stores({
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
      // New in v2
      fitTestRecords: 'id, ticketId, employeeName, _offlineStatus',
    })

    // v3: Add airSystemRecords table for offline air system inspection data
    this.version(3).stores({
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',
      fitTestRecords: 'id, ticketId, employeeName, _offlineStatus',
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
      // New in v3
      airSystemRecords: 'id, ticketId, workPointId, _offlineStatus',
    })

    // v4: Add ihTestRecords table for IH testing data
    this.version(4).stores({
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',
      fitTestRecords: 'id, ticketId, employeeName, _offlineStatus',
      airSystemRecords: 'id, ticketId, workPointId, _offlineStatus',
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
      // New in v4
      ihTestRecords: 'id, ticketId, testType, _offlineStatus',
    })

    // v5: Add trainingRosterRecords table for training class roster data
    this.version(5).stores({
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',
      fitTestRecords: 'id, ticketId, employeeName, _offlineStatus',
      airSystemRecords: 'id, ticketId, workPointId, _offlineStatus',
      ihTestRecords: 'id, ticketId, testType, _offlineStatus',
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
      // New in v5
      trainingRosterRecords: 'id, ticketId, employerCompanyId, _offlineStatus',
    })

    // v6: Add rentalAgreements + rentalAgreementItems tables for rental equipment flow
    this.version(6).stores({
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',
      fitTestRecords: 'id, ticketId, employeeName, _offlineStatus',
      airSystemRecords: 'id, ticketId, workPointId, _offlineStatus',
      ihTestRecords: 'id, ticketId, testType, _offlineStatus',
      trainingRosterRecords: 'id, ticketId, employerCompanyId, _offlineStatus',
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
      // New in v6
      rentalAgreements: 'id, offlineId, agreementNumber, companyId, status, updatedAt, _offlineStatus',
      rentalAgreementItems: 'id, rentalAgreementId, serializedEquipmentId, status, _offlineStatus',
    })

    // v7: Add rentalDailyLogs table for site log entries (manned trailer logbook)
    this.version(7).stores({
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',
      fitTestRecords: 'id, ticketId, employeeName, _offlineStatus',
      airSystemRecords: 'id, ticketId, workPointId, _offlineStatus',
      ihTestRecords: 'id, ticketId, testType, _offlineStatus',
      trainingRosterRecords: 'id, ticketId, employerCompanyId, _offlineStatus',
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
      rentalAgreements: 'id, offlineId, agreementNumber, companyId, status, updatedAt, _offlineStatus',
      rentalAgreementItems: 'id, rentalAgreementId, serializedEquipmentId, status, _offlineStatus',
      // New in v7
      rentalDailyLogs: 'id, rentalAgreementId, logDate, loggedById, _offlineStatus',
    })

    // v8: Add shopWorkOrders + shopWorkOrderItems tables for shop service module
    this.version(8).stores({
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',
      fitTestRecords: 'id, ticketId, employeeName, _offlineStatus',
      airSystemRecords: 'id, ticketId, workPointId, _offlineStatus',
      ihTestRecords: 'id, ticketId, testType, _offlineStatus',
      trainingRosterRecords: 'id, ticketId, employerCompanyId, _offlineStatus',
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
      rentalAgreements: 'id, offlineId, agreementNumber, companyId, status, updatedAt, _offlineStatus',
      rentalAgreementItems: 'id, rentalAgreementId, serializedEquipmentId, status, _offlineStatus',
      rentalDailyLogs: 'id, rentalAgreementId, logDate, loggedById, _offlineStatus',
      // New in v8
      shopWorkOrders: 'id, workOrderNumber, companyId, status, updatedAt, _offlineStatus',
      shopWorkOrderItems: 'id, workOrderId, serialNumber, status, parentItemId, _offlineStatus',
    })

    // v9: Add gasDetectionRecords table for Phase B Gas Detection subflow
    this.version(9).stores({
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',
      fitTestRecords: 'id, ticketId, employeeName, _offlineStatus',
      airSystemRecords: 'id, ticketId, workPointId, _offlineStatus',
      ihTestRecords: 'id, ticketId, testType, _offlineStatus',
      trainingRosterRecords: 'id, ticketId, employerCompanyId, _offlineStatus',
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
      rentalAgreements: 'id, offlineId, agreementNumber, companyId, status, updatedAt, _offlineStatus',
      rentalAgreementItems: 'id, rentalAgreementId, serializedEquipmentId, status, _offlineStatus',
      rentalDailyLogs: 'id, rentalAgreementId, logDate, loggedById, _offlineStatus',
      shopWorkOrders: 'id, workOrderNumber, companyId, status, updatedAt, _offlineStatus',
      shopWorkOrderItems: 'id, workOrderId, serialNumber, status, parentItemId, _offlineStatus',
      // New in v9
      gasDetectionRecords: 'id, ticketId, monitorSerial, subtype, _offlineStatus',
    })

    // v10: Wave 1 + Wave 2 — Equipment Inspection Form + Shop Transfer Events
    this.version(10).stores({
      companies: 'id, name, companyType, isActive, updatedAt',
      fields: 'id, name, isActive, updatedAt',
      pads: 'id, fieldId, currentOperatorId, isActive, updatedAt',
      wells: 'id, padId, fieldId, currentOperatorId, isActive, updatedAt',
      products: 'id, partNumber, name, category, isActive, updatedAt',
      equipment: 'id, serialNumber, productId, status, updatedAt',
      tickets: 'id, offlineId, ticketNumber, companyId, assignedTechId, status, serviceDate, updatedAt, _offlineStatus',
      ticketLineItems: 'id, ticketId, lineNumber, updatedAt',
      ticketAttachments: 'id, ticketId, offlineBlobId, updatedAt',
      fitTestRecords: 'id, ticketId, employeeName, _offlineStatus',
      airSystemRecords: 'id, ticketId, workPointId, _offlineStatus',
      ihTestRecords: 'id, ticketId, testType, _offlineStatus',
      trainingRosterRecords: 'id, ticketId, employerCompanyId, _offlineStatus',
      drafts: 'id, ticketId, step, updatedAt',
      mutationQueue: '++queueId, table, action, entityId, createdAt, status',
      syncMeta: 'table',
      rentalAgreements: 'id, offlineId, agreementNumber, companyId, status, updatedAt, _offlineStatus',
      rentalAgreementItems: 'id, rentalAgreementId, serializedEquipmentId, status, _offlineStatus',
      rentalDailyLogs: 'id, rentalAgreementId, logDate, loggedById, _offlineStatus',
      shopWorkOrders: 'id, workOrderNumber, companyId, status, updatedAt, _offlineStatus',
      shopWorkOrderItems: 'id, workOrderId, serialNumber, status, parentItemId, _offlineStatus',
      gasDetectionRecords: 'id, ticketId, monitorSerial, subtype, _offlineStatus',
      // New in v10 — Wave 1: unified Equipment Inspection (polymorphic on shopItemId | ticketId)
      equipmentInspections: 'id, shopItemId, ticketId, serializedEquipmentId, serialNumber, category, lockedAt, _offlineStatus',
      // New in v10 — Wave 2: append-only shop-to-shop transfer log
      shopTransferEvents: 'id, workOrderId, transferredAt, _offlineStatus',
    })

    // v11 — inspection evidence attachments (condemn / cannot-service photos +
    // UE report PDF). Local store; uploads drain via the mutation queue.
    this.version(11).stores({
      equipmentInspectionAttachments: 'id, inspectionId, _offlineStatus',
    })

    // v12 — ClassPRO course catalog (reference data; synced down only).
    this.version(12).stores({
      courses: 'id, code, isActive, updatedAt',
    })

    // v13 — parts numbering by division: index products.division so the
    // line-item picker can scope offline searches to the working division.
    this.version(13).stores({
      products: 'id, partNumber, name, category, division, isActive, updatedAt',
    })

    // v14 — unified attachments (the two-hop capture pipeline). One local table
    // for photos, UE/Pozi PDFs and vendor invoices, whatever they hang off.
    // storageState is indexed so the sync bar can count what is still local
    // without walking every row.
    this.version(14).stores({
      attachments: 'id, shopItemId, inspectionId, ticketId, serialNumber, storageState, _offlineStatus',
    })

    // v15 — customer contract pricebooks (QB price levels; reference data,
    // synced down only). Item rules ride nested on the row, so there is no
    // second table and no join at read time: the wizard looks the level up
    // once per customer and resolves every line against it in memory.
    this.version(15).stores({
      priceLevels: 'id, isActive, updatedAt',
    })
  }
}

export const db = new SundogDB()
