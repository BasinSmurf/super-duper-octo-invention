-- Training kiosk: new KioskRole value for the classroom sign-in board / signage.
-- Additive enum value; TRAINING kiosks reuse the existing station_filter column
-- to (optionally) scope to a CpLocation id.
ALTER TYPE "KioskRole" ADD VALUE IF NOT EXISTS 'TRAINING';
