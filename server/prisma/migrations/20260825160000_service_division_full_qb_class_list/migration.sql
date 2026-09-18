-- ServiceDivision gets the rest of Basin's QB Class list.
--
-- The enum on master only holds D3 / D4 / D6, so Training, Occupational Health
-- and Direct Sale work had nowhere to put a division — which meant no
-- <ClassRef> on the QB invoice and a blank CLASS column in QuickBooks. QB's own
-- Class list (D0-D8 plus the Dickinson: sub-classes) is the authority; this adds
-- every division we bill against.
--
-- D0 (Basin Integrated) is deliberately left out: it's the admin/holding class
-- with property and person sub-classes, not service revenue.
--
-- Additive and idempotent. IF NOT EXISTS matters: the ADR-0017 migration on the
-- mk2-relitigation branch (20260721120000_service_division_d1_d5_d8) adds
-- D1/D5/D8 too, and has already been applied to some dev databases — this must
-- be a no-op there rather than an error. No positioning clause either, so the
-- DB's enum order may differ from schema.prisma's; Prisma compares values as a
-- set and `migrate deploy` doesn't drift-check, so that's cosmetic.
ALTER TYPE "ServiceDivision" ADD VALUE IF NOT EXISTS 'D1';
ALTER TYPE "ServiceDivision" ADD VALUE IF NOT EXISTS 'D2';
ALTER TYPE "ServiceDivision" ADD VALUE IF NOT EXISTS 'D5';
ALTER TYPE "ServiceDivision" ADD VALUE IF NOT EXISTS 'D7';
ALTER TYPE "ServiceDivision" ADD VALUE IF NOT EXISTS 'D8';
