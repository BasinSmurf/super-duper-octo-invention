-- Retracted, unbilled work must be editable again. Preserve each previous stamp in the audit trail.
-- Billed records are deliberately excluded; correcting those requires their existing review workflow.
WITH stale AS MATERIALIZED (
  SELECT id, status, soft_closed_at, hard_closes_at, closed_by_id
  FROM shop_work_order_items
  WHERE status NOT IN ('shop_complete', 'returned', 'condemned')
    AND soft_closed_at IS NOT NULL AND billed_at IS NULL
  FOR UPDATE
), repaired AS (
  UPDATE shop_work_order_items i
  SET soft_closed_at = NULL, hard_closes_at = NULL, closed_by_id = NULL, updated_at = NOW()
  FROM stale s WHERE i.id = s.id RETURNING i.id
)
INSERT INTO audit_log (id, user_id, entity_type, entity_id, action, changes, created_at)
SELECT gen_random_uuid()::text, NULL, 'shop_work_order_item', s.id, 'update',
  jsonb_build_object('maintenanceRepair', jsonb_build_object(
    'reason', 'Retracted close retained a correction timer while the unbilled unit was in active work.',
    'source', '20261027181000_repair_active_shop_close_stamps',
    'before', to_jsonb(s),
    'after', jsonb_build_object('status', s.status, 'soft_closed_at', NULL, 'hard_closes_at', NULL, 'closed_by_id', NULL))), NOW()
FROM stale s JOIN repaired r ON r.id = s.id;
