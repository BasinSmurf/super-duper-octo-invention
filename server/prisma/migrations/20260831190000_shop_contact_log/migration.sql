-- WI-10: the communication log becomes a table, and gains a party.
--
-- THE SPEC ASKED TO "GENERALIZE THE EXISTING TABLE". There was no table. The
-- customer-contact log lived as a `contact_log` JSONB array on
-- shop_work_orders, and it was never scoped to Ready For Pickup either -- only
-- the CARD was, by a status check in the page. So this builds the table the
-- spec assumed existed, and migrates the JSON into it.
--
-- WHY NOT JUST ADD A `party` KEY TO THE JSONB: the follow-up widget's entire
-- job is "show me every work order whose ETA has passed". That is a question
-- ACROSS work orders, and it cannot be asked of an array hanging off each
-- parent row without scanning every one of them and unpacking JSON. A log you
-- can only read one job at a time is a log nobody uses to plan a day. That is
-- also why follow_up_at is a real, indexed column.

CREATE TYPE "ContactParty"  AS ENUM ('customer', 'vendor');
CREATE TYPE "ContactMethod" AS ENUM ('call', 'email', 'text', 'in_person', 'other');

CREATE TABLE "shop_contact_log_entries" (
  "id"              TEXT NOT NULL,
  "work_order_id"   TEXT NOT NULL,
  "party"           "ContactParty" NOT NULL,
  "method"          "ContactMethod" NOT NULL,
  "note"            TEXT NOT NULL,
  "contacted_at"    TIMESTAMP(3) NOT NULL,
  "follow_up_at"    TIMESTAMP(3),
  "entered_by_id"   TEXT,
  "entered_by_name" TEXT,
  "deleted_at"      TIMESTAMP(3),
  "deleted_by_id"   TEXT,
  "delete_reason"   TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shop_contact_log_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shop_contact_log_entries_work_order_id_idx"
  ON "shop_contact_log_entries"("work_order_id");
CREATE INDEX "shop_contact_log_entries_follow_up_at_idx"
  ON "shop_contact_log_entries"("follow_up_at");

ALTER TABLE "shop_contact_log_entries"
  ADD CONSTRAINT "shop_contact_log_entries_work_order_id_fkey"
  FOREIGN KEY ("work_order_id") REFERENCES "shop_work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_contact_log_entries"
  ADD CONSTRAINT "shop_contact_log_entries_entered_by_id_fkey"
  FOREIGN KEY ("entered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shop_contact_log_entries"
  ADD CONSTRAINT "shop_contact_log_entries_deleted_by_id_fkey"
  FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A soft delete has to carry its reason. Enforced here rather than at the route
-- because "deleted with a logged reason" is the whole difference between this
-- and simply losing the entry.
ALTER TABLE "shop_contact_log_entries"
  ADD CONSTRAINT "shop_contact_delete_needs_reason"
  CHECK (
    ("deleted_at" IS NULL AND "delete_reason" IS NULL AND "deleted_by_id" IS NULL)
    OR ("deleted_at" IS NOT NULL AND "delete_reason" IS NOT NULL AND length(btrim("delete_reason")) > 0)
  );

-- ── Migrate the existing JSONB log ─────────────────────────────────────────
--
-- Every existing entry is a customer contact -- that is all the old shape could
-- record. Ids are carried across verbatim so anything holding one still
-- resolves, and created_at falls back through contactedAt because the earliest
-- entries predate the createdAt key being written.
--
-- The old `contact_log` column is deliberately LEFT IN PLACE and simply stops
-- being written. It is the rollback: if this migration is reverted the data is
-- still sitting where the old code expects it. Dropping it is a follow-up once
-- the table has run in production for a release.
INSERT INTO "shop_contact_log_entries" (
  "id", "work_order_id", "party", "method", "note",
  "contacted_at", "entered_by_id", "entered_by_name", "created_at"
)
SELECT
  COALESCE(e->>'id', gen_random_uuid()::text),
  w."id",
  'customer'::"ContactParty",
  CASE
    WHEN e->>'method' IN ('call', 'email', 'text', 'in_person', 'other')
      THEN (e->>'method')::"ContactMethod"
    ELSE 'other'::"ContactMethod"
  END,
  COALESCE(e->>'note', ''),
  COALESCE(
    NULLIF(e->>'contactedAt', '')::timestamp,
    NULLIF(e->>'createdAt', '')::timestamp,
    w."created_at"
  ),
  -- The enterer is resolved INLINE rather than cleaned up afterwards. An id
  -- copied out of the JSON may point at a user who has since been deleted, and
  -- the foreign key rejects the whole INSERT before any later UPDATE could fix
  -- it -- so the orphan has to be nulled on the way in, not on the way out.
  -- entered_by_name is the snapshot that keeps the entry readable regardless,
  -- which is exactly why that column is denormalized.
  (SELECT u."id" FROM "users" u WHERE u."id" = NULLIF(e->>'enteredById', '')),
  NULLIF(e->>'enteredByName', ''),
  COALESCE(
    NULLIF(e->>'createdAt', '')::timestamp,
    NULLIF(e->>'contactedAt', '')::timestamp,
    w."created_at"
  )
FROM "shop_work_orders" w
CROSS JOIN LATERAL jsonb_array_elements(w."contact_log") AS e
WHERE jsonb_typeof(w."contact_log") = 'array'
ON CONFLICT ("id") DO NOTHING;

-- ── Append-only, enforced by the database ──────────────────────────────────
--
-- Same argument as WI-05's soft-close stamp and WI-06's snapshot: if a rule
-- matters, the schema enforces it. A guard each route has to remember is a
-- guard a future route forgets, and here the failure is silent -- an edited
-- log entry looks exactly like an honest one.
--
-- The content columns are frozen at insert. The delete columns are the ONLY
-- mutable ones, and only in one direction: a soft delete cannot be un-done or
-- re-worded, because "who deleted this and why" is the part somebody will
-- eventually want to change.
CREATE OR REPLACE FUNCTION shop_contact_log_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
       OR NEW.party        IS DISTINCT FROM OLD.party
       OR NEW.method       IS DISTINCT FROM OLD.method
       OR NEW.note         IS DISTINCT FROM OLD.note
       OR NEW.contacted_at IS DISTINCT FROM OLD.contacted_at
       OR NEW.follow_up_at IS DISTINCT FROM OLD.follow_up_at
       OR NEW.entered_by_id   IS DISTINCT FROM OLD.entered_by_id
       OR NEW.entered_by_name IS DISTINCT FROM OLD.entered_by_name
       OR NEW.created_at   IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION
            'shop_contact_log_entries is append-only; entry % cannot be edited', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.deleted_at IS NOT NULL
       AND (NEW.deleted_at    IS DISTINCT FROM OLD.deleted_at
         OR NEW.deleted_by_id IS DISTINCT FROM OLD.deleted_by_id
         OR NEW.delete_reason IS DISTINCT FROM OLD.delete_reason)
    THEN
        RAISE EXCEPTION
            'entry % is already deleted; the deletion record cannot be changed', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shop_contact_log_immutable
    BEFORE UPDATE ON "shop_contact_log_entries"
    FOR EACH ROW EXECUTE FUNCTION shop_contact_log_append_only();
