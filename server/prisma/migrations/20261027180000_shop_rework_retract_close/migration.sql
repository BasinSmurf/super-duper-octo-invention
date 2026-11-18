-- A close retracted to active work must stop its correction timer on every write path.
-- Terminal-to-terminal disposition changes preserve the existing deadline.
CREATE OR REPLACE FUNCTION shop_item_stamp_soft_close() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.status IN ('shop_complete', 'returned', 'condemned')
       AND NEW.status NOT IN ('shop_complete', 'returned', 'condemned')
    THEN
        NEW.soft_closed_at := NULL;
        NEW.hard_closes_at := NULL;
        NEW.closed_by_id := NULL;
    END IF;
    IF NEW.status IN ('shop_complete', 'returned', 'condemned')
       AND NEW.soft_closed_at IS NULL
    THEN
        NEW.soft_closed_at := NOW();
        NEW.hard_closes_at := NOW() + INTERVAL '48 hours';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
