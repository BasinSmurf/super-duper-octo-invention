-- AR Supervisor: everything billing_ar can do, plus the override actions that
-- skip a field step (first one: forcing a rental into the billing queue
-- without a supervisor's "send for billing").
--
-- Additive enum value only. Nothing uses it in this migration, so the
-- "can't use a new enum value in the same transaction" rule doesn't bite.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ar_supervisor';
