// Offline record types — mirrors Prisma models but simplified for client-side IndexedDB

import type { QbDivision } from './qbDivision'

export type OfflineStatus = 'synced' | 'pending' | 'error'

/** #3 A single structured billing reference row on a ticket. */
export type BillingRefType = 'po' | 'afe' | 'cost_code'
export interface BillingRef {
  id: string
  type: BillingRefType
  value: string
  required?: boolean
}

// ---- Reference data (read-only on device, synced down from server) ----

/** #3/#4 lightweight billing-profile seed carried with the company offline. */
export interface BillingProfileSeed {
  id: string
  requiresPo?: boolean
  requiresAfe?: boolean
  defaultPoNumber?: string | null
  defaultAfeNumber?: string | null
  defaultCostCenter?: string | null
  // #4 job-type scope (added with the per-job-type profiles feature)
  appliesToTicketTypes?: string[] | null
  appliesToDivisions?: string[] | null
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

export interface OfflineCompany {
  id: string
  name: string
  legalName?: string | null
  parentCompanyId?: string | null
  companyType: string
  isActive: boolean
  // Cash/Card-only customer — surfaces card payment + warning on their work.
  cashCcOnly?: boolean
  // AR credit hold — blocks new tickets and shop equipment returns.
  creditHold?: boolean
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  phone?: string | null
  email?: string | null
  // #3 customer-specific field labels (display only)
  poLabel?: string | null
  afeLabel?: string | null
  woLabel?: string | null
  costCenterLabel?: string | null
  // #3/#4 active billing profiles (seed for wizard PO/AFE/Cost-Code + selection)
  billingProfilesSeed?: BillingProfileSeed[]
  /** The customer's assigned contract pricebook (OfflinePriceLevel.id). */
  qbPriceLevelId?: string | null
  updatedAt: string
}

export interface OfflineField {
  id: string
  name: string
  county?: string | null
  state: string
  notes?: string | null
  isActive: boolean
  updatedAt: string
}

export interface OfflinePad {
  id: string
  name: string
  fieldId: string
  currentOperatorId?: string | null
  currentOperatorName?: string | null
  section?: number | null
  township?: number | null
  range?: number | null
  latitude?: number | null
  longitude?: number | null
  county?: string | null
  directions?: string | null
  accessNotes?: string | null
  facilityCode?: string | null
  pendingReview: boolean
  tier1?: boolean
  // Mobile/rented equipment billed per-job to whoever contracted it, not the
  // operator of today's site — never scoped to one operator the way a real
  // 'site' pad is. gas_plant/tank_battery/etc. are fixed, single-operator
  // places that just never get a DMR match. See LocationPicker/LocationRequestsTab.
  assetCategory?: 'site' | 'other_mobile'
    | 'gas_plant' | 'tank_battery' | 'compressor_station' | 'swd_facility' | 'office' | 'shop'
  isActive: boolean
  updatedAt: string
}

export interface OfflineWell {
  id: string
  padId?: string | null
  fieldId: string
  currentOperatorId?: string | null
  currentOperatorName?: string | null
  apiNumber?: string | null
  wellName?: string | null
  wellNameBase?: string | null
  wellType?: string | null
  wellStatus?: string | null
  county?: string | null
  facilityCode?: string | null
  latitude?: number | null
  longitude?: number | null
  hasSuppliedAir: boolean
  hasAreaMonitors: boolean
  isHighRisk: boolean
  // Reservation flag driving the 5% Tier 1 fee — same meaning as
  // OfflinePad.tier1, but this is the one that actually fires for most work
  // since almost no well has a pad.
  tier1?: boolean
  isActiveForService: boolean
  pendingReview: boolean
  // Same concept/enum as OfflinePad.assetCategory — see there.
  assetCategory?: 'site' | 'other_mobile'
    | 'gas_plant' | 'tank_battery' | 'compressor_station' | 'swd_facility' | 'office' | 'shop'
  updatedAt: string
}

export interface OfflineProduct {
  id: string
  partNumber: string
  name: string
  description?: string | null
  category: string
  productType: string
  unitOfMeasure?: string | null
  // Parts-numbering facets parsed from new-scheme 7-digit part numbers
  // (null for legacy numbers). Scope the picker only — not revenue class.
  division?: number | null
  partFamily?: number | null
  partSubgroup?: number | null
  defaultSellPrice?: number | null
  defaultRentalRateDaily?: number | null
  defaultRentalRateWeekly?: number | null
  defaultRentalRateMonthly?: number | null
  /** QB ListID — the key a price-level rule matches on. */
  qbItemListId?: string | null
  isSerialized: boolean
  isAssembly: boolean
  isActive: boolean
  updatedAt: string
}

/**
 * A customer contract pricebook pulled from QuickBooks, with its per-item
 * rules nested. Reference data (synced down only) — see lib/priceLevels.ts
 * for the resolver that turns one of these into a rate.
 */
export interface OfflinePriceLevelItem {
  qbItemListId: string
  qbItemFullName?: string | null
  /** Flat negotiated price for the item. Wins over adjustPercent. */
  customPrice: number | null
  /** Percentage off/on the list rate (negative = discount). */
  adjustPercent: number | null
}

export interface OfflinePriceLevel {
  id: string
  name: string
  isActive: boolean
  qbCustomerListId?: string | null
  qbCustomerName?: string | null
  items: OfflinePriceLevelItem[]
  updatedAt: string
}

/** ClassPRO course catalog row (reference data for the training wizard). */
export interface OfflineCourse {
  id: string
  code: string
  name: string
  durationHours?: number | null
  validityMonths?: number | null
  passingScore?: number | null
  cardsOnSite: boolean
  bookVersion?: string | null
  testVersion?: string | null
  standard?: string | null
  description?: string | null
  sortOrder: number
  isActive: boolean
  updatedAt: string
}

export interface OfflineEquipment {
  id: string
  productId: string
  serialNumber: string
  ownership: string
  status: string
  currentPadId?: string | null
  currentWellId?: string | null
  currentFacilityId?: string | null
  currentCustomerId?: string | null
  currentRentalId?: string | null
  parentEquipmentId?: string | null
  calibrationDueDate?: string | null
  lastCalibrationDate?: string | null
  bumpTestDueDate?: string | null
  safeCoreSerial?: string | null
  conditionNotes?: string | null
  updatedAt: string
}

// ---- Writable data (created/edited on device, synced up to server) ----

export interface OfflineTicket {
  id: string
  offlineId?: string | null
  ticketNumber?: string | null
  ticketType: string
  serviceSubtype?: string | null
  status: string
  companyId: string
  fieldId?: string | null
  padId?: string | null
  wellId?: string | null
  facilityId?: string | null
  workPointId?: string | null
  locationDisplay?: string | null
  assignedTechId?: string | null
  serviceDate: string
  arrivalTime?: string | null
  departureTime?: string | null
  afeNumber?: string | null
  poNumber?: string | null
  costCenter?: string | null
  // #3 structured billing refs (source of truth; flats above are derived)
  billingRefs?: BillingRef[] | null
  division?: QbDivision | null
  isDickinson?: boolean
  customerRepName?: string | null
  customerRepSignature?: string | null
  techSignature?: string | null
  dispatchNotes?: string | null
  workDescription?: string | null
  internalNotes?: string | null
  linkedRentalAgreementId?: string | null
  customData?: Record<string, unknown> | null
  offlineCreated: boolean
  sourceTicketId?: string | null
  sourceType?: string | null
  // Supervisor review fields (server-populated; techs don't write these)
  reviewSignal?: {
    verdict: 'green' | 'yellow' | 'red'
    reasons: string[]
    ruleResults: Record<string, 'pass' | 'warn' | 'fail'>
    ranAt: string
    engineVersion: number
  } | null
  reviewSignalRanAt?: string | null
  reviewedById?: string | null
  reviewedAt?: string | null
  autoApproved?: boolean
  rejectionReason?: string | null
  createdAt: string
  updatedAt: string
  _offlineStatus?: OfflineStatus
}

export interface OfflineTicketLineItem {
  id: string
  ticketId: string
  lineNumber: number
  lineType: string
  productId?: string | null
  description?: string | null
  quantity: number
  rate?: number | null
  total?: number | null
  unitOfMeasure?: string | null
  serialNumberInstalled?: string | null
  serialNumberRemoved?: string | null
  testResult?: string | null
  calGasLotNumber?: string | null
  sortOrder: number
  notes?: string | null
  /**
   * Free-form per-line payload (maps to TicketLineItem.customData). Today it
   * carries only the pricing provenance stamped when the line was added —
   * `{ priceLevel: { name, listRate, contractRate } }` — so the ticket can
   * say WHY a rate is what it is long after the wizard closed.
   */
  customData?: Record<string, unknown> | null
  updatedAt: string
  _offlineStatus?: OfflineStatus
}

export interface OfflineTicketAttachment {
  id: string
  ticketId: string
  fileName: string
  fileType: string
  filePath?: string | null
  fileSizeBytes?: number | null
  mimeType?: string | null
  offlineBlobId?: string | null
  dataUrl?: string | null // base64 photo data for offline storage
  uploadedAt: string
  // #11 Occ Health: fit_test_report attachments link to their roster row;
  // calibration_cert (daily cal) leaves this null.
  fitTestRecordId?: string | null
  _offlineStatus?: OfflineStatus
}

// Evidence files on an inspection — condemn / cannot-service photos and the
// external UE report PDF. Mirrors OfflineTicketAttachment.
export interface OfflineEquipmentInspectionAttachment {
  id: string
  inspectionId: string
  fileName: string
  fileType: string          // 'photo' | 'document'
  filePath?: string | null
  fileSizeBytes?: number | null
  mimeType?: string | null
  offlineBlobId?: string | null
  dataUrl?: string | null   // base64 data, kept locally for instant display
  uploadedAt: string
  _offlineStatus?: OfflineStatus
}

/**
 * OfflineAttachment — the device end of the two-hop pipeline.
 *
 * `dataUrl` is the LOCAL COPY, and it is the only copy until the SP server
 * acknowledges. It is cleared by the sync engine on ack and never before:
 * that clearing is the "delete the local copy once synced" step, and it means
 * synced to the SP SERVER, not to the object store. A device that drops its
 * copy while B2 is unreachable has lost the file.
 *
 * `sha256` is computed here, on the device, and sent alongside the bytes so the
 * server can reject a mangled transfer while the original still exists.
 */
export interface OfflineAttachment {
  id: string
  // Exactly one parent, mirroring the server's CHECK constraint.
  shopItemId?: string | null
  inspectionId?: string | null
  ticketId?: string | null
  serialNumber?: string | null
  kind: string              // AttachmentKind
  fileName: string
  mimeType?: string | null
  fileSizeBytes?: number | null
  sha256: string
  /** Local bytes. Cleared only once the SP server has acknowledged them. */
  dataUrl?: string | null
  offlineBlobId?: string | null
  capturedAt: string
  /** Mirrors the server's storage state once known; 'local' until first ack. */
  storageState?: 'local' | 'buffered' | 'remote' | 'failed'
  _offlineStatus?: OfflineStatus
}

// ---- Draft persistence ----

export interface OfflineDraft {
  id: string
  ticketId?: string | null
  step: number
  wizardData: WizardDraftData
  updatedAt: string
}

export interface WizardDraftData {
  // Step 0: Work type
  workType: string // '' | 'field_service' | 'fit_test' | 'ih_testing' | 'training' | 'repair' | 'rental'

  // Field service: Screen 1
  customer: { id: string; name: string; companyType: string; city: string | null; state: string | null } | null
  location: {
    field: { id: string; name: string } | null
    pad: {
      id: string
      name: string
      fieldId: string
      currentOperatorId?: string | null
      currentOperatorName?: string | null
    } | null
    wells: {
      id: string
      wellName: string | null
      padId: string | null
      apiNumber?: string | null
      pendingReview?: boolean
      currentOperatorId?: string | null
      currentOperatorName?: string | null
    }[]
  }
  serviceType: string
  poNumber: string
  // #3 structured billing refs (PO/AFE/Cost-Code repeater)
  billingRefs?: BillingRef[]
  // Internal classification (QB Class). Internal-only, never on customer PDFs.
  division: QbDivision | null
  isDickinson: boolean
  // Field inspection only: short code of the shop failed units transit to
  // (default 'WIL'). Drives the spawned Shop WO's transitToShortCode.
  returnShopShortCode?: string
  // Field service: Screen 2
  arrivedAt: string | null
  siteTimesManual?: { arrived: boolean; departed: boolean }
  onSiteSubtype?: 'confined_space' | 'manned_trailer' | 'bottle_watch' | 'other' | null
  onSiteEntries?: SiteLogEntry[]
  onSiteOtherDescription?: string
  serviceDate: string
  dispatchNotes: string
  // Field service: Screen 3
  lineItems: Array<{
    id: string
    lineType: string
    description: string
    quantity: number
    rate?: number | null
    total?: number | null
    unitOfMeasure?: string
    serialNumberInstalled?: string
    serialNumberRemoved?: string
    testResult?: 'pass' | 'fail' | null
    calGasLotNumber?: string
    notes?: string
  }>
  // Field service: Screen 4 / Fit test: Wrap up
  departedAt: string | null
  workNotes: string
  photos: Array<{ id: string; dataUrl: string; timestamp: string }>
  siteSignPhotos?: Array<{
    id: string
    dataUrl: string
    timestamp: string
    latitude?: number | null
    longitude?: number | null
    accuracy?: number | null
    geotaggedAt?: string | null
  }>
  signature: string | null

  // Fit test records (only used when workType === 'fit_test')
  fitTestRecords: FitTestDraftRecord[]
  // #10 Occ Health setup: which services this visit covers + on-site mileage
  occServices?: ('fit_test' | 'audiometric')[]
  occOnSite?: boolean
  occMileage?: string
  // #12 Training on-site mileage
  trainingMileage?: string

  // Air system inspection records (only used when serviceType === 'cascade_air')
  airSystemRecords: AirSystemDraftRecord[]
  newInstallSystems?: Array<{
    id: string
    workPointName: string
    airSystemType: string
    reelSerialNumber: string
    standSerialNumber: string
    regulatorSerial: string
    cylinders: Array<{ serialNumber: string; hydroDate: string; expiryDate: string }>
    installDescription: string
  }>

  // Gas detection records (only used when serviceType === 'gas_detection')
  gasDetectionRecords?: GasDetectionDraftRecord[]
  gasDetectionFixed?: boolean
  gasDetectionArea?: boolean
  d3CombinedServices?: Array<'air' | 'ih' | 'gas'>

  // IH test records (only used when workType === 'ih_testing')
  ihTestRecords: IhTestDraftRecord[]
  // #8 multi-select IH subtypes (O2/H2S/Sampling/Audiometric on one ticket).
  // serviceType keeps the first selected for legacy single-subtype consumers.
  ihSubtypes?: IhTestType[]
  // Training roster records (only used when workType === 'training')
  trainingRosterRecords: TrainingRosterDraftRecord[]
  trainingCourseName?: string
  trainingCourseOther?: string
  trainingTrainerName?: string
  trainingIsOnSite?: boolean
  trainingLocationText?: string
  cpLocationId?: string | null

  // Linked rental (field service cal visits linked to a rental agreement)
  linkedRentalId?: string | null

  // Field service: rig present on-site (independent of the main location)
  rigPresent?: boolean
  presentRigId?: string | null
  presentRigName?: string | null

  // Air fill (only used when workType === 'air_fill')
  airFillLocationText?: string
  driverName?: string
  airFillArrivePsi?: string
  airFillDepartPsi?: string
  airFillTankCount?: number

  // Rental records (only used when workType === 'rental')
  selectedStartJobRentalId?: string | null
  rentalItems: OfflineRentalAgreementItem[]
  rentalBillingRateType?: string
  rentalAfeNumber?: string
  // Rental liability waiver
  rentalLiabilitySignedByName?: string
  rentalLiabilitySignature?: string | null
  rentalLiabilityAcknowledged?: boolean
  // Rental site contact
  rentalSiteContactName?: string
  rentalSiteContactPhone?: string
  rentalSiteContactEmail?: string
  // #1 PIC roster (manned-trailer)
  rentalPics?: RentalPic[]
  deployShortReason?: string
}

export interface FitTestDraftRecord {
  id: string
  ticketId?: string              // set when stored in Dexie (links to offline ticket)
  employeeName: string
  employeeId: string
  employerName: string
  jobTitle: string
  respiratorType: string    // half_face | full_face (legacy rows may carry scba | sar)
  // #14 Full Face air-supply class: 'apr' (particulate) | 'sar' (supplied air).
  // Half Face is always APR → stored null. Fit factor is required on SAR only.
  respiratorClass?: 'apr' | 'sar' | null
  respiratorMake: string
  respiratorModel: string
  respiratorSize: string
  testMethod: string        // portacount | tsi_8030 | isoamyl_acetate | bitrex (legacy: irritant_smoke | ambient_aerosol)
  passFail: 'pass' | 'fail'
  fitFactor: number | null
  meqAccepted: boolean      // "MEQ Current"
  meqDate?: string | null   // ISO date the MEQ was verified current
  // #10/#11 Occ Health: each person can take Fit Test, Audiometric, or both.
  includesFitTest?: boolean        // default true (legacy rows are pure fit tests)
  includesAudiometric?: boolean
  audiometricResult?: 'baseline' | 'retest' | null
  // #11 per-person individual-results files (client capture; submitted as
  // fit_test_report ticket attachments linked via fitTestRecordId)
  resultFiles?: { id: string; fileName: string; mimeType: string; dataUrl: string }[]
  // #17 optional second mask tested for the same person
  secondMask?: {
    respiratorType: string
    respiratorClass?: 'apr' | 'sar' | null
    make: string
    model: string
    size: string
    fitFactor: number | null
  } | null
  notes: string
  testDate?: string              // ISO date, set from serviceDate when saving
  updatedAt?: string             // ISO timestamp
  _offlineStatus?: OfflineStatus // sync status

  // Disclosure: participant acceptance conditions (initialed = true)
  disclosureConditions: string[]   // keys from DISCLOSURE_CONDITIONS
  isCleanShaven: boolean | null    // yes/no/unanswered
  wearsGlassesContacts: boolean | null

  // Disclosure: adverse reactions experienced during test
  adverseReactions: string[]       // keys from ADVERSE_REACTIONS

  // Disclosure: criteria & understanding acknowledgment
  criteriaAcknowledged: boolean
  participantSignature: string | null  // base64 data URL
}

// ---- Air system inspection records ----

export interface CylinderRecord {
  id: string                     // unique per-cylinder ID within a record
  serialNumber: string           // current serial (becomes "old" serial when replaced)
  hydroDate: string              // ISO date or empty — current bottle's last hydro
  expiryDate: string             // ISO date or empty — current bottle's expiry
  condition: 'pass' | 'fail' | 'na'
  replaced: boolean              // true if this cylinder was swapped out
  replacedNewSerial: string      // new bottle serial installed
  replacedNewHydroDate: string   // new bottle's last hydro test date
  replacedNewExpiryDate: string  // new bottle's expiry date
}

export interface AirSystemDraftRecord {
  id: string
  ticketId?: string
  workPointId?: string | null    // Links to the WorkPoint being inspected
  workPointName: string          // Display name (e.g. "Tank Battery #1")
  airSystemType: string          // e.g. "Tank Battery", "Oil Tank Battery", "Compressor"

  // Serial tracking
  reelSerialNumber: string
  standSerialNumber: string

  // Inspection results
  overallResult: 'pass' | 'fail' | 'needs_service'

  // Component checks — each is pass/fail/na
  reelCondition: 'pass' | 'fail' | 'na'
  standCondition: 'pass' | 'fail' | 'na'
  hoseCondition: 'pass' | 'fail' | 'na'
  maskCondition: 'pass' | 'fail' | 'na'
  regulatorCondition: 'pass' | 'fail' | 'na'
  gaugeCondition: 'pass' | 'fail' | 'na'
  alarmCondition: 'pass' | 'fail' | 'na'
  cylinderCondition: 'pass' | 'fail' | 'na'

  // Cascade readings (arrival / departure)
  cascadeArrivalPsi: number | null
  cascadeDeparturePsi: number | null

  // Cylinders — array so each bottle is tracked individually
  cylinders: CylinderRecord[]

  // Service actions taken
  serviceActions: string[]       // keys from SERVICE_ACTIONS constant
  partsReplaced: string          // free text for parts notes

  // Replacement serial tracking for non-cylinder components (old removed / new installed)
  replacedRegulatorSerialOld: string
  replacedRegulatorSerialNew: string
  replacedMaskSerialOld: string
  replacedMaskSerialNew: string

  notes: string
  inspectedAt: string            // ISO timestamp

  _offlineStatus?: OfflineStatus
}

// ---- IH (Industrial Hygiene) testing records ----

export type IhTestType = 'ih_h2s' | 'ih_o2_voc' | 'ih_sampling' | 'ih_audiometric'

export interface H2sTestData {
  readings: Array<{
    id: string
    locationPoint: string       // free text: "Treater", "Tubing", "Wellhead", etc.
    ppmReading: number | null
    backgroundPpm: number | null
    instrumentSerial: string
    durationMinutes: number | null
    result: 'pass' | 'fail' | 'na'
  }>
  weatherConditions: string     // "Clear", "Windy", "Rain", etc.
  windDirection: string
  temperature: number | null
  instrumentModel: string
}

export interface O2VocTestData {
  samplePoints: Array<{
    id: string
    pointName: string           // free text: "Upwind", "Downwind", "Tank Walkway", etc.
    o2Percent: number | null
    vocPpm: number | null
    notes: string
  }>
  instrumentSerial: string
  instrumentModel: string
}

export interface SamplingTestData {
  samples: Array<{
    id: string
    sampleType: string          // "Produced Water", "Oil", "Gas", "Condensate"
    collectionPoint: string     // free text: where it was collected
    labId: string               // Lab sample ID / chain of custody #
    deliveryDate: string        // ISO date — when sample delivered to lab
    notes: string
  }>
}

export interface AudiometricTestData {
  personnel: Array<{
    id: string
    employeeName: string
    employeeId: string
    employerName: string
    tested: boolean
    result: 'pass' | 'fail' | 'referred' | 'na'  // referred = needs follow-up
    notes: string
  }>
}

export type IhTestData = H2sTestData | O2VocTestData | SamplingTestData | AudiometricTestData

export interface IhTestDraftRecord {
  id: string
  ticketId?: string
  testType: IhTestType
  locationPoint: string         // free text describing test location
  instrumentModel: string
  instrumentSerial: string
  testData: IhTestData
  notes: string
  testedAt: string              // ISO timestamp
  _offlineStatus?: OfflineStatus
}

// ---- Gas detection records (Phase B) ----

export type GasDetectionSubtype = 'bump' | 'calibration' | 'sensor_replacement' | 'other_repair'

export interface GasDetectionDraftRecord {
  id: string
  ticketId?: string
  monitorMake: string
  monitorModel: string
  monitorSerial: string
  subtype: GasDetectionSubtype
  testResult: 'pass' | 'fail' | null
  sensorReplaced: string         // for subtype='sensor_replacement'
  workPerformed: string          // for subtype='other_repair'
  notes: string
  _offlineStatus?: OfflineStatus
}

// ---- Training class roster records ----

export interface TrainingRosterDraftRecord {
  id: string
  ticketId?: string
  employeeName: string
  employeeId: string
  employerName: string
  employerCompanyId: string | null
  contactEmail: string
  contactPhone: string
  courseName: string
  passed: boolean
  cardIssuedOnSite: boolean
  cardIssuedOfficial: boolean
  cardNumber: string
  cardExpiryDate: string           // ISO date string or empty
  notes: string
  trainedAt: string                // ISO timestamp
  _offlineStatus?: OfflineStatus
}

// ---- Rental agreement records ----

/** #C Rental composition (dispatch-time spec/BOM). Booleans isManned/isRigJob/
 * monitorsIncluded are derived from this server-side. */
// #5 Per-unit rate lives on the composition line (the "type"), set at creation.
// Billing = rate × qty × periods (priced to the job, not the scanned serial).
// rate is in the agreement's billingRateType units (daily/weekly/monthly).
export interface RentalGasMonitorSpec { id: string; productId: string; productName?: string; qty: number; rate?: number | null }
export interface RentalOtherSpec { id: string; label: string; qty: number; productId?: string | null; rate?: number | null }
export type RentalBomType = 'standard' | 'manned' | 'unmanned' | 'other' | 'rig' | 'drilling'

export interface RentalComposition {
  trailer: { manned: boolean; rate?: number | null } | null
  gasMonitors: RentalGasMonitorSpec[]
  other: RentalOtherSpec[]
  drillingRig: boolean
  // Baseline BOM snapshot, resolved from the customer's saved package at
  // dispatch (Standard, or Drilling when the rig toggle is on). Frozen with the
  // agreement so later edits to the customer BOM don't rewrite history; drives
  // the deploy-diff. equipmentCategory = the ProductCategory it maps to.
  // DESCRIPTIVE — the package's contents, not charges. `bomPackage` bills.
  bom?: { label: string; qty: number; rate?: number | null; equipmentCategory?: string; productId?: string | null }[]
  bomType?: RentalBomType | null
  // The package as ONE billable line — "Standard Package @ daily rate", qty 1
  // per period. productId is what lets the customer's price level reach it.
  bomPackage?: RentalBomPackageSpec | null
  // Gear deployed ABOVE the baseline, resolved at deploy time. Each row bills
  // on its own; a short-deploy never appears here (the package bills whole).
  bomExtras?: RentalBomExtraSpec[]
  // Required when the tech deploys less than the package baseline.
  deploymentExceptions?: {
    shortReason: string
    recordedAt: string
    shortRows: Array<{
      equipmentCategory?: string
      label: string
      expected: number
      deployed: number
      short: number
    }>
  }
}

export interface RentalBomPackageSpec {
  label: string
  bomType?: RentalBomType | null
  productId?: string | null
  productName?: string | null
  qty: number
  rate?: number | null
}

export interface RentalBomExtraSpec {
  id: string
  label: string
  equipmentCategory?: string
  productId?: string | null
  qty: number
  rate?: number | null
}

/** #1 PIC roster entry — a foreperson / person-in-charge on a rental job. */
export interface RentalPic {
  id: string
  name: string
  phone?: string
  email?: string
  addedAt?: string   // ISO
  addedBy?: string   // user name/id who added the entry
}

export interface OfflineRentalAgreement {
  id: string
  offlineId?: string | null
  agreementNumber?: string | null
  companyId: string
  companyName?: string         // denormalized for display
  fieldId: string | null
  padId: string | null
  wellId: string | null        // primary/legacy well (= wellIds[0])
  wellIds?: string[]           // all selected wells (surfaced on the rental card)
  status: string               // 'scheduled' | 'active' | 'completed' | 'cancelled'
  pickupType: string           // 'dispatch' | 'walk_in'
  startDate: string            // ISO date
  endDate: string | null
  billingRateType: string      // 'daily' | 'weekly' | 'monthly'
  poNumber: string
  afeNumber: string
  notes: string
  // Billing classification toggles
  isManned: boolean
  isRigJob: boolean
  monitorsIncluded: boolean
  // Liability waiver
  liabilityAcknowledged: boolean
  liabilitySignedByName: string
  liabilitySignature: string | null
  liabilitySignedAt: string | null
  // Site contact
  siteContactName: string
  siteContactPhone: string
  siteContactEmail: string
  // Person calling — customer-side requester (dispatch) / counter signer (walk-in)
  personCallingName?: string | null
  personCallingPhone?: string | null
  personCallingEmail?: string | null
  // #1 PIC roster — forepersons on the job (canonical here; edited from the
  // manned-trailer ticket and written through on sync).
  pics?: RentalPic[] | null
  // #C dispatch-time composition spec/BOM (booleans above derived from it)
  composition?: RentalComposition | null
  createdAt: string
  updatedAt: string
  _offlineStatus?: OfflineStatus
}

export interface OfflineRentalAgreementItem {
  id: string
  rentalAgreementId: string
  productId: string
  productName?: string         // denormalized for display
  serializedEquipmentId: string
  serialNumber?: string        // denormalized for display
  rate: number | null
  rateType: string             // 'daily' | 'weekly' | 'monthly'
  deployedDate: string         // ISO date
  returnedDate: string | null
  status: string               // 'deployed' | 'returned' | 'swapped' | 'lost'
  // #19/#20 deploy QA gate answers (DeployInspectionResult from lib/deployChecklist).
  // Assembly children carry { coveredBy: <parent item id> }.
  deployInspection?: import('@/lib/deployChecklist').DeployInspectionResult | null
  _offlineStatus?: OfflineStatus
}

// ---- Shop Work Orders ----

/** Who was spoken to (WI-10). The discriminator that lets one log serve both
 *  the "chasing the customer for pickup" and "chasing the vendor for an ETA"
 *  cards without either becoming a special case. */
export type ContactParty = 'customer' | 'vendor'

/** Shop contact-log entry — a recorded call/email, to a customer or a vendor. */
export type ShopContactMethod = 'call' | 'email' | 'text' | 'in_person' | 'other'
export interface ShopContactLogEntry {
  id: string
  party: ContactParty
  method: ShopContactMethod
  note: string
  contactedAt: string      // ISO date+time
  /** Optional ETA / next follow-up. Drives the supervisor follow-up widget. */
  followUpAt?: string | null
  entererById?: string | null
  enteredByName?: string | null
  createdAt: string
  /** Soft delete — the row survives, marked. Absent from the default read. */
  deletedAt?: string | null
  deleteReason?: string | null
}

export interface OfflineShopWorkOrder {
  billingWaiver?: { reason: string; waivedAt: string; waivedById: string } | null
  id: string
  workOrderNumber: string
  status: string               // ShopWorkOrderStatus: intake | in_progress | hold | complete | closed
  companyId: string
  companyName?: string         // denormalized for display
  isInternal: boolean
  poNumber: string | null
  afeNumber: string | null
  tier1?: boolean              // Tier 1 reservation billing (5% fee + Pale Horse)
  intakeDate: string           // ISO date
  intakeNotes: string | null
  intakeById: string | null
  intakeByName?: string        // denormalized
  // Basin Site this WO was received at + optional Pad pointers
  intakeSiteId: string         // FK Site
  // Distinct Sites this WO's top-level items currently occupy (per-item location
  // truth). Drives site-scoped list filtering online + offline. From the API.
  itemSiteIds?: string[]
  // Personal-monitor storage bins across this WO's items (e.g. ["Bin 7"]). From the API.
  bins?: string[]
  sourceLocationId: string | null  // FK Pad — Basin tech picked up from customer site
  returnLocationId: string | null  // FK Pad — return to a different pad than source
  promisedDate: string | null
  priority: number             // 1=urgent, 5=normal
  completedDate: string | null
  returnedDate: string | null
  // Drop-off contact (person bringing equipment in)
  dropOffContactName: string | null
  dropOffContactPhone: string | null
  dropOffContactEmail: string | null
  dropOffContactPreferred: string | null // 'call' | 'text' | 'email'
  // Pickup contact ("who do we call when it's ready")
  pickupContactName: string | null
  pickupContactPhone: string | null
  pickupContactEmail: string | null
  pickupContactPreferred: string | null
  // Customer-contact log (pickup chasing) — append-only, no status change.
  /** WI-10: entries now come from their own table, as `contactEntries`.
   *  `contactLog` is the retired JSONB shape — still on the row for rollback,
   *  no longer written. Kept typed so an offline cache written by the previous
   *  release still parses. */
  contactLog?: ShopContactLogEntry[] | null
  contactEntries?: ShopContactLogEntry[] | null
  // Pickup / Release (signature at release — distinct from pickup contact above)
  pickupSignedByName: string | null
  pickupSignature: string | null
  pickupSignedAt: string | null
  pickupNotes: string | null
  totalItems: number
  completedItems: number
  primaryCategory: string | null // EquipmentCategoryShop
  notes: string | null
  // WO-level billing extras (mileage/trip + order misc), billed once by the sweep.
  // Shape: { mileage?: {miles,rate}|{flat}, misc?: [{description,amount}], billedTicketId?: string }
  billingExtras?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  _offlineStatus?: OfflineStatus
}

export interface OfflineShopWorkOrderItem {
  id: string
  workOrderId: string
  itemNumber: number
  serializedEquipmentId: string | null
  serialNumber: string
  equipmentCategory: string    // EquipmentCategoryShop
  productId: string | null
  equipmentDescription: string | null
  // FEX-specific
  fexBrand: string | null
  fexSize: string | null
  fexType: string | null
  serviceType: string          // ShopServiceType
  reportedIssue: string | null
  status: string               // ShopItemStatus
  // Diagnosis
  diagnosisNotes: string | null
  diagnosedById: string | null
  diagnosedAt: string | null
  // Quote
  estimatedCost: number | null
  quoteSentAt: string | null
  quoteApprovedAt: string | null
  quoteDeclinedAt: string | null
  // Work
  assignedToId: string | null
  workNotes: string | null
  workCompletedAt: string | null
  // Warranty / Outside Service
  isWarranty: boolean
  warrantyVendor: string | null
  sentOutDate: string | null
  sentOutMethod: string | null // ShipmentMethod
  sentOutTracking: string | null
  sentOutTo: string | null
  receivedBackDate: string | null
  receivedBackNotes: string | null
  // QC
  qcTestedById: string | null
  qcResult: string | null
  qcNotes: string | null
  qcCompletedAt: string | null
  // Return
  returnedAt: string | null
  returnMethod: string | null
  // On-Hold reason (WI-02). Only populated for the generic `on_hold` status —
  // the parts/approval/vendor holds derive their reason from status instead.
  holdReason?: string | null
  holdNote?: string | null
  // Per-unit billing ledger (Wave 2) — set when the unit was swept onto a
  // billing ticket; the bill-ready sweep skips units that already have it.
  billedAt?: string | null
  billedTicketId?: string | null
  // Parts (materials)
  partsUsed: any | null        // JSONB array
  // Structured per-unit billing chunk (labor time, misc, outside-vendor +
  // invoice attachment, roll-up flag). See shopWoTicketGen for the shape.
  billing?: Record<string, unknown> | null
  // Category-specific extras (monitor brand/model/gas, personal-monitor binLocation, etc.)
  customData?: Record<string, unknown> | null
  // SCBA parent
  parentItemId: string | null
  createdAt: string
  updatedAt: string
  _offlineStatus?: OfflineStatus
}

// ---- Equipment Inspection (Wave 1) ----
// Polymorphic on shopItemId | ticketId. Append-only event log: once lockedAt
// is set, server rejects updates and corrections file as a new record via
// correctsId. See project_inspection_forms_and_transfers.md.

export interface OfflineEquipmentInspection {
  id: string
  // Parent — exactly one populated (CHECK constraint enforced server-side)
  shopItemId: string | null
  ticketId: string | null
  // Equipment identity
  serializedEquipmentId: string | null
  serialNumber: string
  category: string             // EquipmentInspectionCategory
  // Outcome — drives equipment lifecycle flow-back
  outcome: string              // InspectionOutcome
  // Multi-select per category — vocabulary validated at API/UI layer
  serviceActions: string[]
  // Category-specific data — shape determined by category (see route module)
  data: Record<string, unknown>
  partsReplaced: string | null
  notes: string | null
  // Tech / signoff
  inspectedById: string | null
  inspectedByName?: string     // denormalized for display
  inspectedAt: string          // ISO timestamp
  // Customer approval signature on this specific inspection
  customerApprovedName: string | null
  customerApprovedSignature: string | null
  customerApprovedAt: string | null
  // Append-only / event log
  lockedAt: string | null      // ISO timestamp; once set, record is immutable
  correctsId: string | null    // points at the prior record this corrects
  createdAt: string
  updatedAt: string
  _offlineStatus?: OfflineStatus
}

// ---- Shop Transfer Event (Wave 2) ----
// Append-only log of shop-to-shop transfers between Basin Sites. The WO's
// birth state at its intake Site is NOT a transfer event; transfers only
// model shop-to-shop hops within Basin.

export interface OfflineShopTransferEvent {
  id: string
  workOrderId: string
  fromSiteId: string           // FK Site
  toSiteId: string             // FK Site
  transferredById: string | null
  transferredByName?: string   // denormalized for display
  transferredAt: string        // ISO timestamp
  notes: string | null
  createdAt: string
  _offlineStatus?: OfflineStatus
}

// ---- Site Log (timestamped entries within RentalDailyLog) ----

export type SiteLogEntryType = 'note' | 'h2s'

export interface SiteLogEntry {
  id: string                    // uuid
  time: string                  // "HH:MM" display time
  date?: string                 // YYYY-MM-DD; legacy entries use the log date
  type: SiteLogEntryType
  text: string                  // description / notes
  ppm?: number | null           // H2S PPM value (only when type === 'h2s')
  location?: string             // where reading taken ("wellhead", "cellar", etc.)
  airDeployed?: boolean         // true if air was deployed to crew
  createdAt: string             // ISO timestamp of when entry was added
}

export interface OfflineRentalDailyLog {
  id: string
  rentalAgreementId: string
  logDate: string               // YYYY-MM-DD
  loggedById: string

  // Equipment status
  equipmentPresent: boolean
  equipmentStatus: string       // 'operational' | 'issue_minor' | 'issue_major' | 'needs_service'
  cascadeStatus?: string | null
  bottlesFullCount?: number | null
  bottlesTotalCount?: number | null
  monitorsBumpTested?: boolean | null
  monitorsOperationalCount?: number | null
  monitorsTotalCount?: number | null

  notes?: string | null

  // Site log entries (JSONB array)
  entries: SiteLogEntry[]

  // Offline sync
  offlineId?: string | null
  offlineCreated: boolean
  createdAt: string
  updatedAt: string
  _offlineStatus?: OfflineStatus
}

// ---- Mutation queue (outbox pattern) ----

export interface MutationQueueEntry {
  queueId?: number // auto-incremented
  table: string
  action: 'create' | 'update' | 'delete'
  entityId: string
  offlineId?: string | null
  payload: Record<string, unknown>
  createdAt: string
  status: 'pending' | 'uploading' | 'done' | 'error'
  retryCount: number
  errorMessage?: string | null
}

// ---- Sync metadata ----

export interface SyncMeta {
  table: string // primary key
  lastSyncedAt: string
  lastSyncedCount: number
}
