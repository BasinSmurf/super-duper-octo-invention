-- AlterTable
ALTER TABLE "air_system_inspections" ADD COLUMN     "replaced_cylinder_serial_new" TEXT,
ADD COLUMN     "replaced_cylinder_serial_old" TEXT,
ADD COLUMN     "replaced_mask_serial_new" TEXT,
ADD COLUMN     "replaced_mask_serial_old" TEXT,
ADD COLUMN     "replaced_regulator_serial_new" TEXT,
ADD COLUMN     "replaced_regulator_serial_old" TEXT;
