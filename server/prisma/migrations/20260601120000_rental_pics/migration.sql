-- #1 PIC roster: persons-in-charge / forepersons on a rental job.
-- Additive, nullable JSONB. The agreement is the canonical roster; the
-- manned-trailer ticket edits write through here so a relieving tech inherits
-- the contact log. Shape: [{ id, name, phone, email?, addedAt, addedBy }].
ALTER TABLE "rental_agreements"
  ADD COLUMN "pics" JSONB;
