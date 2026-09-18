-- ============================================================
-- CUSTOM INDEXES (run after Prisma migrations)
-- These use pg_trgm gin indexes that Prisma doesn't natively support
-- ============================================================

-- Customer lookups (fuzzy)
CREATE INDEX IF NOT EXISTS idx_companies_name_trgm ON companies USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_operator_aliases_name_trgm ON operator_aliases USING gin(dmr_operator_name gin_trgm_ops);

-- Location hierarchy traversal
CREATE INDEX IF NOT EXISTS idx_fields_active ON fields(id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_pads_field ON pads(field_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_pads_operator ON pads(current_operator_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_wells_pad ON wells(pad_id) WHERE is_active_for_service = true;
CREATE INDEX IF NOT EXISTS idx_wells_operator ON wells(current_operator_id) WHERE is_active_for_service = true;
CREATE INDEX IF NOT EXISTS idx_wells_name_trgm ON wells USING gin(well_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_wells_section ON wells(section, township, range);

-- DMR reference (43k records)
CREATE INDEX IF NOT EXISTS idx_dmr_api ON dmr_reference_wells(api_number);
CREATE INDEX IF NOT EXISTS idx_dmr_operator_trgm ON dmr_reference_wells USING gin(operator_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dmr_well_name_trgm ON dmr_reference_wells USING gin(well_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_dmr_section ON dmr_reference_wells(section, township, range);
CREATE INDEX IF NOT EXISTS idx_dmr_field ON dmr_reference_wells(field_name);

-- Ticket queries
CREATE INDEX IF NOT EXISTS idx_tickets_company ON service_tickets(company_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON service_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON service_tickets(assigned_tech_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_service_date ON service_tickets(service_date);
CREATE INDEX IF NOT EXISTS idx_tickets_billing_group ON service_tickets(billing_group_id);
CREATE INDEX IF NOT EXISTS idx_tickets_field ON service_tickets(field_id);
CREATE INDEX IF NOT EXISTS idx_tickets_offline ON service_tickets(offline_id);

-- Equipment
CREATE INDEX IF NOT EXISTS idx_equipment_status ON serialized_equipment(status);
CREATE INDEX IF NOT EXISTS idx_equipment_cal_due ON serialized_equipment(calibration_due_date)
  WHERE status IN ('deployed', 'rented', 'available');

-- Billing groups
CREATE INDEX IF NOT EXISTS idx_billing_groups_company ON billing_groups(company_id, status);
CREATE INDEX IF NOT EXISTS idx_billing_groups_key ON billing_groups(group_key);

-- Sync queues
CREATE INDEX IF NOT EXISTS idx_qb_queue_pending ON qb_sync_queue(status, priority) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_enverus_queue_pending ON enverus_sync_queue(status) WHERE status = 'pending';

-- Repair orders
CREATE INDEX IF NOT EXISTS idx_repairs_status ON repair_orders(status);
CREATE INDEX IF NOT EXISTS idx_repairs_equipment ON repair_orders(serialized_equipment_id);
CREATE INDEX IF NOT EXISTS idx_repairs_source ON repair_orders(source_ticket_id);

-- Audit log (append-only, query by entity)
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);

-- Full-text search for legacy tickets
CREATE INDEX IF NOT EXISTS idx_legacy_notes_trgm ON legacy_tickets USING gin(notes_full_text gin_trgm_ops);
