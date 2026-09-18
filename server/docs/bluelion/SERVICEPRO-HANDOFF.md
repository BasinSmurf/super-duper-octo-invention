# ServicePRO-side build handoff

_Written 2026-07-08, verified against BlueLion source at card-issuance Phase 4
(`2d571c7`). This is the orientation document for building the **ServicePRO
side** of the BlueLion integration — which does not exist yet. BlueLion's side
is fully built and smoke-tested._

**Normative contracts** (copy both into the ServicePRO repo alongside this):

- `SERVICEPRO-INTEGRATION.md` — everything ServicePRO **pushes into** BlueLion
  (trainings, assets, services, documents). Field-by-field.
- `SERVICEPRO-CARD-FLAG.md` — the one thing BlueLion **pushes back**
  (`card.issued`), plus the `attributes` convention that feeds card printing.

This handoff summarizes both, adds the card-designer context that motivates
the `attributes` work, and gives a build order. Where this document and the
two specs disagree, the specs win.

---

## 1. The one-paragraph picture

BlueLion (external brand **VaultPRO**, `vault.basinsafetyus.com`) is Basin
Safety's immutable training/service recordkeeping system. ServicePRO is the
shop's operational system. They are deliberately separable ("bad divorce"):
no shared DB, no shared auth, one HTTPS REST channel on the LAN. ServicePRO
**pushes** completed trainings, new units, service events, and inspection
documents into BlueLion. BlueLion pushes exactly **one** thing back: a
"card issued" flag when a physical wallet card is printed for a training.
Everything is idempotent on stable IDs, so retries and replays are always safe.

```
ServicePRO ──POST──▶ https://bluelion.lan:8443/api/integrations/servicepro/*   (LAN vhost, ingest token)
ServicePRO ◀──POST── card.issued flag → <your receiver URL>                    (LAN, your token)
```

Neither direction goes through Cloudflare. The public internet path serves
only the read-only record viewer.

---

## 2. Why cards change what ServicePRO sends (the card-designer context)

BlueLion now prints CR80 wallet cards on a Magicard 300 Duo. The flow:

1. ServicePRO pushes a completed training (e.g. a fit test) into BlueLion.
2. A BlueLion operator picks the person + training and issues a card. The
   card is rendered from an admin-designed **template**: background art plus
   positioned data fields, each **bound** to a data path.
3. The rendered card is hashed, recorded as an immutable `card.issued` event,
   queued to the printer, and flagged back to ServicePRO.

Templates can bind to two kinds of paths:

- **Standard fields** every training has: `holder_name`, `employer`,
  `cert_name`, `cert_code`, `issued_on`, `expires_on`, `cert_number`,
  `issuer`, `verify_id`, `qr_url`.
- **`attributes.<key>`** — card-type-specific fields (fit factor, respirator
  model, method, student number, …) that exist **only if ServicePRO sends
  them** in the optional `attributes` object on training ingest.

This is the load-bearing point for ServicePRO: **cards print either way.**
If an attribute a template binds is missing, the issuing operator gets a
gap-fill form and types the value by hand at print time. Every attribute
ServicePRO includes on the training is a field nobody re-keys — and the
operator-typed value only lives on that card, while the ingested value lives
on the training record itself. So the goal is: for every class that gets a
card, ServicePRO sends the class's full attribute set.

### Attribute key rules

- Stable `snake_case` keys, identical across all records of the same
  `classCode` — the template binds to the key name and must find it every time.
- Values render as text (numbers are stringified). Dates as `YYYY-MM-DD`.
- Omitted keys fall back to the template's fallback text (or the gap-fill form).
- `student_no` is special by convention: when present, it is preferred as the
  card's printed `verify_id` (falling back to `cert_number`, then the person id).

### Agreed key sets so far

| classCode | attribute keys |
|-----------|----------------|
| `RESP-FIT` (fit test) | `fit_factor`, `respirator_mfg`, `respirator_model`, `respirator_type`, `size`, `method`, `student_no` |

Every other card type's key list is **defined by whoever builds its template**
in BlueLion's designer, and must be shared with ServicePRO before that class's
sync goes live. Keep this table growing as the single source of agreement —
key-name drift between the template and the sync is the failure mode.

---

## 3. What ServicePRO must build

Three deliverables, in build order:

### 3.1 Outbound sync job → four BlueLion endpoints

All on the LAN vhost, all authed with one `ingest` bearer token (issued in
BlueLion via `npm run token -- issue servicepro-prod ingest`; it can do
nothing else). JSON endpoints take `{ "records": [...] }` and return
`202` with per-record results; documents is multipart, one file per request.

| endpoint | pushes | idempotency key |
|----------|--------|-----------------|
| `POST /api/integrations/servicepro/trainings` | completed training rows (+ `attributes`) | `externalId` |
| `POST /api/integrations/servicepro/assets` | new units (kind + serial) | `externalId` |
| `POST /api/integrations/servicepro/services` | service events on a unit | `externalId` |
| `POST /api/integrations/servicepro/documents` | UE reports / condemnation PDFs (can also `retire=true` the unit) | `externalId` |

Essentials (full detail in `SERVICEPRO-INTEGRATION.md`):

- **`externalId`** — ServicePRO's own stable primary key per row (prefix by
  kind: `sp-tr-…`, `sp-asset-…`, `sp-svc-…`, `sp-doc-…`). Re-sends return
  `status: "skipped"` with the original result. Corrections are a **new**
  externalId with fixed values — BlueLion supersedes the old row itself.
- **Person resolution** — send `person.blueLionId` when known (store it the
  first time BlueLion returns it); otherwise name + employer. Handle
  `status: "ambiguous"` by surfacing the returned `candidates` to a human,
  then retrying with `blueLionId` set.
- **`classCode`** must exist in BlueLion's governed cert-type catalog (37
  codes; `GET /api/cert-types` to list). Maintain a
  `servicepro_class_name → classCode` mapping table; surface unmapped names
  to a human rather than guessing.
- **Asset `kind`** is a governed enum: `fire_extinguisher`, `scba`,
  `harness`, `gas_monitor`, `other`. Store the returned `assetId` and use it
  as `unitId` on service/document pushes.
- **PII**: BlueLion persists name + employer only. DOB may be sent for
  disambiguation but is never stored. Don't send SSN/DL/phone/email/address.
- **Retry**: 5xx/network → retry with backoff (idempotency makes it safe).
  400/per-record `invalid` → park for a human. HTTP code ≠ record outcome:
  a `202` batch can still contain `invalid`/`ambiguous` records.

### 3.2 State columns + mapping tables in ServicePRO

- `bluelion_person_id` on person rows, `bluelion_asset_id` on unit rows —
  set from the first successful push, sent on every later one.
- `bluelion_sync_status` (`pending` → `synced` + event seq → `failed` + error)
  per pushed row.
- Mapping tables: class name → `classCode`; unit category → `kind`; and per
  card-type, the attribute key list from §2.

### 3.3 The `card.issued` receiver (the only inbound endpoint)

One HTTPS endpoint on the LAN, at a URL of your choice — BlueLion is pointed
at it via `SERVICEPRO_OUTBOUND_URL` (+ `SERVICEPRO_OUTBOUND_TOKEN`, sent as a
bearer). BlueLion POSTs:

```json
{
  "event": "card.issued",
  "cardId": "card-RnXUvA-OqYsx",
  "personId": "fuerte-juan",
  "certCode": "RESP-FIT",
  "issuedOn": "2026-07-07T19:27:51.902Z",
  "issuedBy": "trainer-mel",
  "templateId": "fit-test-card",
  "templateVersion": 3,
  "frontSha256": "3862bb4cbc03…",
  "backSha256": "f75bf69c6478…",
  "reissueOf": null,
  "verifyUrl": "https://vault.basinsafetyus.com/r/person/fuerte-juan"
}
```

with an `Idempotency-Key` header unique per card. Receiver rules:

- **Dedupe on `Idempotency-Key`** — the same key can arrive more than once;
  seen it before ⇒ return `2xx` without re-applying.
- **Status codes are contract**: `2xx` = done; `4xx` = permanent (BlueLion
  parks the flag and stops retrying — never use for transient problems);
  `5xx`/timeout = transient (BlueLion retries with backoff, up to 20 attempts).
- A **reprint** is a brand-new flag with its own `cardId` and `reissueOf` set
  to the prior card — treat as superseding, not duplicate.
- Minimum useful behavior: stamp `bluelion_card_issued_at` on the matching
  training row so ServicePRO can show "card printed".
- The flag is best-effort by design: the card is already issued and recorded
  in BlueLion before the flag is attempted. A down receiver never blocks
  printing; flags queue and drain when it returns.

---

## 4. Coordination checklist (things that need a human on both sides)

| item | who provides it |
|------|-----------------|
| BlueLion LAN base URL (`https://bluelion.lan:8443` or actual) | BlueLion ops |
| `ingest` bearer token | BlueLion (`npm run token -- issue servicepro-prod ingest`) |
| Receiver URL for the card flag | ServicePRO |
| Receiver bearer token | ServicePRO (BlueLion stores it as `SERVICEPRO_OUTBOUND_TOKEN`) |
| Per-card-type attribute key lists (§2 table) | BlueLion template author ↔ ServicePRO, per class |
| Class-name → `classCode` mapping review | ServicePRO, with BlueLion catalog (`GET /api/cert-types`) |
| New `classCode` / asset `kind` when needed | BlueLion admin (catalog is governed; off-catalog values are rejected) |

## 5. Testing without the other side

- **Sync job**: point at a dev BlueLion (`npm run dev`, bootstrap prints an
  ingest token) and replay a day of records twice — second pass must come back
  all `skipped`.
- **Receiver**: curl it directly with the sample payload above (see
  `SERVICEPRO-CARD-FLAG.md` §6). Return `503` on first call, `200` on the
  identical re-send — proves BlueLion's retry and your dedupe together.
- **BlueLion-side levers** an admin can use during joint testing: force a
  flag drain with `POST /api/cards/push/drain` (`cards:admin`); see per-card
  push status in `GET /api/persons/:id/cards`.

## 6. Known out-of-scope (don't design against these yet)

- No pull/read API for ServicePRO — the flag is push-only. If reconciliation
  is needed, ask BlueLion for a read-scoped token + endpoint.
- No card void/revoke event — a bad card is superseded by a reprint
  (`reissueOf`), never revoked.
- No person-edit ingest — employer is set at person creation; later changes
  don't propagate yet. Known follow-up on the BlueLion side.
- No standalone retire endpoint on the integration namespace — retirement
  rides along with condemnation paperwork (`retire=true` on documents).
