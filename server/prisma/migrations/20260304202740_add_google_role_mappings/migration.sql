-- DropIndex
DROP INDEX "serialized_equipment_parent_id_idx";

-- DropIndex
DROP INDEX "service_tickets_linked_rental_id_idx";

-- AlterTable
ALTER TABLE "customer_billing_profiles" ADD COLUMN     "default_ordered_by_name" TEXT;

-- CreateTable
CREATE TABLE "google_role_mappings" (
    "id" TEXT NOT NULL,
    "google_group_email" TEXT NOT NULL,
    "sundog_role" "UserRole" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_role_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_role_mappings_google_group_email_key" ON "google_role_mappings"("google_group_email");
