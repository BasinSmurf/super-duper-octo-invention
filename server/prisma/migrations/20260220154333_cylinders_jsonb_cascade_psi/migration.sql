/*
  Warnings:

  - You are about to drop the column `replaced_cylinder_serial_new` on the `air_system_inspections` table. All the data in the column will be lost.
  - You are about to drop the column `replaced_cylinder_serial_old` on the `air_system_inspections` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "air_system_inspections" DROP COLUMN "replaced_cylinder_serial_new",
DROP COLUMN "replaced_cylinder_serial_old",
ADD COLUMN     "cascade_arrival_psi" INTEGER,
ADD COLUMN     "cascade_departure_psi" INTEGER,
ADD COLUMN     "cylinders" JSONB;
