# ServicePRO v1 — DTO ↔ Prisma mapping

Companion to `servicepro-v1.yaml`. This is the implementation key: for every
v1 DTO field, where it comes from in the Prisma model, and any transform
applied at the boundary. Wiring a v1 route handler should be "read this table
and map," not redesign.

**Principles**
- v1 DTOs are **curated** — they expose a deliberate subset. Anything not
  listed here is intentionally withheld (internal QB/Enverus plumbing,
  signature image blobs, `customData`, audit fields, etc.).
- Money columns are Prisma `Decimal` → serialize as JSON **number**.
- `@db.Date` columns → `YYYY-MM-DD` strings. `DateTime` → RFC 3339 UTC.
- `ETag` / `Last-Modified` derive from the row's `updatedAt`.
- Pagination: `cursor` is an opaque encoding of `(updatedAt,id)`; list order is
  `updatedAt DESC, id DESC`. `updatedSince` filters `updatedAt >=`.

Legend: **source** = Prisma path from the resource root. `—` = computed/constant.

---

## Shared mini-DTOs

### CompanyRef
| DTO | source |
|-----|--------|
| `id` | `Company.id` |
| `name` | `Company.name` |

### UserRef
| DTO | source |
|-----|--------|
| `id` | `User.id` |
| `name` | `User.name` |

### LineItem  (⚠ dual-source — column names differ by parent)
| DTO | from `TicketLineItem` | from `InvoiceLineItem` |
|-----|-----------------------|------------------------|
| `id` | `id` | `id` |
| `description` | `description` | `description` |
| `partNumber` | `partNumber` | `partNumber` |
| `quantity` | `quantity` | `quantity` |
| `unitPrice` | **`rate`** | **`rate`** |
| `total` | **`total`** | **`amount`** |
| `sortOrder` | `sortOrder` | `sortOrder` |

> Note: neither model has a column literally named `unitPrice`. The DTO
> normalizes `rate → unitPrice`. Ticket lines carry `total`; invoice lines
> carry `amount` (`quantity * rate` or override). Map accordingly.

### SignatureSummary  (from the `SignatureRequest` relation)
| DTO | source |
|-----|--------|
| `status` | `SignatureRequest.status` |
| `sentToEmail` | `SignatureRequest.sentToEmail` |
| `sentToName` | `SignatureRequest.sentToName` |
| `sendCount` | `SignatureRequest.sendCount` |
| `firstSentAt` | `SignatureRequest.firstSentAt` |
| `lastSentAt` | `SignatureRequest.lastSentAt` |

### LocationSummary  (flattens the field/pad/well graph)
| DTO | source | notes |
|-----|--------|-------|
| `display` | `ServiceTicket.locationDisplay` | fallback: join `field.name → pad.name → well.wellName`; else "Unknown" |
| `fieldName` | `field.name` ?? `ServiceTicket.fieldAreaName` | |
| `padName` | `pad.name` | |
| `wellName` | `well.wellName` | |
| `apiNumber` | `well.apiNumber` | |

---

## Ticket  (`ServiceTicket`)

### TicketSummary
| DTO | source |
|-----|--------|
| `id` | `id` |
| `ticketNumber` | `ticketNumber` |
| `ticketType` | `ticketType` |
| `serviceSubtype` | `serviceSubtype` |
| `status` | `status` |
| `serviceDate` | `serviceDate` |
| `company` | `company` → CompanyRef |
| `location` | (self) → LocationSummary |
| `assignedTech` | `assignedTech` → UserRef |
| `updatedAt` | `updatedAt` |

### TicketDetail (adds)
| DTO | source | notes |
|-----|--------|-------|
| `createdAt` | `createdAt` | |
| `createdBy` | `createdBy` → UserRef | |
| `customerContact.name/email/phone` | `customerContact.*` | |
| `lineItems[]` | `lineItems` (ordered `sortOrder asc`) → LineItem | |
| `attachments[].id/filename/uploadedAt` | `attachments.{id,fileName,uploadedAt}` | |
| `attachments[].url` | — | built: authenticated `/api/files/...` link from `TicketAttachment.filePath` |
| `signature` | `signatureRequest` → SignatureSummary | |
| `availableTransitions` | — | `getAvailableTransitions(status, role)` (state machine) |
| `recordCounts.fitTest` | `fitTestRecords.length` | |
| `recordCounts.airSystemInspection` | `airSystemInspections.length` | |
| `recordCounts.ihTest` | `ihTestRecords.length` | |
| `recordCounts.trainingRoster` | `trainingRosterRecords.length` | |

**Withheld:** full specialized records (fit-test/IH/air-system/roster rows),
`customData`, Enverus per-line fields, billing profile internals.

---

## Invoice  (`Invoice`)

### InvoiceSummary
| DTO | source | notes |
|-----|--------|-------|
| `id` | `id` | |
| `invoiceNumber` | `invoiceNumber` | |
| `status` | `status` | |
| `company` | `{id: companyId, name: companyName}` | `companyName` is a denormalized snapshot on the invoice |
| `invoiceDate` | `invoiceDate` | |
| `total` | `total` | |
| `updatedAt` | `updatedAt` | |

### InvoiceDetail (adds)
| DTO | source | notes |
|-----|--------|-------|
| `createdAt` | `createdAt` | |
| `subtotal` | `subtotal` | |
| `tax` | **`taxAmount`** | |
| `locationSummary.locations[]` | derived | from `billingGroup.tickets` or source-ticket lookup via `lineItems[].sourceTicketId` (same logic as legacy `GET /invoices/:id`) |
| `lineItems[]` | `lineItems` (ordered `sortOrder asc`) → LineItem | |
| `signature` | `signatureRequest` → SignatureSummary | |
| `delivery.enverusStatus` | `enverusStatus` | |
| `delivery.qbStatus` | — | derive: `qbInvoiceNumber` → "invoiced"; else `qbSalesOrderNumber` → "so_created"; else null |
| `delivery.qbDiffDetected` | — | `qbDiffDetectedAt != null` |
| `pdfUrl` | — | constant link to `GET /api/v1/invoices/{id}/pdf` |

**Withheld:** `internalNotes`, all raw QB txn ids, `qbCustomerOverride`,
`qbSkip` lines flagging, approval/rejection internals, `customData`.

---

## Equipment  (`SerializedEquipment`)

### EquipmentSummary
| DTO | source |
|-----|--------|
| `id` | `id` |
| `serialNumber` | `serialNumber` |
| `product` | `product.{id,partNumber,name,category}` → ProductRef |
| `ownership` | `ownership` |
| `status` | `status` |
| `calibrationDueDate` | `calibrationDueDate` |
| `bumpTestDueDate` | `bumpTestDueDate` |
| `updatedAt` | `updatedAt` |

### EquipmentDetail (adds)
| DTO | source | notes |
|-----|--------|-------|
| `createdAt` | `createdAt` | |
| `lastCalibrationDate` | `lastCalibrationDate` | |
| `purchaseDate` | `purchaseDate` | |
| `warrantyExpiry` | `warrantyExpiry` | |
| `safeCoreSerial` | `safeCoreSerial` | |
| `conditionNotes` | `conditionNotes` | |
| `parentEquipmentId` | `parentEquipmentId` | |
| `currentLocation.pad` | `currentPad.{id,name}` | nullable |
| `currentLocation.well` | `currentWell.{id,wellName,apiNumber}` | nullable |
| `currentLocation.facility` | `currentFacility.{id,name}` | nullable |
| `currentLocation.customer` | `currentCustomer` → CompanyRef | nullable |
| `currentLocation.rentalId` | `currentRentalId` | |
| `latestInspection` | `equipmentInspections` ordered `inspectedAt desc` take 1 → EquipmentInspectionSummary | nullable |

**Withheld:** `customData`, child-equipment graph, line-item install/remove
history.

### Filter mapping (`GET /equipment`)
`status`→`status`, `ownership`→`ownership`, `productCategory`→`product.category`,
`serialNumber`→`serialNumber` (exact), `companyId`→`currentCustomerId`.

---

## EquipmentInspection  (`EquipmentInspection`)

### EquipmentInspectionSummary
| DTO | source | notes |
|-----|--------|-------|
| `id` | `id` | |
| `serialNumber` | `serialNumber` | snapshotted on the row (survives reassign/rename) |
| `serializedEquipmentId` | `serializedEquipmentId` | nullable |
| `category` | `category` | |
| `outcome` | `outcome` | |
| `serviceActions` | `serviceActions` (JSONB array) | |
| `inspectedBy` | `inspectedBy` → UserRef | nullable |
| `inspectedAt` | `inspectedAt` | |
| `lockedAt` | `lockedAt` | when set, row is immutable |
| `source.type` | — | `ticketId != null` → "ticket"; `shopItemId != null` → "shop_item" |
| `source.ticketId` | `ticketId` | |
| `source.shopItemId` | `shopItemId` | |

### EquipmentInspectionDetail (adds)
| DTO | source | notes |
|-----|--------|-------|
| `data` | `data` (JSONB) | category-specific; passed through opaque |
| `partsReplaced` | `partsReplaced` | |
| `notes` | `notes` | |
| `customerApproval.name` | `customerApprovedName` | |
| `customerApproval.at` | `customerApprovedAt` | |
| `correctsId` | `correctsId` | |
| `createdAt` | `createdAt` | |
| `updatedAt` | `updatedAt` | |

**Withheld:** `customerApprovedSignature` (base64 image blob — never exposed in
v1).

---

## BlueLionSync  (`BlueLionSyncQueue`)

### BlueLionQueueEntry
| DTO | source |
|-----|--------|
| `id` | `id` |
| `entityType` | `entityType` |
| `entityId` | `entityId` |
| `externalId` | `externalId` |
| `status` | `status` |
| `resultStatus` | `resultStatus` |
| `candidates` | `candidates` (JSONB) |
| `errorMessage` | `errorMessage` |
| `retryCount` | `retryCount` |
| `createdAt` | `createdAt` |

> The management endpoints wrap the existing logic in `routes/blueLion.ts` /
> `services/blueLionEnqueue.ts`. The **outbound push** to BlueLion is a client
> concern (see `x-integrations` in the spec + `SERVICEPRO-INTEGRATION.md`),
> not part of this server's exposed surface.

---

## Rental  (`RentalAgreement`)

### RentalSummary
| DTO | source |
|-----|--------|
| `id` | `id` |
| `agreementNumber` | `agreementNumber` |
| `status` | `status` |
| `company` | `company` → CompanyRef |
| `startDate` | `startDate` |
| `endDate` | `endDate` |
| `billingRateType` | `billingRateType` |
| `pickupType` | `pickupType` |
| `location` | `{field,pad,well,facility}` → LocationSummary | `display` built from `field.name → pad.name → well.wellName` (no `locationDisplay` column on rentals) |
| `updatedAt` | `updatedAt` |

### RentalDetail (adds)
| DTO | source | notes |
|-----|--------|-------|
| `createdAt` | `createdAt` | |
| `poNumber` / `afeNumber` | `poNumber` / `afeNumber` | |
| `isManned` / `isRigJob` / `monitorsIncluded` | same | |
| `siteContact.{name,phone,email}` | `siteContact{Name,Phone,Email}` | PII — see open items |
| `items[]` | `items` → RentalItem | |
| `dailyLogCount` | `dailyLogs.length` (count) | |
| `lastLoggedOn` | `max(dailyLogs.logDate)` | |

**Withheld:** `liabilitySignature` (blob) + waiver internals, `personCalling*`
(internal caller PII), `notes`/internal fields, `createdById`.

### RentalItem  (`RentalAgreementItem`)
| DTO | source |
|-----|--------|
| `id` | `id` |
| `product` | `product` → ProductRef |
| `serialNumber` | `serializedEquipment.serialNumber` |
| `rate` | `rate` |
| `rateType` | `rateType` |
| `deployedDate` | `deployedDate` |
| `returnedDate` | `returnedDate` |
| `status` | `status` |

### RentalDailyLog  (`RentalDailyLog`)
| DTO | source | notes |
|-----|--------|-------|
| `id` | `id` | |
| `logDate` | `logDate` | |
| `loggedBy` | `loggedBy` → UserRef | |
| `equipmentPresent` | `equipmentPresent` | |
| `equipmentStatus` | `equipmentStatus` | |
| `cascadeStatus` | `cascadeStatus` | |
| `bottlesFullCount` / `bottlesTotalCount` | same | |
| `monitorsBumpTested` | `monitorsBumpTested` | |
| `monitorsOperationalCount` / `monitorsTotalCount` | same | |
| `notes` | `notes` | |
| `entries` | `entries` (JSONB) | opaque pass-through (timestamped H2S readings) |

**Withheld:** `offlineId` / `offlineCreated` (sync internals).

---

## Locations

### Field  (`Field`) — single schema, list + detail
| DTO | source |
|-----|--------|
| `id` `name` `county` `state` `notes` `isActive` `createdAt` `updatedAt` | same-named columns |

### Pad  (`Pad`)
**PadSummary**: `id`, `name`, `field`→FieldRef, `county`, `currentOperator`→CompanyRef,
`tier1`, `latitude`, `longitude` (Decimal→number), `isActive`, `updatedAt`.
**PadDetail (adds)**: `section`, `township`, `range`, `directions`, `accessNotes`,
`manuallyVerified`, `pendingReview`, `createdAt`.
**Withheld:** `autoGenerated`, `customData`, `currentOperatorId` raw (exposed via ref).
Filter: `fieldId`→`fieldId`, `operatorId`→`currentOperatorId`.

### Well  (`Well`)
**WellSummary**: `id`, `wellName`, `apiNumber`, `field`→FieldRef, `pad`→PadRef (nullable),
`currentOperator`→CompanyRef, `wellType`, `wellStatus`, `county`, `updatedAt`.
**WellDetail (adds)**: `apiShort`, `dmrFileNumber`, `totalDepth`, `spudDate`, legal
location (`section`/`township`/`range`/`quarterQuarter`/`feetNs`/`nsLine`/`feetEw`/`ewLine`),
`latitude`, `longitude`, `hasSuppliedAir`, `hasAreaMonitors`, `isHighRisk`, `riskNotes`,
`isActiveForService`, `serviceNotes`, `createdAt`.
**Withheld:** `dmrRawData`, `dmrReferenceId`, `customData`, `pendingReview`.
Filter: `fieldId`, `padId`, `operatorId`→`currentOperatorId`, `apiNumber` (exact).

### Facility  (`Facility`)
**FacilitySummary**: `id`, `name`, `facilityType`, `field`→FieldRef (nullable),
`pad`→PadRef (nullable), `currentOperator`→CompanyRef, `county`, `isActive`, `updatedAt`.
**FacilityDetail (adds)**: `latitude`, `longitude`, `section`, `township`, `range`,
`directions`, `accessNotes`, `hasSuppliedAir`, `hasAreaMonitors`, `serviceNotes`, `createdAt`.
**Withheld:** `customData`, `pendingReview`.

---

## Company  (`Company`)

### CompanySummary
| DTO | source |
|-----|--------|
| `id` `name` `legalName` `companyType` `city` `state` `isActive` `updatedAt` | same-named columns |

### CompanyDetail (adds)
| DTO | source |
|-----|--------|
| `parentCompanyId` `address` `zip` `phone` `email` `website` `paymentTerms` `createdAt` | same-named columns |

**Withheld:** all QB fields (`qbCustomerListId`, `qbPriceLevelId`, …), Enverus
billing profiles, per-customer field labels, `dueDateOffset`, `customData`.
`companyType` is the `CompanyType` enum (exposed as string).
Filter: `isActive`→`isActive`, `companyType`→`companyType`.

---

## Training  (`ServiceTicket` where `ticketType = training`)

### TrainingClassSummary
| DTO | source | notes |
|-----|--------|-------|
| `id` | `id` | the training ticket id |
| `ticketNumber` | `ticketNumber` | |
| `courseName` | `trainingRosterRecords[0].courseName` ?? `workDescription` | course is denormalized on roster rows |
| `status` | `status` | |
| `serviceDate` | `serviceDate` | |
| `company` | `company` → CompanyRef | |
| `attendeeCount` | `trainingRosterRecords.length` | |
| `updatedAt` | `updatedAt` | |

List filter: hard-scope `ticketType = 'training'`; `companyId`, `status`,
`course`→`trainingRosterRecords.some.courseName contains`.

### TrainingClassDetail (adds)
| DTO | source |
|-----|--------|
| `createdAt` | `createdAt` |
| `location` | `{field,pad,well,facility}` + `locationDisplay` → LocationSummary |
| `instructor` | `assignedTech` → UserRef |
| `attendees[]` | `trainingRosterRecords` → TrainingAttendee |

### TrainingAttendee  (`TrainingRosterRecord`)
| DTO | source |
|-----|--------|
| `id` | `id` |
| `employeeName` | `employeeName` |
| `employerName` | `employerName` |
| `employerCompanyId` | `employerCompanyId` |
| `courseName` | `courseName` |
| `passed` | `passed` |
| `cardNumber` | `cardNumber` |
| `cardExpiryDate` | `cardExpiryDate` |
| `cardIssuedOnSite` | `cardIssuedOnSite` |
| `cardIssuedOfficial` | `cardIssuedOfficial` |
| `trainedAt` | `trainedAt` |
| `blueLion.personId` | `blueLionPersonId` |
| `blueLion.trainingSeq` | `blueLionTrainingSeq` |
| `blueLion.syncedAt` | `blueLionSyncedAt` |

**Withheld:** `contactEmail` / `contactPhone` (attendee PII for card
redistribution — see open items), `employeeId`, `notes`.

---

## Open items for implementation

- **`attachments[].url`** — decide the authenticated-download URL scheme for v1
  (reuse `/api/files` or mint v1-scoped, possibly signed, links).
- **`delivery.qbStatus`** — no single status column exists; derive from the QB
  txn-id fields as noted, or add an explicit computed status if consumers need
  finer granularity.
- **Cursor encoding** — settle the opaque cursor format once (base64 of
  `updatedAt|id`) and share it across all list endpoints.
- **Contact PII** — `RentalDetail.siteContact` exposes phone/email of the
  on-site contact. Decide per-scope whether bolt-on keys see contact PII at
  all, or only `name`. `personCalling*` is already withheld; `siteContact` is
  the open call.
