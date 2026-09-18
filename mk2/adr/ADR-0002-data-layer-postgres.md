# ADR-0002 — Data layer: Postgres vs MariaDB vs other

- **Status:** Proposed
- **Date:** 2026-06-27
- **Principle flags:** None.

## Current state (file evidence)
- Postgres 16 (`docker-compose.prod.yml`), Prisma 7.8.0 via the `@prisma/adapter-pg` pg driver (`server/src/db.ts:8`). Schema: **67 models, 75 native enums, 3,428 lines**, 97 migrations.
- **Postgres-specific features in active use:**
  - **45 `@db.JsonB` fields** across the core models (`ServiceTicket.customData/reviewSignal/billingRefs`, `Invoice`, `EquipmentInspection.data` — *polymorphic per inspection category*, `RentalAgreement.wellIds`, etc.).
  - **`pg_trgm` extension** (`migrations/00000000000000_init_extensions`) for fuzzy name matching.
  - **Stored generated columns** `wells.name_norm` / `dmr_reference_wells.name_norm` `GENERATED ALWAYS AS (...) STORED` + btree indexes (`migrations/20260603160000_dmr_norm_name_indexes`).
  - **CHECK constraint** `equipment_inspections_parent_exclusivity` (XOR on two FKs, `migrations/20260508190100`).
  - 75 native `ENUM` types; `@db.Decimal`, `@db.Date`, `@db.Text`.
- No PostGIS — lat/lng are `Decimal(10,7)`, proximity math is in app code (`services/wellProximity.ts`).

## Why it was likely chosen
Prisma's first-class provider, JSONB for the heavily semi-structured oilfield domain (every work type has different fields), and pg_trgm for the DMR well-name matching problem. All sound defaults.

## The case to replace (MariaDB / other)
- Honestly: **almost none, and the brief asked me to be honest about whether the question is even live.** It is not. The only theoretical pulls toward MariaDB would be licensing (Postgres is already free/OSS) or existing DBA familiarity (not in evidence). There is no performance, cost, or feature argument for MariaDB here.
- A weak "simplify" argument: the 45 JSONB catch-alls are a *modeling* smell (schema-by-convention inside `customData`). But that is an argument about **how the schema is used**, not about the engine — moving to MariaDB JSON would make it strictly worse (weaker JSON indexing/operators).

## The case to keep
- Feature dependence is real and load-bearing: pg_trgm, stored generated columns, CHECK constraints, native enums, JSONB. A MariaDB port would have to re-implement fuzzy matching app-side or with a search engine, drop/rewrite generated columns, convert enums to lookup tables, and downgrade JSONB to JSON.
- Prisma 7 + pg adapter is a clean, supported path. Postgres 16 is nowhere near a capability ceiling for this workload (dozens of concurrent staff + QBWC polling, not high-RPS).

## Migration cost / risk / effort
- **To MariaDB: High cost, zero benefit, real risk** (rewrite DMR matching, lose generated columns, enum migration, JSONB downgrade) on an app with **no test coverage** to catch regressions. This is the textbook novelty/lateral move to refuse.

## Verdict: **KEEP** — and stop touching it.
> Postgres is load-bearing-and-correct. The only adjacent work worth doing is reducing reliance on `customData` JSONB bags for fields that have become first-class (a schema-hygiene task, [ADR-0008](ADR-0008-quickbooks-boundary.md) territory), not changing engines.
