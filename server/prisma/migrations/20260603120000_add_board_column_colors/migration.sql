-- Per-display-column color overrides for the shop board (BoardConfig singleton).
-- Nullable JSONB: NULL = no overrides stored yet (client uses built-in defaults).
ALTER TABLE "board_config" ADD COLUMN "column_colors" JSONB;
