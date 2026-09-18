-- SerializedEquipment: parent/child self-relation for trailer build-outs
ALTER TABLE "serialized_equipment" ADD COLUMN "parent_equipment_id" TEXT;
ALTER TABLE "serialized_equipment" ADD CONSTRAINT "serialized_equipment_parent_equipment_id_fkey"
  FOREIGN KEY ("parent_equipment_id") REFERENCES "serialized_equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "serialized_equipment_parent_id_idx" ON "serialized_equipment"("parent_equipment_id");

-- ServiceTicket: link field service tickets to a rental agreement (cal visits, etc.)
ALTER TABLE "service_tickets" ADD COLUMN "linked_rental_agreement_id" TEXT;
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_linked_rental_agreement_id_fkey"
  FOREIGN KEY ("linked_rental_agreement_id") REFERENCES "rental_agreements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "service_tickets_linked_rental_id_idx" ON "service_tickets"("linked_rental_agreement_id");

-- Add 'air_fill' to ServiceSubtype enum
ALTER TYPE "ServiceSubtype" ADD VALUE 'air_fill';

-- Add 'service' to LineItemType enum
ALTER TYPE "LineItemType" ADD VALUE 'service';
