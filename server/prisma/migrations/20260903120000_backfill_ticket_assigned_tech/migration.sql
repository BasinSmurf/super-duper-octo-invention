-- Backfill the assignment for tickets created through the wizard before the
-- sync push carried assigned_tech_id. buildTicketPayload() never sent the
-- field, so the server created these rows with assigned_tech_id NULL — which
-- dropped them out of the creating tech's "My Jobs" filter AND out of the
-- delta-sync prune list (both scope by assigned_tech_id for field_tech), so
-- the ticket vanished off the device on the next sync.
--
-- The creator is the right owner here: the wizard's local Dexie record always
-- set assignedTechId to the signed-in user, and both create paths now default
-- to that same user (POST /api/tickets and the sync push handler). This only
-- restores what those rows should have carried all along.
--
-- Deliberately scoped to rows that HAVE a creator: imported/legacy tickets
-- (DoForms and the like) have no created_by_id and are genuinely unassigned —
-- inventing an owner for those would put someone else's history in a tech's
-- job list.
UPDATE "service_tickets"
   SET "assigned_tech_id" = "created_by_id"
 WHERE "assigned_tech_id" IS NULL
   AND "created_by_id" IS NOT NULL;
