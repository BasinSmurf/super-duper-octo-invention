-- Board split: the wall kanban now comes in two flavours. The existing BOARD
-- role renders CUSTOMER work only; INHOUSE renders Basin's own in-house work
-- (ShopWorkOrder.is_internal = true). Together they partition the shop.
ALTER TYPE "KioskRole" ADD VALUE IF NOT EXISTS 'INHOUSE';
