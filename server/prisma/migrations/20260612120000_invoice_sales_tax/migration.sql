-- Per-item ND sales tax on all invoices.
-- Adds a destination-based jurisdiction rate table (seeded from the QB
-- SalesTaxItem export that previously lived only in the client), a tax
-- jurisdiction + rate snapshot on invoices, and a customer-level exemption flag.

-- Invoice: jurisdiction reference + frozen rate snapshot
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tax_jurisdiction_id" TEXT;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tax_rate" DECIMAL(6,5) NOT NULL DEFAULT 0;

-- Company: ND sales-tax exemption (resale / direct-pay / government cert)
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "tax_exempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "tax_exempt_cert_number" TEXT;

-- Jurisdiction rate table
CREATE TABLE IF NOT EXISTS "sales_tax_rates" (
  "id"                TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "rate"              DECIMAL(6,5) NOT NULL,
  "county"            TEXT,
  "is_county_default" BOOLEAN NOT NULL DEFAULT false,
  "qb_tax_item_name"  TEXT,
  "active"            BOOLEAN NOT NULL DEFAULT true,
  "sort_order"        INTEGER NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sales_tax_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "sales_tax_rates_county_is_county_default_idx"
  ON "sales_tax_rates" ("county", "is_county_default");

-- Seed jurisdictions (combined state+county+city rates, mirrors the former
-- client constant). qb_tax_item_name defaults to the label and should be
-- reconciled against the real QuickBooks Sales Tax Item names by an admin.
INSERT INTO "sales_tax_rates" ("id","name","rate","county","is_county_default","qb_tax_item_name","sort_order") VALUES
  ('no_tax',           'No Tax',                       0,       NULL,            false, 'No Tax',                        0),
  ('nd_state',         'ND State Only (5%)',           0.05,    NULL,            false, 'ND State Only (5%)',            1),
  ('williston',        'Williston (8%)',               0.08,    'Williams',      false, 'Williston (8%)',                2),
  ('watford_city',     'Watford City / McKenzie (5%)', 0.05,    'McKenzie',      true,  'Watford City / McKenzie (5%)',  3),
  ('dickinson',        'Dickinson (6.5%)',             0.065,   'Stark',         false, 'Dickinson (6.5%)',              4),
  ('minot',            'Minot / Ward (5.5%)',          0.055,   'Ward',          true,  'Minot / Ward (5.5%)',           5),
  ('williams_co',      'Williams County (6%)',         0.06,    'Williams',      true,  'Williams County (6%)',          6),
  ('mandan',           'Mandan (7.25%)',               0.0725,  'Morton',        false, 'Mandan (7.25%)',                7),
  ('morton_co',        'Morton County (5.5%)',         0.055,   'Morton',        true,  'Morton County (5.5%)',          8),
  ('stark_co',         'Stark County (5%)',            0.05,    'Stark',         true,  'Stark County (5%)',             9),
  ('billings_co',      'Billings County (5%)',         0.05,    'Billings',      true,  'Billings County (5%)',         10),
  ('burke_co',         'Burke County (5%)',            0.05,    'Burke',         true,  'Burke County (5%)',            11),
  ('divide_co',        'Divide County (5%)',           0.05,    'Divide',        true,  'Divide County (5%)',           12),
  ('dunn_co',          'Dunn County (5%)',             0.05,    'Dunn',          true,  'Dunn County (5%)',             13),
  ('mountrail_co',     'Mountrail County (5%)',        0.05,    'Mountrail',     true,  'Mountrail County (5%)',        14),
  ('golden_valley_co', 'Golden Valley County (5%)',    0.05,    'Golden Valley', true,  'Golden Valley County (5%)',    15),
  ('mt_exempt',        'Montana (Exempt)',             0,       NULL,            false, 'Montana (Exempt)',             16)
ON CONFLICT ("id") DO NOTHING;
