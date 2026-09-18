-- ClassPRO roles: trainer (teaches classes, runs own training tickets) and
-- train_admin (manages the course catalog + scheduling).
--
-- Postgres allows ALTER TYPE ... ADD VALUE inside a transaction (PG12+) but
-- forbids USING the new value in the same transaction — so the Google-group
-- mapping seed lives in the NEXT migration, not this one.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'trainer';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'train_admin';
