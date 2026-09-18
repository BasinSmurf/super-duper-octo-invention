#!/usr/bin/env bash
#
# Sundog restore from S3 backup.
#
# DOES NOT TOUCH PROD by default — restores into a fresh container so you can
# verify the dump opens cleanly. Point it at the prod container only if you've
# made peace with overwriting prod data.
#
# Usage:
#   restore-prod.sh <s3-key>                    # restore into a throwaway container
#   restore-prod.sh <s3-key> servicepro-postgres  # restore into prod (DESTRUCTIVE)
#
# Examples:
#   restore-prod.sh s3://sundog-backups/prod/daily/2026-05-04/pg-20260504T023012Z.sql.gz
#
# If the object is in Glacier Instant Retrieval it restores normally. If it's
# in Deep Archive you have to thaw it first via the AWS console or:
#   aws s3api restore-object --bucket BUCKET --key KEY \
#     --restore-request '{"Days":2,"GlacierJobParameters":{"Tier":"Standard"}}'
# and wait 12 hours, then retry this script.

set -euo pipefail

S3_KEY="${1:?usage: $0 <s3-key> [target-container]}"
TARGET="${2:-sundog-restore-test}"
PG_USER="${PG_USER:-servicepro}"
PG_DB="${PG_DB:-servicepro}"
PG_PASSWORD="${PG_PASSWORD:-restore-test-only}"
TMP_DIR="${TMP_DIR:-/tmp/sundog-restore}"

mkdir -p "$TMP_DIR"
LOCAL_FILE="$TMP_DIR/$(basename "$S3_KEY")"

echo "→ Downloading $S3_KEY"
aws s3 cp --no-progress "$S3_KEY" "$LOCAL_FILE"

# If the target container doesn't exist, spin up a throwaway postgres for the test.
if [ "$TARGET" = "sundog-restore-test" ] \
   && ! sudo docker ps -a --format '{{.Names}}' | grep -q "^${TARGET}$"; then
  echo "→ No existing $TARGET — starting throwaway postgres on port 55432"
  sudo docker run -d \
    --name "$TARGET" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB="$PG_DB" \
    -p 55432:5432 \
    postgres:16-alpine

  # Wait for it to accept connections.
  for i in $(seq 1 30); do
    if sudo docker exec "$TARGET" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

echo "→ Restoring $(basename "$LOCAL_FILE") into $TARGET (db: $PG_DB)…"
gunzip -c "$LOCAL_FILE" \
  | sudo docker exec -i "$TARGET" psql -U "$PG_USER" -d "$PG_DB" >/dev/null

echo "→ Verifying — counting key tables:"
sudo docker exec "$TARGET" psql -U "$PG_USER" -d "$PG_DB" -c "
  SELECT 'service_tickets'  AS table, count(*) FROM service_tickets
  UNION ALL SELECT 'invoices',         count(*) FROM invoices
  UNION ALL SELECT 'companies',        count(*) FROM companies
  UNION ALL SELECT 'users',            count(*) FROM users
  UNION ALL SELECT 'pads',             count(*) FROM pads
  UNION ALL SELECT 'wells',            count(*) FROM wells;"

if [ "$TARGET" = "sundog-restore-test" ]; then
  echo
  echo "Throwaway container '$TARGET' is still running on port 55432 for inspection."
  echo "When done: sudo docker rm -f $TARGET"
fi
