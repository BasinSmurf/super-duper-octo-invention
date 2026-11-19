-- Refuse ambiguous existing identities rather than silently deleting work.
CREATE UNIQUE INDEX "service_tickets_offline_id_key" ON "service_tickets"("offline_id");
