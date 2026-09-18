-- Sundog-assigned equipment serials: BSU-<KIND>-<6-digit seq>, minted when the
-- field-entered serial isn't usable as an identity (blank, placeholder, or a
-- description like "SCBA 19"). Mirrors fit_test_student_no_seq: minted once and
-- persisted on the row, so every later BlueLion push and label reprint carries
-- the same tag.
CREATE SEQUENCE IF NOT EXISTS equipment_assigned_serial_seq START 1;
