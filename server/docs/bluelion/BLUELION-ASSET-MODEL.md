# BlueLion asset model — SCBA composition

**Direction:** ServicePRO → BlueLion. This is the one doc in this folder written
from the SP side; the `SERVICEPRO-*.md` files are BlueLion's contracts to us.

**Status:** proposal / framework. Nothing here is built on either side yet.

**Why now:** the first full load landed 2026-08-14 (749 units). BlueLion held zero
records before it, and we're purging and reloading anyway to fix serials — so
this is the one free window to change the shape before there's history worth
preserving.

---

## 1. The problem the current model has

Today every serialized thing SP knows about is pushed as its own flat `asset`,
keyed `(kind, serial)`. That's why ~100 service tickets produced ~700 assets: an
SCBA isn't a thing, it's an assembly of things, and each one arrives as a
peer with no relationship to the others.

Two consequences:

- A cylinder and a mask can collide. `kind` is currently one value — `scba` — for
  the pack and every part in it, so dedupe on `(kind, serial)` treats a mask
  serial and a cylinder serial as the same namespace.
- Nothing can answer "what's in this pack?" or "which pack was this bottle in
  when it failed hydro?"

What we want instead, stated as the two queries that matter:

1. **Scan a cylinder serial** → its own record, its own service history, its own
   UE documents, and which assembly it's currently installed in.
2. **Scan the pack** → every component currently in it, each with its own status
   and next-due date.

Both need the component to be a first-class record. Neither is served by
flattening the pack into one asset with attributes.

---

## 2. Core decision: assets stay atomic, composition is a separate edge

Keep one `asset` row per serialized item — cylinder, valve, backframe, mask,
case, pack. **Do not** collapse an SCBA into a single asset with the parts as
attributes: the cylinder has its own regulatory clock (hydro/UE) and outlives
any particular pack, so it needs to be the thing history hangs off.

Then model composition as **membership over time**, not a parent pointer:

```sql
CREATE TABLE asset_membership (
  id             bigserial PRIMARY KEY,
  parent_id      bigint NOT NULL REFERENCES assets(id),
  child_id       bigint NOT NULL REFERENCES assets(id),
  installed_on   date NOT NULL,
  removed_on     date,                      -- NULL = currently installed
  installed_note text,
  CONSTRAINT no_self_membership CHECK (parent_id <> child_id)
);

-- A child is in at most one assembly at a time.
CREATE UNIQUE INDEX asset_membership_one_active_parent
  ON asset_membership (child_id) WHERE removed_on IS NULL;

CREATE INDEX asset_membership_parent_active
  ON asset_membership (parent_id) WHERE removed_on IS NULL;
```

**This is the one call in the doc worth arguing about, so here's the reasoning.**
A plain `assets.parent_id` self-FK is simpler and would work fine for query #2.
It fails query #1 the moment a bottle gets swapped between packs, which is
routine. With a parent pointer, moving a cylinder silently rewrites the past:
the pack's failure history now appears to belong to whatever bottle is in it
today. The membership table costs one join and keeps "which pack was this in on
the day of that service event" answerable forever.

The partial unique index is what enforces the physical truth — a bottle is in
one pack or none, never two.

---

## 3. Kinds need to split

`scba` as a single kind can't survive composition. Suggested governed list,
replacing the current `scba` value:

| kind | notes |
|---|---|
| `scba_assembly` | the pack / case — the thing a tech carries |
| `scba_cylinder` | the UE bottle. Own hydro + UE clock, own record, moves between packs |
| `scba_valve` | serialized on most makes |
| `scba_backframe` | the harness/frame |
| `scba_mask` | facepiece, often issued per-person rather than per-pack |
| `scba_regulator` | where serialized |

`fire_extinguisher`, `harness`, `gas_monitor`, `other` stay as they are.

Only `scba_assembly` should be a legal `parent_id` in `asset_membership` for now
— a cylinder does not contain a mask. Worth a trigger or a CHECK against a
small `kind_can_parent` table rather than leaving it to convention.

---

## 4. Cylinders are a subtype, not an attribute bag

The cylinder is the only component with a regulatory lifecycle, and it's the one
the UE documents already attach to. It earns real columns:

```sql
CREATE TABLE asset_cylinder (
  asset_id          bigint PRIMARY KEY REFERENCES assets(id),
  dot_spec          text,        -- e.g. 'DOT-CFFC', 'DOT-3AL'
  material          text,        -- composite | aluminum | steel
  manufactured_on   date,        -- starts the 15-year clock on composites
  service_pressure  integer,     -- psi
  last_hydro_on     date,
  hydro_due_on      date,
  last_ue_on        date,
  ue_due_on         date,
  condemned_on      date,
  condemn_reason    text
);
```

`condemned_on` here is deliberately redundant with whatever `assets` carries —
if you'd rather keep condemnation purely on `assets`, drop it, but don't split
the hydro/UE dates across two tables.

The existing `/documents` endpoint (`docType=ultrasonic_exam`) should attach to
the **cylinder's** asset id, never the assembly's. That's already how it
behaves if SP sends the component's id, which it will.

Everything else — mask sizes, valve variants — can live in a `jsonb attributes`
column on `assets` until something needs to query it. Cylinders are the
exception because "what's due in the next 90 days" is a real report.

---

## 5. The two queries, concretely

**Bottle → its pack and its history:**

```sql
SELECT a.serial, a.kind, c.hydro_due_on, c.ue_due_on,
       p.serial AS installed_in, m.installed_on
FROM assets a
JOIN asset_cylinder c ON c.asset_id = a.id
LEFT JOIN asset_membership m ON m.child_id = a.id AND m.removed_on IS NULL
LEFT JOIN assets p ON p.id = m.parent_id
WHERE a.kind = 'scba_cylinder' AND a.serial = $1;
```

**Pack → everything currently in it:**

```sql
SELECT c.kind, c.serial, c.label,
       COALESCE(cyl.ue_due_on, cyl.hydro_due_on) AS next_due
FROM assets p
JOIN asset_membership m ON m.parent_id = p.id AND m.removed_on IS NULL
JOIN assets c ON c.id = m.child_id
LEFT JOIN asset_cylinder cyl ON cyl.asset_id = c.id
WHERE p.kind = 'scba_assembly' AND p.serial = $1
ORDER BY c.kind;
```

Service events stay attached to whichever asset was actually serviced. The pack
view rolls them up by joining through membership — it does not need its own copy.

---

## 6. What SP has to send you (ingest changes)

The current `POST /api/integrations/servicepro/assets` record has no way to
express composition. Minimal addition:

```jsonc
{
  "externalId": "sp-asset-scba_cylinder-CYL88213",
  "kind": "scba_cylinder",
  "serial": "CYL88213",
  "label": "SCBA 19 bottle",          // human text, never identity
  "parentExternalId": "sp-asset-scba_assembly-BSU-SCBA-000142",  // new, optional
  "installedOn": "2026-08-14",        // new, optional; defaults to now
  "serialSource": "manufacturer"      // new: manufacturer | assigned
}
```

Three notes on that:

- **Ordering.** SP will register the assembly before its children, the same way
  it already registers assets before service events. If a `parentExternalId`
  arrives unknown, return the record as `invalid` rather than creating a stub —
  we'd rather fix ordering on our side than have you guess.
- **Re-parenting.** A record whose `parentExternalId` differs from the child's
  current active membership should close the old row (`removed_on = installedOn`)
  and open a new one. That's the bottle-swap path and it should be ordinary, not
  an error.
- **`serialSource`.** SP is minting tags (`BSU-<KIND>-<6-digit>`) for units whose
  field-entered "serial" was a description like `"SCBA 19"`. Those are real
  identities and get physical labels, but nobody should read `BSU-SCBA-000142`
  off a nameplate. Flag them so your UI can say "assigned" rather than implying
  a manufacturer stamp.

---

## 7. externalId churn — do it during the purge

SP's externalIds are `sp-asset-<kind>-<serial>`. Splitting `scba` into six kinds
changes them, and the re-mint changes the serial half for anything that had a
description instead of a serial. Both are fine *if they happen while the ledger
is empty*.

If your purge does **not** clear the ingested-externalId dedupe records, tell me
before we reload — re-pushes would come back `skipped` and nothing would land.
Anything with a changed kind or serial is safe either way; the exposure is rows
re-pushed under an unchanged id.

---

## 8. Open questions for you

1. Is `scba_assembly` the right grain for the thing techs actually scan, or do
   you want the *case* and the *pack* as separate assets? SP models a case as a
   serialized unit today (that's where `"Pelican 1550 Case"` came from).
2. Should a mask be a member of the pack, or issued per-person and linked to a
   person rather than an assembly? It's the one component that's often neither.
3. Do you want membership history exposed on the asset detail view, or is
   "currently installed" enough for v1? The table supports both; the UI cost
   differs.
4. Anything on your side that assumes one flat asset per serial and would break
   on a parent/child split — reports, exports, the card templates?
