-- Phase B Field Service rework: add the three new top-level service subtypes.
-- Old values (monitor / air_system / bump_test / calibration) kept on the enum
-- so existing tickets continue to read/write cleanly.

ALTER TYPE "ServiceSubtype" ADD VALUE IF NOT EXISTS 'gas_detection';
ALTER TYPE "ServiceSubtype" ADD VALUE IF NOT EXISTS 'cascade_air';
ALTER TYPE "ServiceSubtype" ADD VALUE IF NOT EXISTS 'on_site_services';
