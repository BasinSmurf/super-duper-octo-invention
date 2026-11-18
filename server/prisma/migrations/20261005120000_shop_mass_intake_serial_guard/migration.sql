-- Count-only intake uses empty serials, never fabricated equipment identities.
-- Guard every closing path, including offline replay and supervisor overrides.
CREATE FUNCTION shop_require_serial_before_close() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('shop_complete', 'returned', 'condemned')
     AND BTRIM(COALESCE(NEW.serial_number, '')) = '' THEN
    RAISE EXCEPTION 'Record a serial for every piece before closing or return';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shop_item_require_serial
  BEFORE INSERT OR UPDATE ON "shop_work_order_items"
  FOR EACH ROW EXECUTE FUNCTION shop_require_serial_before_close();

CREATE FUNCTION shop_wo_require_serial_before_close() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('complete', 'closed') AND EXISTS (
    SELECT 1 FROM "shop_work_order_items"
    WHERE work_order_id = NEW.id AND BTRIM(COALESCE(serial_number, '')) = ''
  ) THEN
    RAISE EXCEPTION 'Record a serial for every piece before closing or return';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shop_wo_require_serial
  BEFORE UPDATE ON "shop_work_orders"
  FOR EACH ROW EXECUTE FUNCTION shop_wo_require_serial_before_close();
