-- ClassPRO wave 2: Tier-A training locations + trainer availability.
-- cp_ namespace (bounded module). Locations reference the shared companies
-- table (client sites); trainers reference the shared users table — neither
-- is a copy. Trainer "currently available" is derived server-side, never
-- stored; cp_trainer_unavailability holds only explicit per-date outages.

CREATE TABLE "cp_locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'client',
    "company_id" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "drive_time_from_shop_min" INTEGER,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cp_locations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cp_locations_company_id_idx" ON "cp_locations"("company_id");

ALTER TABLE "cp_locations" ADD CONSTRAINT "cp_locations_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "cp_trainers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cp_trainers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cp_trainers_user_id_key" ON "cp_trainers"("user_id");

ALTER TABLE "cp_trainers" ADD CONSTRAINT "cp_trainers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cp_trainer_unavailability" (
    "id" TEXT NOT NULL,
    "trainer_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cp_trainer_unavailability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cp_trainer_unavailability_trainer_id_date_key"
    ON "cp_trainer_unavailability"("trainer_id", "date");

ALTER TABLE "cp_trainer_unavailability" ADD CONSTRAINT "cp_trainer_unavailability_trainer_id_fkey"
    FOREIGN KEY ("trainer_id") REFERENCES "cp_trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
