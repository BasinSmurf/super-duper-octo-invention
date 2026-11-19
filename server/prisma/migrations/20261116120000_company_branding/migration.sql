CREATE TABLE "branding_config" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "company_name" TEXT NOT NULL DEFAULT 'Basin Safety',
  "logo_key" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branding_config_pkey" PRIMARY KEY ("id")
);
