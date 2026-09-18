-- Enable fuzzy text search extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- This migration enables the pg_trgm extension needed for
-- fuzzy text search on operator names, well names, and company names.
-- Additional indexes using gin_trgm_ops are created in a subsequent migration
-- after Prisma creates the tables.
