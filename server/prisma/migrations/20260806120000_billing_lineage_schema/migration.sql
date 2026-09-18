-- Billing Lineage & Mirrored Status — Phase 1 (schema only, no behavior change).
-- Implements the "Billing Status Ownership and Ticket-to-Invoice Lineage" handoff.
-- See project_notifications_layer.md / the handoff doc for full design context.
--
-- This migration adds:
--   1. BillingReadiness enum + service_tickets.billing_readiness — the ONE
--      billing status column ServicePRO owns (Rule 1).
--   2. billing_doc_ref / billing_doc_line_ref — references to QuickBooks
--      documents (never the document itself) and their ticket-line mapping.
--   3. billing_submission — one row per attempt to put a document in front
--      of an operator (OpenInvoice / portal / email).
--   4. billing_observation — the append-only mirror table. Every fact QB or
--      Enverus asserts lives here with source + as-of + observed-at (Rule 3);
--      no bare "paid"/"accepted"/"disputed" column is added anywhere.
--   5. billing_reason_code — admin-editable controlled vocabulary (not free
--      text), same shape as google_role_mappings.
--   6. Two CHECK constraints and one immutability trigger Prisma can't
--      express in schema.prisma (see inline comments) — this is the first
--      trigger in this repo; hand-written and reviewed accordingly.
--
-- No data backfill here. New tables start empty; billing_readiness defaults
-- to unclassified for every existing ticket (correct — nobody has classified
-- it under this field yet; unclassified is deliberately distinct from
-- not_billable, which is a deliberate human call and always carries a reason
-- code + actor per the CHECK constraint below — a bare default of
-- not_billable would fail that CHECK for every ticket in the table).
-- Backfilling doc_ref/doc_line_ref from existing invoices, and wiring
-- QBWC/Enverus to actually populate billing_observation, land in the next
-- phase.

-- CreateEnum
CREATE TYPE "BillingReadiness" AS ENUM ('unclassified', 'not_billable', 'ready', 'invoiced', 'submitted');

-- CreateEnum
CREATE TYPE "BillingDocType" AS ENUM ('invoice', 'credit_memo');

-- AlterTable
ALTER TABLE "service_tickets" ADD COLUMN     "billing_readiness" "BillingReadiness" NOT NULL DEFAULT 'unclassified',
ADD COLUMN     "billing_readiness_reason_code" TEXT,
ADD COLUMN     "billing_readiness_set_at" TIMESTAMP(3),
ADD COLUMN     "billing_readiness_set_by_id" TEXT;

-- CreateTable
CREATE TABLE "billing_doc_ref" (
    "id" TEXT NOT NULL,
    "doc_type" "BillingDocType" NOT NULL,
    "doc_number" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "qb_txn_id" TEXT,
    "invoice_date" DATE,
    "supersedes_id" TEXT,
    "superseded_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_doc_ref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_doc_line_ref" (
    "id" TEXT NOT NULL,
    "doc_ref_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "ticket_number" TEXT NOT NULL,
    "service_date" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "billing_doc_line_ref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_submission" (
    "id" TEXT NOT NULL,
    "doc_ref_id" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "external_ref" TEXT,
    "outcome" TEXT,
    "reason_code" TEXT,
    "reason_note" TEXT,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "billing_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_observation" (
    "id" TEXT NOT NULL,
    "doc_ref_id" TEXT,
    "doc_line_ref_id" TEXT,
    "ticket_id" TEXT,
    "fact_key" TEXT NOT NULL,
    "fact_value" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "source_actor" TEXT,
    "as_of" TIMESTAMP(3) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_reason_code" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "resulting_action" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_reason_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_doc_ref_doc_number_revision_key" ON "billing_doc_ref"("doc_number", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "billing_doc_line_ref_doc_ref_id_line_no_key" ON "billing_doc_line_ref"("doc_ref_id", "line_no");

-- CreateIndex
CREATE INDEX "billing_observation_doc_ref_id_fact_key_as_of_idx" ON "billing_observation"("doc_ref_id", "fact_key", "as_of" DESC);

-- CreateIndex
CREATE INDEX "billing_observation_doc_line_ref_id_fact_key_as_of_idx" ON "billing_observation"("doc_line_ref_id", "fact_key", "as_of" DESC);

-- CreateIndex
CREATE INDEX "billing_observation_ticket_id_fact_key_as_of_idx" ON "billing_observation"("ticket_id", "fact_key", "as_of" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "billing_reason_code_code_key" ON "billing_reason_code"("code");

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_billing_readiness_set_by_id_fkey" FOREIGN KEY ("billing_readiness_set_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_doc_ref" ADD CONSTRAINT "billing_doc_ref_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "billing_doc_ref"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_doc_ref" ADD CONSTRAINT "billing_doc_ref_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "billing_doc_ref"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_doc_line_ref" ADD CONSTRAINT "billing_doc_line_ref_doc_ref_id_fkey" FOREIGN KEY ("doc_ref_id") REFERENCES "billing_doc_ref"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_doc_line_ref" ADD CONSTRAINT "billing_doc_line_ref_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_submission" ADD CONSTRAINT "billing_submission_doc_ref_id_fkey" FOREIGN KEY ("doc_ref_id") REFERENCES "billing_doc_ref"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_observation" ADD CONSTRAINT "billing_observation_doc_ref_id_fkey" FOREIGN KEY ("doc_ref_id") REFERENCES "billing_doc_ref"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_observation" ADD CONSTRAINT "billing_observation_doc_line_ref_id_fkey" FOREIGN KEY ("doc_line_ref_id") REFERENCES "billing_doc_line_ref"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_observation" ADD CONSTRAINT "billing_observation_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Human observations must be attributed. Prisma can't express CHECK
-- constraints in schema.prisma, so it lives here (same treatment as
-- equipment_inspections_parent_exclusivity in 20260508190100_equipment_inspection).
ALTER TABLE "billing_observation"
    ADD CONSTRAINT "billing_observation_human_source_requires_actor"
    CHECK (source <> 'human' OR source_actor IS NOT NULL);

-- not_billable is the single most likely place for money to hide — a ticket
-- can't be marked not_billable without a reason code and an attributed actor.
ALTER TABLE "service_tickets"
    ADD CONSTRAINT "service_tickets_not_billable_requires_reason_and_actor"
    CHECK (
        billing_readiness <> 'not_billable' OR
        (billing_readiness_reason_code IS NOT NULL AND billing_readiness_set_by_id IS NOT NULL)
    );

-- Immutability trigger on billing_doc_ref — first trigger in this repo. A
-- doc_ref is a REFERENCE to a QuickBooks document; once created it must not
-- silently change under a lineage that's supposed to be auditable. Only
-- superseded_by_id (revision chain), qb_txn_id (filled in once QB assigns
-- one) and invoice_date (mirrored from QB once known) may ever be updated.
-- Everything else — doc_type, doc_number, revision, supersedes_id,
-- created_at — is fixed at INSERT time.
CREATE FUNCTION billing_doc_ref_enforce_immutability() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.doc_type IS DISTINCT FROM OLD.doc_type
        OR NEW.doc_number IS DISTINCT FROM OLD.doc_number
        OR NEW.revision IS DISTINCT FROM OLD.revision
        OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'billing_doc_ref is immutable except superseded_by_id, qb_txn_id, invoice_date (row id=%)', OLD.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_doc_ref_immutability
    BEFORE UPDATE ON "billing_doc_ref"
    FOR EACH ROW
    EXECUTE FUNCTION billing_doc_ref_enforce_immutability();

-- Reason-code vocabulary — provisional list from the handoff (§2.6), pending
-- OPEN-B6 (real OpenInvoice rejection reason list, from the portal). Editable
-- afterwards without a migration — same idiom as
-- 20260709170100_seed_training_role_mappings (ON CONFLICT DO NOTHING).
INSERT INTO "billing_reason_code" ("id", "code", "phase", "label", "sort_order", "updated_at")
VALUES
  (gen_random_uuid(), 'missing_afe',            'pre_acceptance',  'Missing AFE',                1,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'wrong_afe',              'pre_acceptance',  'Wrong AFE',                   2,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'missing_signed_ticket',  'pre_acceptance',  'Missing signed ticket',       3,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'price_book_mismatch',    'pre_acceptance',  'Price book mismatch',         4,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'wrong_cost_center',      'pre_acceptance',  'Wrong cost center',           5,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'duplicate_submission',   'pre_acceptance',  'Duplicate submission',        6,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'outside_msa_window',     'pre_acceptance',  'Outside MSA submission window', 7, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'wrong_entity',           'pre_acceptance',  'Wrong entity',                8,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'other',                  'pre_acceptance',  'Other (pre-acceptance)',      9,  CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'short_pay',              'post_acceptance', 'Short pay',                   10, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'scope_dispute',          'post_acceptance', 'Scope dispute',                11, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'rate_dispute',           'post_acceptance', 'Rate dispute',                 12, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'quantity_dispute',       'post_acceptance', 'Quantity dispute',             13, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'tax_dispute',            'post_acceptance', 'Tax dispute',                  14, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'other_post',             'post_acceptance', 'Other (post-acceptance)',      15, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
