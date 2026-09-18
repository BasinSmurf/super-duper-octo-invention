# BlueLion ↔ ServicePRO integration spec

This is the contract a fresh session can use to build the **ServicePRO side**
of the sync. BlueLion is already built and live; this document describes
what it expects, what it returns, and how identity / idempotency work.

---

## 1. What BlueLion is

BlueLion is an immutable training-and-service recordkeeping system used by
Basin Safety's shop. It tracks two kinds of records:

- **persons** — people who took training classes (name, employer, the
  trainings they hold). Identified by a `personId` slug like `smith-joe`.
- **assets** — units that come through the shop (fire extinguishers, SCBA,
  harnesses, gas monitors, etc.). Identified by an `assetId` like
  `FEX-12345` (usually a sanitized serial).

Both are addressable by QR code; the per-record viewer at `/r/person/:id`
and `/r/asset/:id` is **public** (you scan a badge, you see the record).
Every change is appended to a hash-chained event log — records can be
corrected by appending events, but never silently mutated.

There's a governed catalog of **cert types** (the valid training classes —
H2S, CPR-FA, SAFELAND, FIT-TEST, etc., currently 37). Granting a training
with a class code not in the catalog is rejected. The catalog is maintained
by admins inside BlueLion.

---

## 2. Architectural contract — "bad divorce"

BlueLion and ServicePRO are deliberately separable systems. No shared
database, no shared filesystem, no shared auth identity, no implicit
network trust. Communication is **one-way push from ServicePRO into
BlueLion** over a single HTTPS REST channel.

- **Network path**: ServicePRO posts to BlueLion's **LAN-only** vhost,
  e.g. `https://bluelion.lan:8443/api/integrations/servicepro/*`. The
  public Cloudflare path returns 404 on `/api/integrations/*` —
  ServicePRO never goes through Cloudflare.
- **Auth**: HTTP `Authorization: Bearer <token>`. The token is created in
  BlueLion (`npm run token -- issue servicepro-prod ingest`), has the
  `ingest` role, and is the ONLY thing it can do — it cannot read or
  write anything else. Store the token securely on ServicePRO's side;
  rotatable without redeploying BlueLion.
- **Schema isolation**: ServicePRO's database fields are translated to
  BlueLion's contract at the boundary. Don't send raw ServicePRO row
  shapes — map them to the JSON shape below. A column change on either
  side doesn't break the other.

---

## 3. The endpoints

Three of them are `POST`, take `Content-Type: application/json` with a
`{ records: [...] }` envelope, require the `ingest` bearer token, and
respond `202 Accepted` with a per-record results array on success.

A fourth — **documents** (§3.4) — is different: it carries a binary file, so
it's `multipart/form-data`, **one document per request** (no `records`
envelope). It uses the same `ingest` token.

### 3.1 `POST /api/integrations/servicepro/trainings`

Push completed training records ("Joe Smith finished H2S on 2026-05-19").

**Request body:**

```json
{
  "records": [
    {
      "externalId": "sp-tr-2026-05-19-9001",
      "person": {
        "firstName": "Joe",
        "lastName": "Smith",
        "employer": "Acme Oilfield Services",
        "blueLionId": "smith-joe"
      },
      "classCode": "H2S",
      "issuedOn": "2026-05-19",
      "expiresOn": "2027-05-19",
      "certNumber": "SP-XYZ-001",
      "notes": "in-shop class"
    }
  ]
}
```

Per-record fields:

| field           | required? | what                                                              |
|-----------------|-----------|-------------------------------------------------------------------|
| `externalId`    | yes       | ServicePRO's own stable ID for this row. Idempotency key.         |
| `person`        | yes       | Identity payload — see §4 for resolution rules.                   |
| `classCode`     | yes       | Must exist in BlueLion's cert-type catalog (§5). Else: rejected.  |
| `issuedOn`      | yes       | `YYYY-MM-DD`. The training class date.                            |
| `expiresOn`     | no        | `YYYY-MM-DD`. If omitted, BlueLion computes `issued + catalog.expiry_months` (or no expiry if the type has none). |
| `certNumber`    | no        | Free text.                                                        |
| `notes`         | no        | Free text.                                                        |

**Response body** (`202 Accepted`):

```json
{
  "added": 1, "skipped": 0, "failed": 0,
  "results": [
    {
      "externalId": "sp-tr-2026-05-19-9001",
      "status": "added",
      "personId": "smith-joe",
      "personCreated": false,
      "trainingSeq": 21526
    }
  ]
}
```

Per-result `status`:

| status       | meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `added`      | Training was granted. `personId` is the BlueLion id (store it).         |
| `skipped`    | `externalId` was already ingested. `personId` + `trainingSeq` from the prior call. |
| `ambiguous`  | Multiple existing persons match the name. `candidates: [...]` lists them — see §4. Retry with `person.blueLionId` set. |
| `invalid`    | `error` describes why. The other records in the same batch still process. |

### 3.2 `POST /api/integrations/servicepro/assets`

Register a new unit (or find an existing one).

**Request body:**

```json
{
  "records": [
    {
      "externalId": "sp-asset-2026-05-19-501",
      "kind": "fire_extinguisher",
      "serial": "FEX-44A",
      "label": "Fire Extinguisher 44A",
      "purchasedOn": "2026-05-19"
    }
  ]
}
```

| field         | required? | what                                                                   |
|---------------|-----------|------------------------------------------------------------------------|
| `externalId`  | yes       | ServicePRO's stable ID. Idempotency key.                               |
| `kind`        | yes       | Must be one of: `fire_extinguisher`, `scba`, `harness`, `gas_monitor`, `other` (a governed enum — adding one is a BlueLion code change). Any other value is rejected for that record with `status: "invalid"` — same as an off-catalog `classCode`. Tell us if a new kind is needed. |
| `serial`      | yes       | The unit serial. Combined with `kind`, that's the natural key.         |
| `label`       | no        | Free-text display name. Defaults reasonably from kind + serial.        |
| `purchasedOn` | no        | `YYYY-MM-DD`.                                                          |

**Response:**

```json
{
  "added": 1, "foundExisting": 0, "skipped": 0, "failed": 0,
  "results": [
    {
      "externalId": "sp-asset-2026-05-19-501",
      "status": "added",
      "assetId": "FEX-44A",
      "assetCreated": true
    }
  ]
}
```

Statuses: `added` (new asset created), `found` (kind + serial already
matched an existing asset — its id is returned, no event written),
`skipped` (this externalId was already ingested), `invalid` (validation
failed).

**ServicePRO should store the returned `assetId`** alongside its own unit
record. Subsequent service records (§3.3) use it as `unitId`.

### 3.3 `POST /api/integrations/servicepro/services`

Push a service event against an existing asset (recharge, inspection,
hydrostatic test, retire). This is the original endpoint — pre-existing.

**Request body:**

```json
{
  "records": [
    {
      "externalId": "sp-svc-2026-05-19-7001",
      "unitId": "FEX-44A",
      "servicedOn": "2026-05-19",
      "serviceType": "annual recharge",
      "nextDueOn": "2027-05-19",
      "technician": "M. Bartholomew",
      "notes": "passed inspection",
      "checklistVersion": "a3f81c02",
      "checklist": [
        { "key": "fex_gauge_green", "label": "Pressure gauge needle in operable / green range",
          "required": true, "result": "pass" },
        { "key": "fex_nozzle_clear", "label": "Nozzle and hose clear of obstruction",
          "required": false, "result": "unanswered" }
      ]
    }
  ]
}
```

| field         | required? | what                                                |
|---------------|-----------|-----------------------------------------------------|
| `externalId`  | yes       | Idempotency key.                                    |
| `unitId`      | yes       | BlueLion `assetId` (from §3.2, or seeded otherwise).|
| `servicedOn`  | yes       | `YYYY-MM-DD`.                                       |
| `serviceType` | yes       | Free text (`recharge`, `inspection`, etc.).         |
| `nextDueOn`   | no        | `YYYY-MM-DD`.                                       |
| `technician`  | no        |                                                     |
| `notes`       | no        | **Not capped.** The 500-char limit ServicePRO used to apply was its own. |
| `checklist`   | no        | Structured QA checkpoints — added 2026-08-31 for Div 6 WI-06. |
| `checklistVersion` | no   | Opaque to BlueLion: stored and displayed, never interpreted. Only legal alongside `checklist`. |

**Checklist limits.** A record breaching any of these comes back `invalid`
while its siblings in the batch still process:

| rule | limit |
|------|-------|
| checkpoints per record | 64 |
| `key` | 1–64 chars, `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`, unique within the record |
| `label` | 1–240 chars |
| `result` | exactly `pass` / `fail` / `unanswered` — booleans rejected |
| `required` | a real boolean, not `"true"` |
| `checklistVersion` | ≤ 128 chars, and only alongside a `checklist` |
| whole request body | 1 MB |

`checklist: []` is **rejected, not stored** — omit the field on a service that
had no QA.

Labels are frozen into the record exactly as sent; BlueLion never resolves a key
against a catalog, so a later revision of ServicePRO's criteria set cannot change
what a stored record says was checked. **The outcome is derived, never stored** —
BlueLion computes pass/fail/incomplete from the checkpoints wherever it displays
them, because a stored verdict can end up contradicting the checks it summarises,
and in an immutable record that contradiction is permanent.

The checklist rides on the **public** payload: service type, technician and notes
were already public on that record, and "which checks this unit passed" is what
scanning the QR is for. Gated evidence stays in documents (§3.4). Moving it to
staff-only is a one-line change on BlueLion's side — better decided before the
records exist than after.

**Response:** `{ "added": N, "skipped": N, "failed": N, "results": [...] }` —
per-record results were added 2026-08-31 so a malformed record no longer
discards the healthy ones beside it.

```json
{ "added": 1, "skipped": 0, "failed": 0,
  "results": [ { "externalId": "sp-svc-102", "status": "added",
                 "assetId": "FEX-44A", "eventSeq": 21701 } ] }
```

`added` and `skipped` keep their old meaning, so a caller reading only the counts
is unaffected — and ServicePRO treats `results` as optional for exactly that
reason (`markServiceRowsSynced`). A `unitId` that does not resolve is now a
per-record `invalid`, not a 500 that fails the whole request after earlier
records have committed.

### 3.4 `POST /api/integrations/servicepro/documents`

Attach an inspection document to an asset — a UE report, condemnation
paperwork, a condition photo, a flow test, test paperwork or a vendor invoice
(PDF or image scan). Unlike the JSON endpoints, this is `multipart/form-data`,
**one file per request**.

**The docType vocabulary** is a **closed enum, global to the instance** — not an
open string and not per-tenant. Four types were added 2026-08-31 for Div 6 WI-04:

| `docType` | ServicePRO `AttachmentKind` |
|---|---|
| `ultrasonic_exam` | `ue_report` |
| `condemnation` | — (EquipmentDocument only) |
| `condition_photo` | `photo` |
| `flow_test` | `pozi_report` |
| `test_paperwork` | `test_paperwork` |
| `vendor_invoice` | — **not pushed by ServicePRO** (see below) |

`flow_test` rather than `posi_check`: Posi-Check is one vendor's instrument, and
a record type should not be named after a brand that may not be the one in the
shop in five years.

**ServicePRO does not push `vendor_invoice`,** though BlueLion built the type at
our request (Max, 2026-09-01). The Vault is the unit's condition history, and a
vendor invoice is not condition — it is what Basin paid. The service record
already records that an outside repair happened and what was done to the unit;
the price adds nothing a future reader of the equipment record needs, and would
put Basin's cost data in an external immutable ledger to do it. Vendor invoices
stay ServicePRO records, which is where billing reads them from anyway. The
docType remains available if that judgement ever reverses.

An unknown value is rejected and the response echoes `allowedDocTypes`, so the
vocabulary is discoverable from a 400 rather than only from this document.
Adding a seventh is a small BlueLion change — **ask, do not invent one.**
ServicePRO's `hydrostatic_test` is currently unmapped for exactly this reason.

**Rate:** no ceiling and no daily cap — the endpoint is on the LAN vhost and
writes one file plus one event per call. If parallelising, keep it to a handful
of concurrent uploads: SQLite takes one writer at a time.

Unlike service/training data, these documents are **gated**: the asset
record stays public, but the documents themselves require the `records:read`
permission to read. **All six types store as `internal`** — including
`condition_photo`. Opening a type to a
wider audience later is a visibility change on the row, not a new document type.
Access is (Basin staff via Google SSO today; a customer-facing tier
is planned). The ingest side is unchanged — push with the `ingest` token.

**Request** (`multipart/form-data`):

| part          | required? | what                                                                 |
|---------------|-----------|----------------------------------------------------------------------|
| `file`        | yes       | The document bytes. PDF/JPEG/PNG/WebP, ≤ 25 MB.                       |
| `externalId`  | yes       | ServicePRO's stable ID for this document. Idempotency key.           |
| `docType`     | yes       | One of the six above (governed enum — others rejected, with `allowedDocTypes` echoed).|
| `blueLionId`  | one of    | The asset's BlueLion id (best). …or…                                 |
| `kind`+`serial`| these    | Resolve/create the asset by kind + serial (same rules as §3.2).      |
| `title`       | no        | Free-text label shown in the viewer.                                 |
| `issuedOn`    | no        | `YYYY-MM-DD`. The examination / condemnation date.                   |
| `retire`      | no        | `"true"` to also take the asset out of service in the same call — for condemnation paperwork. No-op if already retired. |
| `reason`      | no        | Retirement reason recorded on the retire event.                      |

**Response** (`202 Accepted` on attach, `200` on a skipped re-send, `400`
invalid, `413` file too large):

```json
{ "status": "added", "externalId": "sp-doc-77", "assetId": "FEX-44A", "docId": "doc_a1b2…", "retired": true }
```

| status    | meaning                                                                 |
|-----------|-------------------------------------------------------------------------|
| `added`   | Document stored. `docId` is BlueLion's id; `retired` true if it also retired the asset. |
| `skipped` | `externalId` already ingested — no duplicate file written.              |
| `invalid` | `error` describes why (unknown `docType`, unsupported file type, unresolvable asset). |

---

## 4. Person resolution (§3.1 helper)

The `person` field on a training record has three useful shapes:

```json
{ "blueLionId": "smith-joe" }                          // best
{ "firstName": "Joe", "lastName": "Smith" }            // first time
{ "firstName": "Joe", "lastName": "Smith",
  "employer": "Acme", "dob": "1985-04-12" }            // create-with-context
```

Resolution rules, in order:

1. **`blueLionId` present** → BlueLion looks it up. If it exists, that's
   the person, end of story. If it doesn't, the record returns `invalid`
   (ServicePRO probably out-of-sync — clear the stale id and retry).

2. **No `blueLionId`, exactly one existing person with the same name** →
   BlueLion uses that person. Returns `personCreated: false`.

3. **No `blueLionId`, multiple existing persons with that name** →
   `status: "ambiguous"`, plus `candidates: [...]` listing the matches
   with their `id`, `full_name`, `employer`, and `last_trained_on` so
   ServicePRO (or a human in ServicePRO) can pick. Retry with
   `person.blueLionId` set.

4. **No match** → BlueLion creates a new person with a deterministic slug
   id (`lastname-firstname`, with a numeric suffix on collision). Returns
   `personCreated: true`, `personId: "the-new-id"`. **Store it.**

**Once ServicePRO has a person's `blueLionId`**, send it on every
subsequent call for that person. That avoids the ambiguity branch entirely
and is the only fully-reliable identifier.

### PII

BlueLion stores **name and employer**. It does **not** store DOB, SSN,
driver's license, phone, email, or address — those are stripped at the
boundary. Even if you send `dob`, it's used in-memory at most and never
persisted. The per-record viewer is public; only name + employer +
trainings + last-trained-date appear there.

(Gated PII storage is a planned feature; until then, treat BlueLion as a
no-PII surface beyond name + employer.)

---

## 5. The class code catalog

`classCode` on a training must exist in BlueLion's cert-type catalog or
the record is rejected (`status: "invalid"`, error
`unknown classCode "X" — not in cert-type catalog`).

ServicePRO can map its internal class names to BlueLion codes locally
(easiest), or query the catalog dynamically:

```http
GET /api/cert-types
Authorization: Bearer <any-authed-token>
```

Returns:

```json
[
  { "code": "H2S",   "name": "H2S Clear / Awareness",     "expiry_months": 12, "issuing_authority": "ISN" },
  { "code": "CPR-FA","name": "CPR / First Aid / AED",     "expiry_months": 24, "issuing_authority": null },
  { "code": "SAFELAND","name": "PEC Basic / SafeLand",    "expiry_months": null, "issuing_authority": "PEC" }
]
```

Recommended pattern: ServicePRO maintains a small mapping table
`servicepro_class_name → bluelion_classCode`. If a class name has no
mapping, the sync surfaces it for a human to either map (or have an admin
add a new code to the catalog inside BlueLion's UI).

---

## 6. Idempotency

Every endpoint dedups on `externalId`. The mapping `(kind, externalId) →
event_seq` is stored in BlueLion's `servicepro_refs` table; a re-send
returns `status: "skipped"` with the original `personId`/`assetId`/
`trainingSeq`.

ServicePRO can therefore safely retry on network failure, batch the same
record set multiple times, or replay a day's worth on demand. Pick stable
`externalId` values — typically ServicePRO's own primary key for the
underlying row, optionally prefixed with the record kind
(`sp-tr-…`, `sp-asset-…`, `sp-svc-…`) for human inspection.

If you need to *correct* a record (e.g. wrong issue date), send a *new*
externalId with the corrected values. BlueLion's events are append-only —
the previous training is superseded automatically (within a code, the
older training row is marked superseded by the newer for the same person).

---

## 7. Errors and retry

| HTTP   | meaning                                                                 |
|--------|-------------------------------------------------------------------------|
| `202`  | Accepted — check the per-record `results` array for individual outcomes.|
| `400`  | The batch itself is malformed (missing `records`, missing required field on a record). Fix and retry. |
| `401`  | Missing / invalid bearer token.                                         |
| `403`  | Token exists but lacks the `ingest` role.                               |
| `5xx`  | BlueLion error. Retry with backoff. Idempotency means re-sends are safe.|

Within a `202` batch, individual records can have `status: invalid` or
`status: ambiguous` while siblings succeed — ServicePRO should treat the
per-record statuses as the source of truth, not just the HTTP code.

---

## 8. What ServicePRO needs to build

A practical checklist for the ServicePRO side. None of this is BlueLion-
specific; it's standard "sync to an external system" structure.

1. **Config** (env-driven):
   - `BLUELION_URL` — base URL, e.g. `https://bluelion.lan:8443`.
   - `BLUELION_TOKEN` — the bearer token.
   - `BLUELION_TIMEOUT_MS` — sensible default 10s.

2. **Mapping table** in ServicePRO:
   - `servicepro_class_name → bluelion_classCode`.
   - `kind`: ServicePRO's unit category → BlueLion's `kind` value.
   - Probably loaded from a small config or a DB table you can edit.

3. **State storage** in ServicePRO — three nullable columns on the
   relevant rows:
   - `bluelion_person_id` on each person row (set the first time
     BlueLion creates / finds them, used on every subsequent push).
   - `bluelion_asset_id` on each unit row (same pattern).
   - `bluelion_sync_status` per training/service/asset row: `pending` →
     `synced` (with `bluelion_event_seq`) → `failed` (with the error).

4. **The sync job** — three flavors of work, run on a trigger or schedule:

   a. **New unit** (someone registers a new unit on the shop floor):
      `POST /assets` with the unit's `kind` + `serial` + optional label.
      Store the returned `assetId` on the ServicePRO unit row.

   b. **Service performed**: `POST /services` with the unit's stored
      `bluelion_asset_id` as `unitId`. (If the unit doesn't yet have one,
      do (a) first.)

   c. **Training class completed** (roster row): for each attendee,
      `POST /trainings`. If you have their `bluelion_person_id`, send it
      as `person.blueLionId`. Otherwise send `firstName`/`lastName`/
      `employer`. Handle the `ambiguous` case by surfacing the candidates
      to a human in ServicePRO who picks one, then retry with
      `blueLionId` set.

5. **Error handling**:
   - Retry on 5xx and network errors (with backoff). Idempotency makes
     this safe.
   - On `400`, log and surface — the row stays `pending` until a human
     fixes the data.
   - On a per-record `invalid` (`unknown classCode`, etc.), log + surface
     for human attention.
   - On `ambiguous`, surface in a UI / queue — block that one row only,
     proceed with the rest.

6. **Boundary cleanliness**: don't send raw ServicePRO row shapes. Build
   the request JSON from the field set above. A schema change on
   ServicePRO doesn't break BlueLion if your translator absorbs it.

---

## 9. Examples (cURL)

```bash
TOKEN="bl_xxxxxxxxxxxxxxxxxxxxxxxx"
BASE="https://bluelion.lan:8443"

# Register a new fire extinguisher
curl -X POST "$BASE/api/integrations/servicepro/assets" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"records":[{
        "externalId":"sp-asset-501",
        "kind":"fire_extinguisher",
        "serial":"FEX-44A",
        "label":"Extinguisher 44A"
      }]}'

# Push a training class
curl -X POST "$BASE/api/integrations/servicepro/trainings" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"records":[{
        "externalId":"sp-tr-9001",
        "person":{"firstName":"Joe","lastName":"Smith","employer":"Acme"},
        "classCode":"H2S",
        "issuedOn":"2026-05-19"
      }]}'

# Log a service on an asset
curl -X POST "$BASE/api/integrations/servicepro/services" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"records":[{
        "externalId":"sp-svc-101",
        "unitId":"FEX-44A",
        "servicedOn":"2026-05-19",
        "serviceType":"annual recharge",
        "nextDueOn":"2027-05-19"
      }]}'

# Discover the catalog
curl "$BASE/api/cert-types" -H "Authorization: Bearer $TOKEN"

# Attach a UE (ultrasonic-examination) report to an asset
curl -X POST "$BASE/api/integrations/servicepro/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@ue-report-44A.pdf;type=application/pdf" \
  -F "externalId=sp-doc-77" \
  -F "docType=ultrasonic_exam" \
  -F "blueLionId=FEX-44A" \
  -F "issuedOn=2026-06-18" \
  -F "title=Annual UT — shell thickness"

# Attach condemnation paperwork AND retire the unit in one call
curl -X POST "$BASE/api/integrations/servicepro/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@condemn-44A.pdf;type=application/pdf" \
  -F "externalId=sp-doc-78" \
  -F "docType=condemnation" \
  -F "blueLionId=FEX-44A" \
  -F "retire=true" \
  -F "reason=Failed UT — wall loss beyond limit"
```

---

## 10. Out of scope (BlueLion-side, for now)

- **Pull / fetch from BlueLion to ServicePRO**: BlueLion does not call
  out. If ServicePRO needs BlueLion data, it queries `GET` endpoints
  with a token (the same `ingest` token currently has only ingest
  rights; a separate read-only token can be issued if needed).
- **Asset retire / reinstate**: BlueLion has `POST /api/assets/:id/retire`
  and `POST /api/assets/:id/reinstate` (admin/UI scope, `assets:write`).
  Standalone retirement is still not on the integration namespace, but
  ServicePRO *can* now retire a unit as a side effect of pushing
  condemnation paperwork (§3.4, `retire=true`). Reinstate remains UI-only.
- **Person edits** (employer change, name correction): not yet exposed.
  Today, employer is set on first creation. If a person changes
  employers later, the next training with a different `employer` field
  won't update the stored value — that's a known follow-up.
- **DOB / PII storage**: deferred. ServicePRO can send `dob` for
  documentation but BlueLion ignores it for storage.
