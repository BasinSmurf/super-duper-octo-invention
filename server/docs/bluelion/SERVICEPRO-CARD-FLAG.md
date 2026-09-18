# BlueLion → ServicePRO: the "card issued" flag

Companion to `SERVICEPRO-INTEGRATION.md`. That document covers everything
ServicePRO **pushes into** BlueLion. This one covers the **one thing BlueLion
pushes back out**: a flag telling ServicePRO that a physical card was issued
for a training.

It also documents the `attributes` convention on training ingest — the
mechanism that lets each card type carry its own idiosyncratic fields
(fit factor, respirator model, method, student number, …) **without a code
change on either side**.

---

## 1. Direction of travel (this reverses the usual flow)

Everything else in the integration is one-way: ServicePRO → BlueLion. The card
flag is the **only** call BlueLion makes outbound. It's deliberately small,
idempotent, and best-effort: **the card is already issued and recorded in
BlueLion before the flag is ever attempted** — the flag failing never unwinds a
card. It just means ServicePRO hasn't been told yet, and BlueLion will keep
retrying.

```
Operator issues a card in BlueLion
   → card.issued event written (immutable, source of truth)  [already done]
   → duplex print job queued for the Magicard
   → "card issued" flag POSTed to ServicePRO   ← this document
```

---

## 2. Config (BlueLion side)

The flag is **config-gated** — off until you set the URL. Env vars on the
BlueLion host (`deploy/bluelion.service`):

| var | required | what |
|-----|----------|------|
| `SERVICEPRO_OUTBOUND_URL` | yes (to enable) | The ServicePRO endpoint BlueLion POSTs to. Unset ⇒ flag disabled, cards still issue, flags queue silently. |
| `SERVICEPRO_OUTBOUND_TOKEN` | recommended | Sent as `Authorization: Bearer <token>`. ServicePRO issues + validates it. |
| `SERVICEPRO_OUTBOUND_INTERVAL_MS` | no (default 15000) | How often BlueLion drains its pending-flag queue. |
| `SERVICEPRO_OUTBOUND_BACKOFF_MS` | no (default 30000) | Base for exponential retry backoff. |

Like the inbound path, this stays on the LAN — BlueLion posts to a ServicePRO
host reachable from the BlueLion VM, not through Cloudflare.

---

## 3. What ServicePRO must build: a receiver

A single endpoint. Method and path are your choice — whatever you set as
`SERVICEPRO_OUTBOUND_URL`.

**Request BlueLion sends:**

```http
POST <your endpoint>
Authorization: Bearer <SERVICEPRO_OUTBOUND_TOKEN>
Idempotency-Key: 9f2c…                (the card.issued event hash — unique per card)
Content-Type: application/json
```

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

| field | what |
|-------|------|
| `event` | Always `"card.issued"` today. Room for future card events. |
| `cardId` | BlueLion's id for this physical card. Stable. |
| `personId` | BlueLion person slug (matches the `personId` you already store from training ingest). |
| `certCode` | The class this card is for (from your catalog mapping). |
| `issuedOn` | ISO timestamp the card was issued. |
| `issuedBy` | The BlueLion operator/actor who issued it. |
| `templateId` / `templateVersion` | Which card design + version was printed. |
| `frontSha256` / `backSha256` | Hashes of the exact rendered front/back — provable "this is what we printed". |
| `reissueOf` | `null` on a first issue; the prior `cardId` when this is a reprint (see §5). |
| `verifyUrl` | The public per-person record URL the card's QR points at. |

**Response contract** — BlueLion acts on your status code:

| you return | BlueLion does |
|------------|---------------|
| `2xx` | Marks the flag `pushed`. Done. |
| `4xx` | Treats it as **permanent** (bad request / unknown card / auth). Parks the flag `failed` and **stops retrying** — needs a human. Don't return 4xx for transient problems. |
| `5xx` or timeout / connection error | Treats it as **transient**. Retries with exponential backoff (base `SERVICEPRO_OUTBOUND_BACKOFF_MS`, cap 1h), up to 20 attempts, then parks `failed`. |

**Idempotency:** the `Idempotency-Key` header (the event hash) is unique and
stable per card. The same key can legitimately arrive **more than once** (a
retry after your 5xx, or after a network blip where you actually did process
it). Dedupe on that key — record it, and if you see it again, return `2xx`
without double-applying.

Minimum you should store per received flag: `cardId`, `personId`, `certCode`,
`issuedOn`, and a `bluelion_card_issued_at` timestamp on the relevant training
row — enough to show "card printed" in ServicePRO.

---

## 4. The `attributes` convention (inbound) — per-card-type fields

This is how the "lots of weirdness per card type" problem is solved without
schema churn.

The training ingest endpoint (`POST /api/integrations/servicepro/trainings`,
§3.1 of the main spec) now accepts an **optional `attributes` object** on each
record — an open bag of card-type-specific fields:

```json
{
  "records": [{
    "externalId": "sp-tr-9002",
    "person": { "blueLionId": "fuerte-juan" },
    "classCode": "RESP-FIT",
    "issuedOn": "2026-06-17",
    "expiresOn": "2027-06-17",
    "certNumber": "SN-2026-SES-000223",
    "attributes": {
      "fit_factor": 889,
      "respirator_mfg": "SCOTT",
      "respirator_model": "AV-3000",
      "respirator_type": "FULL-FACE",
      "size": "LG",
      "method": "QNFT via TSI PortaCount",
      "student_no": "SN-2026-SES-000223"
    }
  }]
}
```

BlueLion stores `attributes` verbatim on the training. A card template binds
its fields to any path — the standard ones (`holder_name`, `cert_name`,
`issued_on`, `expires_on`, `cert_number`, `employer`, …) **plus any**
`attributes.<key>`. So the whole loop for a new/weird card type is:

1. ServicePRO sends the extra fields in `attributes` (this doc).
2. A BlueLion admin drops those fields onto the card art in the designer and
   binds each to `attributes.<key>` (no code, no deploy).

**Conventions for `attributes`:**

- Use **stable `snake_case` keys**, consistent across every record of the same
  `classCode` — one template binds to those keys and must find them every time.
- Values are rendered as **text** (numbers are stringified). Dates you want
  formatted should be `YYYY-MM-DD` and bound with the "date" format in the
  designer.
- Omit a field ⇒ that card position renders its template fallback (e.g. `—`).
- `attributes` is optional; classes with no special fields send nothing.

If you're unsure which keys a given card type needs, ask — the admin who builds
the template defines the field list, and it should be shared with ServicePRO so
the two agree on key names.

---

## 5. Reprints

A reprint is **not** an update — it's a brand-new `card.issued` with its own
`cardId` and its own idempotency key, and `reissueOf` set to the prior card's
id. Treat it as a new issuance that supersedes the previous one (e.g. a bad
first print, or a corrected field). You'll get one flag per physical print.

---

## 6. Testing the receiver

Mock BlueLion's call before wiring the real thing:

```bash
curl -X POST "$YOUR_ENDPOINT" \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Idempotency-Key: test-key-0001" \
  -H "Content-Type: application/json" \
  -d '{
    "event":"card.issued",
    "cardId":"card-TEST0001",
    "personId":"smith-joe",
    "certCode":"RESP-FIT",
    "issuedOn":"2026-07-07T18:00:00.000Z",
    "issuedBy":"trainer-mel",
    "templateId":"fit-test-card","templateVersion":1,
    "frontSha256":"deadbeef","backSha256":"cafef00d",
    "reissueOf":null,
    "verifyUrl":"https://vault.basinsafetyus.com/r/person/smith-joe"
  }'
```

Return `503` on the first call and `200` on a re-send with the same
`Idempotency-Key` to confirm BlueLion's retry + your dedupe both work.

On the BlueLion side, an admin can force a drain of the pending queue with
`POST /api/cards/push/drain` (needs the `cards:admin` role) and see per-card
push status in `GET /api/persons/:id/cards`.

---

## 7. Out of scope

- BlueLion does not expose a "list issued cards" pull endpoint for ServicePRO
  yet; the flag is push-only. If you need reconciliation, ask for a read
  endpoint (a read-scoped token can be issued).
- Card **void / revoke** is not modeled yet — today a bad card is handled by a
  reprint (`reissueOf`), not a revocation event.
