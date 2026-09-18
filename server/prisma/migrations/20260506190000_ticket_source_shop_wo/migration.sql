-- Phase 4 C — auto-generated tickets from closed Shop WOs need their own
-- source-type tag so they're filterable + reportable separately from
-- dispatch / self_created / template tickets.
--
-- Plus: 'shop_repair' joins ServiceSubtype so the auto-generated ticket
-- carries a subtype that ticketReviewRules.SHOP_BASED_SUBTYPES already
-- knows about (was a string-set entry without a matching enum value
-- before this — dead code in the rule engine).

ALTER TYPE "TicketSourceType" ADD VALUE IF NOT EXISTS 'shop_work_order';
ALTER TYPE "ServiceSubtype" ADD VALUE IF NOT EXISTS 'shop_repair';
