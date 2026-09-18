-- Field equipment inspection promoted to its own top-level work type. It rides
-- on field_service tickets (serviceSubtype = 'inspection') so field-ticket
-- billing/PDF logic still applies, and gets the "SP-" ticket-number series.
-- Additive enum value — safe to apply over existing data.
ALTER TYPE "ServiceSubtype" ADD VALUE IF NOT EXISTS 'inspection';
