CREATE TABLE "document_number_counters" (
    "namespace" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL,
    CONSTRAINT "document_number_counters_pkey" PRIMARY KEY ("namespace"),
    CONSTRAINT "document_number_counters_nonnegative" CHECK ("last_value" >= 0)
);
