-- Catchup migration #3. schema.prisma has 'isoamyl_acetate' on FitTestMethod;
-- no migration ever added it (likely a rename from 'saccharin' that was
-- done in schema only). Writes using the new value would fail at runtime.
--
-- Not removing 'saccharin' from the enum — existing fit_test_records rows
-- may still carry that value, and dropping enum values in Postgres is a
-- bigger operation (must rewrite or migrate rows first). Leaving it as
-- a harmless orphan is safer.

ALTER TYPE "FitTestMethod" ADD VALUE IF NOT EXISTS 'isoamyl_acetate';
