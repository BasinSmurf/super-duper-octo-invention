-- AlterTable
ALTER TABLE "shop_work_orders" ADD COLUMN     "pickup_notes" TEXT,
ADD COLUMN     "pickup_signature" TEXT,
ADD COLUMN     "pickup_signed_at" TIMESTAMP(3),
ADD COLUMN     "pickup_signed_by_name" TEXT;
