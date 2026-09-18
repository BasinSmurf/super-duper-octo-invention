# BlueLion API requests — Division 6 batch

**Direction:** ServicePRO → BlueLion. Like `BLUELION-ASSET-MODEL.md`, this is
written from the SP side; the `SERVICEPRO-*.md` files are BlueLion's contracts
to us.

**Status: ANSWERED AND CLOSED — 2026-08-31. Both requests accepted and built.**
BlueLion took Option A on request 1 (a real structured `checklist` field, not an
opaque `metadata` blob) and added four docTypes on request 2. The normative
detail now lives in `SERVICEPRO-INTEGRATION.md` §3.3 and §3.4 — **read those, not
this file**, which is kept only as the record of what was asked and why.

The ServicePRO side is implemented: `services/blueLionChecklist.ts` maps the
write-once QA snapshot onto the new field, `services/equipmentDocuments.ts`
carries the four new docTypes, and `POST /api/bluelion/documents/backfill`
drains the categories that were being held.

**Three things the answer changed that are worth carrying forward:**

1. **The 500-character `notes` cap was ours, not BlueLion's.** They have never
   capped `notes`. The constraint this document was written to work around was
   self-imposed. Outbound service notes now go out at 2000.
2. **`flow_test`, not `posi_check`.** A record type outlives the brand of the
   instrument; `pozi_report` maps onto `flow_test`.
3. **The checklist is on the PUBLIC payload.** Service type, technician and
   notes already were. If Basin wants QA results staff-only, that is a one-line
   move on BlueLion's side and is **much cheaper to decide before the records
   exist than after** — immutability cuts both ways.

**One of the four new docTypes is deliberately unused.** `vendor_invoice` was
asked for and built, and then Basin decided the Vault does not need it (Max,
2026-09-01): the Vault is the unit's condition history, and what Basin paid an
outside vendor is not condition. The service record already says the repair
happened. Vendor invoices stay ServicePRO records. The type is there if that
ever reverses.

**Still unresolved, and deliberately not guessed at:** `hydrostatic_test` has no
BlueLion docType. It is neither a flow test nor paperwork, so it stays unmapped
rather than being filed under a plausible-sounding neighbour. That is a seventh
docType to ask for if hydros need to reach the Vault.

**On the backlog:** service records already pushed under the old contract stay
thin — that part is unrecoverable, as anticipated below. The four *document*
categories are not: those were absent, not superseded, and the backfill route
sends them under the correct types.

---

## Original request (2026-08-31, as sent)

**Status:** two requests for changes on the BlueLion side. Neither can be
resolved by ServicePRO, and both are currently worked around in ways that lose
information at the boundary.

**Why now, and why request 1 is time-sensitive:** the Division 6 batch shipped
batch QA (PR #138) and per-unit evidence capture (PR #134) to production in
August 2026. Both are producing records today. Vault records are immutable by
design, so **anything pushed under the current contract cannot be enriched
later** — it can only be superseded by a second record that contradicts the
first. Every week that passes adds rows that will always be thinner than they
should have been.

---

## Request 1 — `/services` has nowhere to put a checklist

### What ServicePRO now has

A shop QA is a structured artifact: a category-specific list of checkpoints,
each with a stable key, a human-readable label, a required/optional flag, and a
pass/fail/unanswered result — plus who ran it, when, against which revision of
the criteria, and whether it was part of a batch.

ServicePRO stores that as a self-contained snapshot per unit
(`shop_qa_unit_results.vault_snapshot`), frozen write-once at the database when
the unit's 48-hour correction window closes. Roughly:

```json
{
  "snapshotVersion": 1,
  "category": "fire_extinguisher",
  "checklistVersion": "fire_extinguisher-ff1f72b2",
  "outcome": "pass",
  "checkpoints": [
    { "key": "fex_gauge_green",
      "label": "Pressure gauge needle in operable / green range",
      "required": true, "result": true },
    { "key": "fex_service_tag",
      "label": "Service tag applied — date + inspector initials",
      "required": true, "result": true }
  ],
  "failedKeys": [], "failedLabels": [],
  "serviceActions": ["annual"],
  "performedBy": "Dana", "performedAt": "2026-08-31T14:00:00.000Z",
  "batchSize": 4,
  "serialNumber": "FE-1001", "customer": "Acme", "workOrderNumber": "SWO-1"
}
```

### What the contract accepts

`BlueLionServiceRecord` (per `SERVICEPRO-INTEGRATION.md`, and as implemented in
`server/src/services/blueLionClient.ts`):

```ts
{ externalId, unitId, servicedOn, serviceType, nextDueOn?, technician?, notes? }
```

Free text only, and `notes` is capped at 500 characters.

### What we do today

We summarise, and say so:

```
Batch QA PASS (7/7 required checks) — checklist fire_extinguisher-ff1f72b2 — batch of 4
```

That is honest but lossy. The immutable ledger records **that** a QA passed and
**how many** checks it covered; it cannot say **which** checks, what they were,
or which one failed on a unit that did not pass. An auditor reading a Vault
record three years from now has a number and a hash, and the hash resolves
against a ServicePRO catalog that may have been revised since.

Note this is not solved by making `notes` longer. A 4000-character notes field
would hold the text and still not be queryable, comparable across units, or
safe to parse.

### What we are asking for

Either would work; the first is cleaner.

**Option A — a structured field.** Add an optional `checklist` array to the
service record:

```ts
checklist?: Array<{
  key: string;         // stable identifier, e.g. "fex_gauge_green"
  label: string;       // human text as shown to the tech at the time
  required: boolean;
  result: 'pass' | 'fail' | 'unanswered';
}>;
checklistVersion?: string;   // opaque to BlueLion; identifies the criteria set
```

**Option B — an opaque JSON blob.** Add `metadata?: object`, stored verbatim and
returned verbatim. Less useful to BlueLion's own UI, but it fully solves the
loss problem and costs BlueLion nothing but a column.

Either way, SP already has the data assembled at push time. This is a receive-side
change only.

### Questions for BlueLion

1. Can `/api/integrations/servicepro/services` accept one of the above?
2. If yes, is there a size ceiling we should design to? A worst-case checklist is
   ~30 checkpoints; labels run to ~90 characters.
3. Is there any appetite for surfacing the checklist in the public per-unit
   viewer, or is this purely a stored-record concern?

---

## Request 2 — no docType vocabulary for the documents we hold

### What ServicePRO now has

Per-unit evidence, captured on an iPad at the bench and attached to the unit's
serial rather than to a ticket. Five kinds matter for Vault:

| SP `AttachmentKind` | What it is | Typical format |
|---|---|---|
| `ue_report` | Ultrasonic examination report | PDF |
| `photo` | Unit condition photograph (damage, corrosion, a failed check) | JPEG |
| `pozi_report` | Posi-Check / flow test output | PDF |
| `vendor_invoice` | Outside vendor's invoice for work performed on the unit | PDF |
| `test_paperwork` | Bench test output that is not a Posi-Check (flow, hydro, calibration) | PDF |

### What the contract accepts

`BlueLionDocumentUpload.docType` is a closed set of two:

```ts
docType: 'ultrasonic_exam' | 'condemnation'
```

### What we do today

`server/src/services/equipmentDocuments.ts` maps **only** `ue_report →
ultrasonic_exam`. The other four are captured, stored and served by ServicePRO
but **deliberately not pushed** — we would rather hold them than file them under
a docType that does not describe them. Mislabelled evidence in an immutable
ledger is worse than absent evidence, because it looks like a record.

### What we are asking for

Confirmed docType strings for at least:

- `condition_photo` (or whatever BlueLion prefers) — the highest-volume one, and
  the one most likely to matter in a dispute
- `flow_test` / `posi_check`
- `vendor_invoice`
- `test_paperwork` — other bench test output; lower volume, same argument

Any names work; we need them to be **stable and documented**, since the map is
one line each on our side once they exist.

### Questions for BlueLion

1. What is the intended vocabulary? Is `docType` an open string, a closed enum,
   or configurable per tenant?
2. Is there a per-document size limit, and is there a rate ceiling? Photo volume
   is the one that will grow — assume single-digit MB per file after
   compression, and potentially dozens per work order.
3. Do documents of different types render differently in the unit viewer, or is
   docType purely metadata?

---

## What ServicePRO will do once these land

Both are small on our side, which is the point of raising them now rather than
building around them:

- **Request 1:** populate the new field from `vault_snapshot`, which is already
  assembled and frozen at push time. One change in
  `services/blueLionQueueProcessor.ts` (`buildServiceRecord`).
- **Request 2:** extend `blueLionDocTypeForAttachmentKind` in
  `services/equipmentDocuments.ts` — one line per docType — and the existing
  attachment queue starts draining them without further work. The push path,
  retry handling and queue UI already exist (PR #133/#134).

Neither requires a migration or a change to what ServicePRO captures.

## What is NOT being asked

To be explicit, so this does not read as a larger ask than it is:

- No change to authentication, transport, or the queue/retry contract.
- No change to `/trainings` or `/assets`.
- No request for BlueLion to push anything back to ServicePRO. The one
  BlueLion→SP flow (`SERVICEPRO-CARD-FLAG.md`) is unaffected.
- No backfill request. Records already pushed under the current contract stay as
  they are; we are asking about records not yet written.

---

## Contact

Raised from the ServicePRO side out of the 2026-08-28 Division 6 change batch.
Related SP-side work, all shipped: PR #133 (attachment pipeline), #134
(per-unit evidence), #138 (batch QA), #141 (vendor receive).
