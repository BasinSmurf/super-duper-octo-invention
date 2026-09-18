-- Pad is no longer a required grouping; Field is being hidden from the UI
-- everywhere but kept in the DB for reference. Wells/Pads no longer require
-- a Field.
ALTER TABLE "pads" ALTER COLUMN "field_id" DROP NOT NULL;
ALTER TABLE "wells" ALTER COLUMN "field_id" DROP NOT NULL;
