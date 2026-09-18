-- Rentals: store ALL selected wells (the picker is multi-select). The card
-- surfaces the individual wells, not the field. wellId stays as the primary/
-- legacy well (= well_ids[0]) for QB/PDF consumers.
ALTER TABLE "rental_agreements" ADD COLUMN "well_ids" JSONB NOT NULL DEFAULT '[]';
